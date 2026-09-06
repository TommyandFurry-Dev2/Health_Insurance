import axios from 'axios';
import config, { missingItgiVariables } from '../config/env.js';
import { forAudit } from '../utils/sanitize.js';
import { traceBlock, buildExchange } from './genericApi.service.js';
import { ITGI_OPERATIONS } from '../constants/itgi.constants.js';
import {
  itgiError,
  prepareRequest,
  fillMedicalQuestionText,
  extractPremium,
  extractProposal,
  extractPolicyDownload,
} from '../helpers/itgi.helper.js';
import {
  validatePremium,
  validateProposal,
  validatePaymentConfirmation,
  validatePolicyDownload,
} from '../helpers/itgiValidation.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transport for the IFFCO Tokio partner-services API.
//
// One credential (HTTP Basic), one base URL, one JSON content type for every
// operation — so unlike NivaBupa there is no token service, nothing to cache
// and nothing to refresh.
//
// traceBlock and buildExchange are IMPORTED from genericApi.service.js rather
// than reimplemented: "show me exactly what went out beside what came back" is
// the same need here, and two copies of that format would drift. This service
// talks to a different host with a different credential and shares nothing else
// with the NivaBupa path — importing those two pure functions changes nothing
// about NivaBupa's behaviour.
//
// Every environment-dependent value is read from config.itgi, which reads the
// environment and has no bundled host, credential or partner code. A process
// that was never given them cannot reach ITGI: assertConfigured() throws a 503
// naming the missing variables, which is the failure an operator can act on.
// ─────────────────────────────────────────────────────────────────────────────

// Retried only on a transport failure or a gateway-level 5xx. Deliberately NOT
// on a 4xx and never on a 200 carrying a validation error[] — those are
// deterministic, and replaying one only repeats the rejection.
//
// Nor on the proposal: see submitProposal.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
]);

const RETRY_BASE_DELAY_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The four variables without which no call can be made. Checked per call rather
 * than at boot so an ITGI-less deployment still starts and serves NivaBupa —
 * only the /iffcotokio endpoints answer 503.
 */
function assertConfigured() {
  const missing = missingItgiVariables();
  if (missing.length > 0) {
    throw itgiError(
      `IFFCO Tokio is not configured. Set ${missing.join(', ')} in the environment.`,
      { status: 503, code: 'ITGI_CONFIG_ERROR', details: { missing } }
    );
  }
}

/** `${baseUrl}${path}` for a named operation. The only place a URL is built. */
function endpointFor(operation) {
  const path = config.itgi.paths[operation];
  if (!path) {
    throw itgiError(`Unknown ITGI operation "${operation}"`, {
      status: 500, code: 'ITGI_CONFIG_ERROR',
    });
  }
  return `${config.itgi.baseUrl}${path}`;
}

/**
 * HTTP Basic, built per call rather than cached: it is two config values and a
 * base64 encode, and caching it would only create a second place for a rotated
 * credential to go stale.
 */
function authorizationHeader() {
  const credential = `${config.itgi.username}:${config.itgi.password}`;
  return `Basic ${Buffer.from(credential, 'utf8').toString('base64')}`;
}

function isRetryable(error) {
  if (RETRYABLE_CODES.has(error?.code)) return true;
  return RETRYABLE_STATUSES.has(error?.response?.status);
}

/**
 * ITGI report a failure in FOUR different places, and three of them arrive with
 * HTTP 200. Missing any one of them turns a refusal into "a success whose
 * fields happen to be missing", which is exactly how it presented before each
 * was found:
 *
 *   1. the HTTP status                     — transport/auth failures only
 *   2. `error[]`   (health endpoints)      — {errorField, errorMessage}
 *   3. `errors[]`  (CKYC endpoints)        — {objectName, field, message},
 *                                            note the PLURAL and the different
 *                                            shape
 *   4. the BODY's `status` (CKYC)          — a rejection is HTTP 200 carrying
 *                                            "status": "400"
 *
 * Verified against UAT 2026-08-22: a blank PAN number answers
 * {"status":"400","errors":[{"field":"kycDocuments","message":"[PAN NUMBER IS INVALID. ]"}]}
 * with an HTTP 200.
 */
function assertUpstreamOk(operation, data, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) {
    throw itgiError(
      `ITGI ${operation} unauthorized (HTTP ${httpStatus}) — check ITGI_USERNAME / ITGI_PASSWORD, `
      + "and whether this server's public IP is whitelisted with ITGI.",
      { status: 502, code: 'ITGI_AUTH_ERROR', details: { httpStatus } }
    );
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    throw itgiError(`ITGI ${operation} returned HTTP ${httpStatus}`, {
      status: 502, code: 'ITGI_UPSTREAM_ERROR', details: { httpStatus, body: data ?? null },
    });
  }
  if (data === undefined || data === null || data === '') {
    throw itgiError(`ITGI ${operation} returned an empty body`, {
      status: 502, code: 'ITGI_PARSE_ERROR', details: { httpStatus },
    });
  }
  if (typeof data !== 'object') return;

  // (2) health validation failures
  if (Array.isArray(data.error) && data.error.length > 0) {
    const named = data.error
      .map((entry) => [entry.errorField, entry.errorMessage].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    throw itgiError(
      `ITGI ${operation} rejected the request${named ? `: ${named}` : ''}`,
      { status: 502, code: 'ITGI_UPSTREAM_ERROR', details: { errors: data.error } }
    );
  }

  // (3) CKYC validation failures
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const named = data.errors
      .map((entry) => [entry.field, entry.message].filter(Boolean).join(': '))
      .filter(Boolean)
      .join('; ');
    throw itgiError(
      `ITGI ${operation} rejected the request${named ? `: ${named}` : ''}`,
      {
        status: 502,
        code: 'ITGI_UPSTREAM_ERROR',
        details: { bodyStatus: data.status ?? null, errors: data.errors },
      }
    );
  }

  // (4) CKYC body status
  const bodyStatus = Number(data.status);
  if (Number.isFinite(bodyStatus) && bodyStatus >= 400) {
    throw itgiError(`ITGI ${operation} returned status ${data.status}`, {
      status: 502, code: 'ITGI_UPSTREAM_ERROR', details: { bodyStatus: data.status, body: data },
    });
  }
}

/**
 * One ITGI call.
 *
 * Resolves { data, exchange } — never the bare body — because every ITGI
 * controller returns the exchange beside the answer, the same way the NivaBupa
 * ones do. That is not decoration here: ITGI's rejections routinely name a
 * field that is correct (see the policy-download contractType trap), so the
 * payload that produced one is the only thing that makes it diagnosable, and
 * reading it in the browser's Network tab beats shell access to a log.
 *
 * `trace` prints the full exchange regardless of the debug flag.
 */
async function callItgi(operation, body, { trace = null, timeout = null, maxRetries = null } = {}) {
  assertConfigured();

  const url = endpointFor(operation);
  const headers = {
    'Authorization': authorizationHeader(),
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
  const attemptsAllowed = (maxRetries ?? config.itgi.maxRetries) + 1;

  if (trace) {
    // Before the request goes out, so the payload survives in the log even if
    // the call then hangs, times out, or the process dies mid-flight.
    traceBlock({ label: `${trace} — REQUEST`, url, headers, body });
  } else if (config.itgi.debug) {
    console.log('\n────────── ITGI request ──────────');
    console.log('Operation     :', operation);
    console.log('URL           :', url);
    console.log('Content-Length:', Buffer.byteLength(JSON.stringify(body ?? '')));
    console.log('Payload       :', JSON.stringify(forAudit(body), null, 2));
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.post(url, body ?? {}, {
        headers,
        timeout: timeout ?? config.timeouts.itgi,
        // Read the body ourselves: three of ITGI's four failure modes arrive
        // with HTTP 200 and one arrives as a 400 whose body names the field, so
        // an axios throw on status would discard the only useful part.
        validateStatus: () => true,
      });

      // Some ITGI hosts answer with a JSON string body rather than a JSON
      // content type; parse it so downstream sees an object either way.
      const data = typeof response.data === 'string' ? safeJson(response.data) ?? response.data : response.data;
      const exchange = buildExchange({ url, headers, body, attempt, response });

      if (trace) {
        traceBlock({ label: trace, url, headers, body, response });
      } else if (config.itgi.debug) {
        console.log('────────── ITGI response ─────────');
        console.log('Status :', response.status);
        console.log('Attempt:', attempt + 1);
        console.log('Body   :', JSON.stringify(forAudit(data), null, 2));
        console.log('──────────────────────────────────\n');
      }

      // A gateway-level 5xx is retried HERE, before classification, and this
      // placement is load-bearing: `validateStatus: () => true` above means
      // axios does not throw for any status, so a 502/503/504 never reaches the
      // catch block and the retry logic there can only ever see a transport
      // failure. Without this, RETRYABLE_STATUSES would be dead code and a
      // one-off gateway blip on a pure read would fail the buyer's quote.
      //
      // Only when the operation allows it: submitProposal, confirmPayment and
      // createCkyc pass maxRetries 0, so a 503 on any of them stops here with
      // its outcome unknown rather than being replayed into a duplicate.
      if (RETRYABLE_STATUSES.has(response.status) && attempt < attemptsAllowed - 1) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `⚠️  ITGI ${operation} answered HTTP ${response.status} — `
          + `retrying in ${delay}ms [attempt ${attempt + 2}/${attemptsAllowed}]`
        );
        await sleep(delay);
        continue;
      }

      // Throws for every one of the four failure shapes, with the exchange
      // attached so the controller can return the payload that caused it.
      try {
        assertUpstreamOk(operation, data, response.status);
      } catch (rejection) {
        rejection.exchange = exchange;
        throw rejection;
      }

      return { data, exchange, httpStatus: response.status };
    } catch (error) {
      // An upstream rejection this function raised itself — already classified,
      // never retryable, and its exchange is attached. Nothing to add.
      if (error.provider === 'itgi') throw error;

      const canRetry = isRetryable(error) && attempt < attemptsAllowed - 1;

      if (trace) {
        traceBlock({ label: `${trace} — FAILED (attempt ${attempt + 1})`, url, headers, body, error });
      }

      if (canRetry) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `⚠️  ITGI ${operation} failed (${error.code || error.response?.status}) — `
          + `retrying in ${delay}ms [attempt ${attempt + 2}/${attemptsAllowed}]`
        );
        await sleep(delay);
        continue;
      }

      // Logged in full whether or not debug is on — the reason a call failed
      // lives in error.response.data, not error.message.
      console.error('────────── ITGI call FAILED ──────');
      console.error('operation    :', operation);
      console.error('URL          :', url);
      console.error('attempts     :', attempt + 1);
      console.error('error.message:', error.message);
      console.error('error.code   :', error.code);
      console.error('status       :', error.response?.status);
      console.error('resp data    :', JSON.stringify(forAudit(error.response?.data ?? null), null, 2));
      console.error('──────────────────────────────────');

      const wrapped = itgiError(
        error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
          ? `ITGI ${operation} timed out after ${timeout ?? config.timeouts.itgi}ms`
          : `ITGI ${operation} failed: ${error.message}`,
        {
          status: error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT' ? 504 : 502,
          code: error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT'
            ? 'ITGI_TIMEOUT_ERROR'
            : 'ITGI_UPSTREAM_ERROR',
          details: { errorCode: error.code || null, httpStatus: error.response?.status ?? null },
        }
      );
      wrapped.cause = error;
      wrapped.response = error.response;
      wrapped.exchange = buildExchange({ url, headers, body, attempt, error });
      throw wrapped;
    }
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Operations ──────────────────────────────────────────────────────────────
//
// Each one asserts the configuration, prepares (contractType + partnerCode),
// validates locally, calls, and normalises. The caller sends ITGI's own
// documented request shape — nothing here invents or rewrites a buyer's data.
//
// assertConfigured() runs FIRST, before validation, even though callItgi() also
// checks. Without it, an unconfigured deployment answers the first missing
// value it happens to trip over — "partnerDetail.partnerCode is required", a
// 400 that reads as a bad request from the caller — instead of the 503 naming
// all four variables, which is the answer an operator can act on. The check
// inside callItgi stays as the backstop for any future path that reaches it
// another way.

/**
 * Premium. Pure read: safe to retry, and the only ITGI call that is.
 * `contractType` FHP (floater SI on health) or IHP (SI per member).
 */
async function getPremium(input) {
  assertConfigured();
  const body = prepareRequest(input);
  validatePremium(body);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.PREMIUM, body);
  return { data: extractPremium(data), request: body, exchange, httpStatus };
}

/**
 * Proposal → orderNo + the hosted payment URL.
 *
 * Deliberately NOT retried, on anything, including a timeout: premium is a pure
 * read so replaying it is free, but this creates a proposal at ITGI. A timeout
 * means the outcome is UNKNOWN, not that it failed — a blind replay is how one
 * buyer becomes two proposals and two payment links. Re-quote and re-propose
 * with a fresh uniqueReferenceNo instead.
 *
 * Traced unconditionally: this is the payload that has to be compared field by
 * field against the kit whenever ITGI reject it, and it runs once per policy,
 * not per keystroke.
 */
async function submitProposal(input) {
  assertConfigured();
  // fillMedicalQuestionText BEFORE validation: it supplies the question text
  // ITGI dereference, and validation should judge what will actually be sent.
  const body = fillMedicalQuestionText(prepareRequest(input));
  validateProposal(body);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.PROPOSAL, body, {
    trace: 'ITGI PROPOSAL API',
    maxRetries: 0,
  });
  return { data: extractProposal(data), request: body, exchange, httpStatus };
}

/**
 * Payment confirmation — issues the policy when payment was collected at OUR
 * end rather than on ITGI's hosted page.
 *
 * ⚠️ Switched off for our partner code: with every mandatory field supplied,
 * ITGI answer `partnerDetails: "Payment at partner end is not allowed for this
 * product."` (verified on staging 2026-08-21 for ITGIHLT073, contract FHP). It
 * is a product/partner entitlement, not a payload fault. Implemented so the
 * flow is complete the day ITGI enable it; until then the hosted gateway and
 * its redirect are the only route to a policy.
 *
 * Not retried, for the same reason as the proposal: it moves money into a
 * policy.
 */
async function confirmPayment(input) {
  assertConfigured();
  const body = prepareRequest(input);
  validatePaymentConfirmation(body);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.PAYMENT_CONFIRMATION, body, {
    trace: 'ITGI PAYMENT CONFIRMATION API',
    maxRetries: 0,
  });
  return {
    data: { statusMessage: data?.statusMessage ?? null, raw: data },
    request: body,
    exchange,
    httpStatus,
  };
}

/**
 * Policy download → a link to ITGI's document service.
 *
 * Takes the POLICY number as `policyDownloadNo`, never the orderNo — the
 * controller defaults one from the other only for the common case immediately
 * after issuance.
 */
async function downloadPolicy(input) {
  assertConfigured();
  const body = prepareRequest(input);
  validatePolicyDownload(body);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.POLICY_DOWNLOAD, body);
  return { data: extractPolicyDownload(data), request: body, exchange, httpStatus };
}

export {
  callItgi,
  assertConfigured,
  endpointFor,
  getPremium,
  submitProposal,
  confirmPayment,
  downloadPolicy,
};
