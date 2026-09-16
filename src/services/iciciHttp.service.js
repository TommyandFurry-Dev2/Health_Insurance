import axios from 'axios';

import config from '../config/env.js';
import { forAudit } from '../utils/sanitize.js';
import { timeoutError, upstreamError } from '../helpers/icici.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The one HTTP primitive every ICICI Lombard call goes through — the token call
// and every business call alike.
//
// A port of the working implementation's core/httpClient.js, with its retry and
// timeout semantics kept exactly:
//
//   * per-attempt timeout             config.timeouts.icici (EL_API_TIMEOUT_MS)
//   * retried                         network/timeout failures, and HTTP
//                                     502/503/504 — nothing else
//   * backoff                         EL_RETRY_BASE_DELAY_MS × 2^(attempt-1)
//   * never throws on an HTTP status  the caller classifies 4xx / 5xx / 401
//                                     itself; only an EXHAUSTED 502/503/504 is
//                                     raised here, as UPSTREAM_ERROR
//
// ⚠️ The working implementation applied those retries to EVERY Elevate call,
// proposal-payment and policy sync included, and that is preserved rather than
// silently changed — see docs/icici-lombard.md ("Retries") for why it deserves
// a deliberate decision rather than a quiet one.
//
// Logging follows the other insurers: one line per request and per response
// always (operation, method, URL, attempt, the ICICI TransactionId/RequestId
// when the caller named them, status, duration), the full body only under
// EL_DEBUG=1, and a failure block regardless. The Authorization header, the
// token and the login body are never printed.
// ─────────────────────────────────────────────────────────────────────────────

const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
function nextCorrelationId() {
  seq = (seq + 1) % 1e6;
  return `icici-${Date.now().toString(36)}-${seq}`;
}

function isRetryable(error) {
  if (!error) return false;
  if (RETRYABLE_CODES.has(error.code)) return true;
  return Boolean(error.response && RETRYABLE_STATUSES.has(error.response.status));
}

// " transactionId=bnc_… requestId=…" — the identifiers support will be asked
// for, on the line that shows the call going out.
function describeContext(context) {
  if (!context) return '';
  return Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => ` ${key}=${value}`)
    .join('');
}

function isMultipart(data) {
  return Boolean(data && typeof data === 'object' && typeof data.getHeaders === 'function');
}

function debugBody(data) {
  if (data === undefined || data === null) return String(data);
  if (Buffer.isBuffer(data)) return `[binary ${data.length} bytes]`;
  if (isMultipart(data)) return '[multipart form-data — file parts not printed]';
  return JSON.stringify(forAudit(data), null, 2);
}

/**
 * Perform one ICICI HTTP request with retry/timeout handling and logging.
 *
 * @param {object}  p
 * @param {string}  p.opName        operation name, for logs and error messages
 * @param {string}  p.method
 * @param {string}  p.url
 * @param {object}  [p.headers]
 * @param {*}       [p.data]
 * @param {number}  [p.maxRetries]  default config.icici.maxRetries
 * @param {number}  [p.timeoutMs]   default config.timeouts.icici
 * @param {string}  [p.responseType]
 * @param {object}  [p.context]     identifiers to print on the request line
 * @param {boolean} [p.logBody]     false for the token call — its body is the
 *                                  login and the password, never printed
 * @returns {Promise<import('axios').AxiosResponse & { correlationId: string, attempts: number }>}
 */
async function requestIcici({
  opName = 'call',
  method,
  url,
  headers,
  data,
  maxRetries = config.icici.maxRetries,
  timeoutMs = config.timeouts.icici,
  responseType,
  context = null,
  logBody = true,
}) {
  const correlationId = nextCorrelationId();
  const attemptsAllowed = maxRetries + 1;
  const ids = describeContext(context);
  let lastError;
  let lastResponse = null;
  let attempt = 1;

  for (; attempt <= attemptsAllowed; attempt += 1) {
    const startedAt = Date.now();
    try {
      console.log(`[icici] ${opName} → ${method} ${url} [attempt ${attempt}/${attemptsAllowed}]${ids} (${correlationId})`);
      if (config.icici.debug && logBody && method !== 'GET') {
        console.log(`[icici] ${opName} request body:\n${debugBody(data)}`);
      }

      const response = await axios({
        method,
        url,
        headers,
        data,
        timeout: timeoutMs,
        // Never auto-throw: the status is inspected by the caller, so a 401 can
        // refresh the token and a 4xx body can still be read for its reason.
        validateStatus: () => true,
        ...(responseType ? { responseType } : {}),
      });

      const durationMs = Date.now() - startedAt;
      console.log(`[icici] ${opName} ← HTTP ${response.status} in ${durationMs}ms [attempt ${attempt}/${attemptsAllowed}] (${correlationId})`);
      if (config.icici.debug && logBody) {
        console.log(`[icici] ${opName} response body:\n${debugBody(response.data)}`);
      }

      // Retry pure 502/503/504 transport answers; return everything else.
      if (RETRYABLE_STATUSES.has(response.status)) {
        lastResponse = response;
        lastError = upstreamError(`Upstream returned ${response.status}`, {
          details: { status: response.status },
        });
        if (attempt < attemptsAllowed) {
          await backoff(attempt, `answered HTTP ${response.status}`);
          continue;
        }
        break; // exhausted retries on a 5xx → thrown below
      }

      response.correlationId = correlationId;
      response.attempts = attempt;
      return response;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      lastError = error;
      console.warn(
        `⚠️  [icici] ${opName} transport error after ${durationMs}ms [attempt ${attempt}/${attemptsAllowed}]: `
        + `${error.code || ''} ${error.message}`.trim()
      );

      if (isRetryable(error) && attempt < attemptsAllowed) {
        await backoff(attempt, `failed (${error.code || 'transport error'})`);
        continue;
      }
      break;
    }
  }

  const attempts = Math.min(attempt, attemptsAllowed);

  // Logged in full whether or not debug is on — this is the line that says a
  // call was given up on, and why.
  console.error('────────── ICICI call FAILED ─────');
  console.error('operation    :', opName);
  console.error('URL          :', url);
  console.error('attempts     :', attempts);
  console.error('error.message:', lastError?.message);
  console.error('error.code   :', lastError?.code);
  console.error('status       :', lastResponse?.status ?? lastError?.response?.status ?? null);
  console.error('──────────────────────────────────');

  // Classified exactly as the working implementation classified it.
  let failure;
  if (lastError && (lastError.code === 'ECONNABORTED' || lastError.code === 'ETIMEDOUT')) {
    failure = timeoutError(`[elevate] ${opName} timed out after ${timeoutMs}ms`, { cause: lastError });
  } else if (lastError?.icici) {
    failure = lastError;
  } else {
    failure = upstreamError(`[elevate] ${opName} failed: ${lastError?.message || 'unknown error'}`, {
      details: { errorCode: lastError?.code },
      cause: lastError,
    });
  }
  failure.attempts = attempts;
  failure.response = lastResponse ?? lastError?.response ?? null;
  throw failure;

  async function backoff(currentAttempt, reason) {
    const delay = config.icici.retryBaseDelayMs * 2 ** (currentAttempt - 1);
    console.warn(
      `⚠️  [icici] ${opName} ${reason} — retrying in ${delay}ms [attempt ${currentAttempt + 1}/${attemptsAllowed}]`
    );
    await sleep(delay);
  }
}

export { requestIcici, isMultipart };
