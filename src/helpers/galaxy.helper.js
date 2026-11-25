import { GALAXY_PROVIDER } from '../constants/galaxy.constants.js';
import config from '../config/env.js';
import { redact } from '../utils/sanitize.js';
import { maskPersonalData } from './galaxyMask.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health — the small pieces either side of the wire.
//
//   * galaxyError and the typed factories   — the failure this integration throws
//   * requireFields / isEmpty / getPath     — the payload guards
//   * extractQuoteSummary / extractOrder    — the responses, normalised
//   * withProducerCode                      — GX_PRODUCER_CODE on quickQuote
//   * envelope                              — the success envelope
//   * galaxyLog                             — logging with GHI's data masked
//
// All moved from the working implementation (src/core/*, src/providers/galaxy/
// parsers/*, gxAdapter.js) with their behaviour unchanged.
//
// ── Error codes are deliberately NOT prefixed ───────────────────────────────
// The working implementation answered VALIDATION_ERROR / CONFIG_ERROR /
// UPSTREAM_ERROR / TIMEOUT_ERROR / PARSE_ERROR / CRYPTO_ERROR with the HTTP
// statuses below, and the SPA's galaxyClient reads exactly that envelope — the
// same decision the ICICI and Chola migrations made.
// ─────────────────────────────────────────────────────────────────────────────

// The codebase's convention for a typed failure is an Error with extra
// properties rather than a class hierarchy (see chola.helper.js's cholaError).
//
//   status   — the HTTP status the controller answers with
//   code     — machine-readable, stable across message rewording
//   provider — 'galaxy', or null for a local validation failure (the working
//              implementation's ValidationError never carried a provider)
//   details  — anything the caller needs in order to act (masked: it reaches
//              the API caller)
//   galaxy   — marks an error this integration already classified
function galaxyError(message, {
  status = 502, code = 'UPSTREAM_ERROR', provider = GALAXY_PROVIDER, details = null, cause = null,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.provider = provider;
  error.details = details;
  error.galaxy = true;
  if (cause) error.cause = cause;
  return error;
}

/** Input failed local validation before any network call was made. 400. */
function validationError(message, details = null) {
  return galaxyError(message, { status: 400, code: 'VALIDATION_ERROR', provider: null, details });
}

/** GHI returned a technical or business failure (non-2xx, an error envelope, an exhausted 5xx). */
function upstreamError(message, { details = null, cause = null } = {}) {
  return galaxyError(message, { status: 502, code: 'UPSTREAM_ERROR', details, cause });
}

/** The request timed out. */
function timeoutError(message, { details = null, cause = null } = {}) {
  return galaxyError(message, { status: 504, code: 'TIMEOUT_ERROR', details, cause });
}

/** A response could not be verified, decrypted or read into the expected shape. */
function parseError(message, { details = null, cause = null } = {}) {
  return galaxyError(message, { status: 502, code: 'PARSE_ERROR', details, cause });
}

/**
 * Galaxy is not configured, today's GHI key is missing, or the ops routes are
 * off. 503, as in the working implementation.
 */
function configError(message, { details = null } = {}) {
  return galaxyError(message, { status: 503, code: 'CONFIG_ERROR', details });
}

/** Local encryption failed (a bad AES setting). 500, as in the working implementation. */
function cryptoError(message, { cause = null } = {}) {
  return galaxyError(message, { status: 500, code: 'CRYPTO_ERROR', cause });
}

/** The caller did not send a valid X-Ops-Key. 401. */
function unauthorizedError(message) {
  return galaxyError(message, { status: 401, code: 'UNAUTHORIZED', provider: null });
}

// ── Payload guards (the working implementation's core/validate.js) ──────────

function getPath(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function isEmpty(v) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Throws VALIDATION_ERROR naming every empty dot-path in `fields`. */
function requireFields(obj, fields, context = 'request') {
  const missing = fields.filter((path) => isEmpty(getPath(obj, path)));
  if (missing.length) {
    throw validationError(`Missing required field(s) for ${context}: ${missing.join(', ')}`, { context, missing });
  }
}

// ── Responses ───────────────────────────────────────────────────────────────

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

/**
 * The (large) quickQuote response as a compact premium summary. The full
 * decrypted response is kept beside it; this surfaces the headline numbers from
 * quotePremiumDetails.tenureOptions[].premiumOptions[].
 */
function extractQuoteSummary(data) {
  if (!data || typeof data !== 'object') return null;
  const qpd = data.quotePremiumDetails || {};
  const tenureOptions = Array.isArray(qpd.tenureOptions) ? qpd.tenureOptions : [];
  const options = [];
  for (const t of tenureOptions) {
    for (const po of (t.premiumOptions || [])) {
      options.push({
        policyTenure: t.policyTenure,
        frequency: po.frequency,
        basePremium: num(po.basePremium),
        discount: num(po.discount),
        premiumAfterDiscount: num(po.premiumAfterDiscount),
        loading: num(po.loading),
        premiumAfterLoading: num(po.premiumAfterLoading),
        tax: num(po.tax),
        premiumAfterTax: num(po.premiumAfterTax),
      });
    }
  }
  return {
    planCode: data.planCode || null,
    premiumFrequency: data.premiumFrequency || null,
    sourceName: data.sourceName || null,
    policyStatus: data.policyStatus || null,
    options,
  };
}

/** createOrder's decrypted payload, an array [{ returnUrl, orderId, expireDateTime }]. */
function extractOrder(data) {
  const first = Array.isArray(data) ? data[0] : data;
  if (!first || typeof first !== 'object') return { returnUrl: null, orderId: null, expireDateTime: null, raw: data };
  return {
    returnUrl: first.returnUrl || null,
    orderId: first.orderId || null,
    expireDateTime: first.expireDateTime || null,
    raw: data,
  };
}

/**
 * quickQuote's basicDetails.producerCode, from GX_PRODUCER_CODE when the caller
 * left it empty. A code the caller sent is kept. The input is not changed.
 */
function withProducerCode(payload, producerCode) {
  const basic = payload.basicDetails;
  if (isEmpty(producerCode) || !basic || typeof basic !== 'object' || Array.isArray(basic) || !isEmpty(basic.producerCode)) {
    return payload;
  }
  return { ...payload, basicDetails: { ...basic, producerCode } };
}

/** The success envelope, exactly as the working implementation answered. */
function envelope(operation, data, res) {
  return {
    ok: true,
    provider: GALAXY_PROVIDER,
    operation,
    data,
    meta: { requestUID: res?.requestUID, statusCode: res?.statusCode, statusDescription: res?.statusDescription },
  };
}

// ── Logging ─────────────────────────────────────────────────────────────────
// One line per event, the metadata passed through BOTH maskers: sanitize's
// redact (credentials) and galaxyMask (personal data, apiKey, checkSum, keys).
// debug lines print only under GX_DEBUG=1.
function line(message, meta) {
  if (meta === undefined) return `[galaxy] ${message}`;
  return `[galaxy] ${message} ${JSON.stringify(maskPersonalData(redact(meta)))}`;
}

const galaxyLog = {
  debug: (message, meta) => { if (config.galaxy.debug) console.log(line(message, meta)); },
  info: (message, meta) => console.log(line(message, meta)),
  warn: (message, meta) => console.warn(line(message, meta)),
  error: (message, meta) => console.error(line(message, meta)),
};

export {
  galaxyError,
  validationError,
  upstreamError,
  timeoutError,
  parseError,
  configError,
  cryptoError,
  unauthorizedError,
  getPath,
  isEmpty,
  requireFields,
  extractQuoteSummary,
  extractOrder,
  withProducerCode,
  envelope,
  galaxyLog,
};
