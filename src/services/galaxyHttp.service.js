import axios from 'axios';

import config from '../config/env.js';
import { galaxyLog as logger, timeoutError, upstreamError } from '../helpers/galaxy.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The one HTTP primitive every GHI call goes through. A port of the working
// implementation's core/httpClient.js, with its retry and timeout semantics
// kept exactly:
//
//   * per-attempt timeout             config.timeouts.galaxy (GX_API_TIMEOUT_MS)
//   * retried                         network/timeout failures, and HTTP
//                                     502/503/504 — nothing else
//   * backoff                         GX_RETRY_BASE_DELAY_MS × 2^(attempt-1)
//   * never throws on an HTTP status  the caller classifies it; only an
//                                     EXHAUSTED 502/503/504 is raised here
//   * maxRetries 0                    for the key fetches (3 a day, never retried)
//
// The error SHAPES are kept too, because the key scheduler's isTransient()
// branches on them: an exhausted 5xx carries details.status, a transport
// failure carries details.errorCode.
//
// Nothing about the request is logged but the method, the URL, the status and
// the timing: the headers carry the appKey, the wrapped apiKey and the checkSum.
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
function nextCorrelationId() {
  seq = (seq + 1) % 1e6;
  return `galaxy-${Date.now().toString(36)}-${seq}`;
}

function isRetryable(error) {
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return Boolean(error.response && RETRYABLE_STATUSES.has(error.response.status));
}

/**
 * @param {{ opName: string, method?: string, url: string, headers?: object, data?: any,
 *           timeoutMs?: number, maxRetries?: number }} options
 * @returns {Promise<import('axios').AxiosResponse>}
 */
export async function galaxyRequest({
  opName = 'call',
  timeoutMs = config.timeouts.galaxy,
  maxRetries = config.galaxy.maxRetries,
  ...axiosOptions
}) {
  const correlationId = nextCorrelationId();
  const attemptsAllowed = maxRetries + 1;
  let lastError;

  const backoff = async (attempt) => {
    const delay = config.galaxy.retryBaseDelayMs * 2 ** (attempt - 1);
    logger.debug(`${opName} retrying in ${delay}ms`, { correlationId, attempt });
    await sleep(delay);
  };

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    const startedAt = Date.now();
    try {
      logger.debug(`${opName} → request`, { correlationId, attempt, method: axiosOptions.method, url: axiosOptions.url });

      const response = await axios({
        timeout: timeoutMs,
        // Never auto-throw: the status is inspected by the caller.
        validateStatus: () => true,
        ...axiosOptions,
      });

      logger.info(`${opName} ← response`, { correlationId, attempt, status: response.status, durationMs: Date.now() - startedAt });

      if (RETRYABLE_STATUSES.has(response.status)) {
        lastError = upstreamError(`Upstream returned ${response.status}`, { details: { status: response.status } });
        if (attempt < attemptsAllowed) {
          await backoff(attempt);
          continue;
        }
        break; // exhausted retries on a 5xx → thrown below
      }

      response.correlationId = correlationId;
      return response;
    } catch (err) {
      lastError = err;
      logger.warn(`${opName} ✕ transport error`, {
        correlationId, attempt, durationMs: Date.now() - startedAt, errorCode: err.code, message: err.message,
      });
      if (isRetryable(err) && attempt < attemptsAllowed) {
        await backoff(attempt);
        continue;
      }
      break;
    }
  }

  // Exhausted retries — classify the failure.
  if (lastError && (lastError.code === 'ECONNABORTED' || lastError.code === 'ETIMEDOUT')) {
    throw timeoutError(`[galaxy] ${opName} timed out after ${timeoutMs}ms`, { cause: lastError });
  }
  if (lastError?.galaxy) throw lastError;
  throw upstreamError(`[galaxy] ${opName} failed: ${lastError?.message || 'unknown error'}`, {
    details: { errorCode: lastError?.code },
    cause: lastError,
  });
}
