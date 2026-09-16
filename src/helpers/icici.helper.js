import { ICICI_PROVIDER } from '../constants/icici.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard — the small set of pieces either side of the wire.
//
//   * iciciError and the five typed factories — the failure this integration
//     throws
//   * requireFields / isEmpty / getPath        — the payload guards
//   * extractPremium / extractProposal         — the two rich responses,
//                                                normalised
//   * envelope                                 — the success envelope
//
// Crypto lives next door in iciciCrypto.helper.js, for the same reason FG keeps
// fgPayment.helper.js apart from fg.helper.js.
//
// ── Error codes are deliberately NOT prefixed ───────────────────────────────
// ITGI and FG answer ITGI_UPSTREAM_ERROR / FG_UPSTREAM_ERROR. ICICI answers the
// working implementation's bare VALIDATION_ERROR / CONFIG_ERROR / AUTH_ERROR /
// TIMEOUT_ERROR / UPSTREAM_ERROR / PARSE_ERROR, with the same HTTP statuses it
// mapped them to, because the SPA's elevateClient.js maps exactly those codes
// to buyer-facing sentences and nothing else. Prefixing them here would turn
// every ICICI failure into the SPA's generic fallback line.
// ─────────────────────────────────────────────────────────────────────────────

// The codebase's convention for a typed failure is an Error with extra
// properties rather than a class hierarchy (see itgi.helper.js's itgiError).
//
//   status   — the HTTP status the controller answers with
//   code     — machine-readable, stable across message rewording
//   provider — echoed on the error envelope exactly as the working
//              implementation did: 'elevate', or null for a local validation
//              failure (its ValidationError never carried a provider)
//   details  — anything the caller needs in order to act
//   icici    — marks an error this integration already classified, so the
//              transport never re-wraps it
function iciciError(message, {
  status = 502, code = 'UPSTREAM_ERROR', provider = ICICI_PROVIDER, details = null, cause = null,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.provider = provider;
  error.details = details;
  error.icici = true;
  if (cause) error.cause = cause;
  return error;
}

/** Input failed local validation before any network call was made. 400. */
function validationError(message, details = null) {
  return iciciError(message, { status: 400, code: 'VALIDATION_ERROR', provider: null, details });
}

/** Token acquisition with ICICI failed — OUR credential, so a 502. */
function authError(message, { details = null, cause = null } = {}) {
  return iciciError(message, { status: 502, code: 'AUTH_ERROR', details, cause });
}

/** ICICI returned a business/technical failure (non-2xx or Success:false). */
function upstreamError(message, { details = null, cause = null } = {}) {
  return iciciError(message, { status: 502, code: 'UPSTREAM_ERROR', details, cause });
}

/** The request timed out. */
function timeoutError(message, { details = null, cause = null } = {}) {
  return iciciError(message, { status: 504, code: 'TIMEOUT_ERROR', details, cause });
}

/** A response could not be read into the expected shape. */
function parseError(message, { details = null, cause = null } = {}) {
  return iciciError(message, { status: 502, code: 'PARSE_ERROR', details, cause });
}

/** ICICI is not configured on this deployment. 503. */
function configError(message, { details = null } = {}) {
  return iciciError(message, { status: 503, code: 'CONFIG_ERROR', details });
}

// ── Payload guards ──────────────────────────────────────────────────────────
//
// The working implementation's core/validate.js, unchanged: enough to guard the
// required fields of an ICICI request without pulling in a schema library.

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Assert that every dot-notation path is present and non-empty.
 * @param {string[]} fields e.g. ['RequestId', 'Proposer.Name']
 */
function requireFields(obj, fields, context = 'request') {
  const missing = [];
  for (const path of fields) {
    if (isEmpty(getPath(obj, path))) missing.push(path);
  }
  if (missing.length) {
    throw validationError(
      `Missing required field(s) for ${context}: ${missing.join(', ')}`,
      { context, missing }
    );
  }
}

// ── Response readers ────────────────────────────────────────────────────────

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Normalise the Premium (quote) response into a compact summary. */
function extractPremium(data) {
  if (!data || typeof data !== 'object') return null;
  const prem = data.Premium || {};
  const loading = Array.isArray(prem.Loading) ? prem.Loading.map((l) => ({
    coverName: l.CoverName, coverPremium: num(l.CoverPremium),
  })) : [];
  const discount = Array.isArray(prem.Discount) ? prem.Discount.map((d) => ({
    discountName: d.DiscountName, discountAmount: num(d.DiscountAmount),
  })) : [];
  return {
    // ICICI's own TransactionId (bnc_…) — minted HERE, and the key every later
    // step of the journey (CKYC, proposal, status, COI) is threaded through.
    transactionId: data.TransactionId ?? null,
    basicPremium: num(data.BasicPremium),
    totalTax: num(data.TotalTax),
    totalPremium: num(data.TotalPremium),
    emiPremium: num(data.EmiPremium),
    cibilDiscount: num(data.CibilDiscount),
    zoneName: data.ZoneName ?? null,
    loading,
    discount,
    corelationId: data.CorelationId ?? null,
  };
}

/** Normalise the Proposal (proposal-payment) response. */
function extractProposal(data) {
  if (!data || typeof data !== 'object') return null;
  return {
    transactionId: data.TransactionId ?? null,
    proposalId: data.ProposalId ?? null,
    paymentUrl: data.PaymentUrl ?? null,
    requestId: data.RequestId ?? null,
    basicPremium: num(data.BasicPremium),
    gst: num(data.Gst),
    totalPremium: num(data.TotalPremium),
    emiAmount: num(data.EmiAmount),
    policyStartDate: data.PolicyStartDate ?? null,
    policyEndDate: data.PolicyEndDate ?? null,
    pfPolicyNo: data.PfPolicyNo != null ? String(data.PfPolicyNo) : null,
    basePfPolicyNo: data.BasePfPolicyNo != null ? String(data.BasePfPolicyNo) : null,
    status: data.Status ?? null,
    raw: data,
  };
}

/**
 * The success envelope every non-CKYC operation answers with — the working
 * implementation's _envelope(), byte for byte, because the SPA reads
 * `res.data.<field>` off exactly this shape.
 */
function envelope(operation, data, res) {
  return {
    ok: true,
    provider: ICICI_PROVIDER,
    operation,
    data,
    meta: { corelationId: data?.corelationId ?? res?.data?.CorelationId, httpStatus: res?.status },
  };
}

/**
 * Headers as they may be shown or stored: the Bearer token is reduced to its
 * length, never a fragment of it. The same treatment fg.helper.js gives FG's
 * credentials — kept as ICICI's own copy so neither integration can move the
 * other's.
 */
function safeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/authorization|token|client-id|secret|password|key/i.test(name)) {
      out[name] = value ? `***set (${String(value).length} chars)***` : null;
    } else {
      out[name] = value;
    }
  }
  return out;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function trunc(value) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s ? s.slice(0, 400) : s;
}

export {
  iciciError,
  validationError,
  authError,
  upstreamError,
  timeoutError,
  parseError,
  configError,
  getPath,
  isEmpty,
  requireFields,
  num,
  extractPremium,
  extractProposal,
  envelope,
  safeHeaders,
  safeJson,
  trunc,
};
