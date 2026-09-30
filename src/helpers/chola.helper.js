import { CHOLA_PROVIDER } from '../constants/chola.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS — the small set of pieces either side of the wire.
//
//   * cholaError and the typed factories      — the failure this integration
//                                                throws
//   * requireFields / isEmpty / getPath        — the payload guards
//   * extractPremium / extractProposal /
//     extractPolicy / extractSchedule          — the responses, normalised
//   * envelope                                 — the success envelope
//   * rewriteUrl                               — Chola's internal links
//   * toPortalDate / tokenRejection            — the CKYC portal's quirks
//
// The PolicyGeneration body builder and outcome readers live next door in
// cholaPolicyGeneration.helper.js, for the same reason ICICI keeps its crypto
// apart from icici.helper.js.
//
// ── Error codes are deliberately NOT prefixed ───────────────────────────────
// ITGI and FG answer ITGI_UPSTREAM_ERROR / FG_UPSTREAM_ERROR. Chola answers the
// working implementation's bare VALIDATION_ERROR / CONFIG_ERROR / AUTH_ERROR /
// TIMEOUT_ERROR / UPSTREAM_ERROR / PARSE_ERROR, with the same HTTP statuses it
// mapped them to, because the SPA's api/cholaClient.js maps exactly those codes
// to buyer-facing sentences and nothing else — the same decision ICICI made.
// ─────────────────────────────────────────────────────────────────────────────

// The codebase's convention for a typed failure is an Error with extra
// properties rather than a class hierarchy (see icici.helper.js's iciciError).
//
//   status   — the HTTP status the controller answers with
//   code     — machine-readable, stable across message rewording
//   provider — echoed on the error envelope exactly as the working
//              implementation did: 'chola', or null for a local validation
//              failure (its ValidationError never carried a provider)
//   details  — anything the caller needs in order to act
//   chola    — marks an error this integration already classified, so the
//              transport never re-wraps it
function cholaError(message, {
  status = 502, code = 'UPSTREAM_ERROR', provider = CHOLA_PROVIDER, details = null, cause = null,
} = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.provider = provider;
  error.details = details;
  error.chola = true;
  if (cause) error.cause = cause;
  return error;
}

/** Input failed local validation before any network call was made. 400. */
function validationError(message, details = null) {
  return cholaError(message, { status: 400, code: 'VALIDATION_ERROR', provider: null, details });
}

/** Authenticating with Chola (OAuth2 or the CKYC TokenKey) failed — OUR credential, so a 502. */
function authError(message, { details = null, cause = null } = {}) {
  return cholaError(message, { status: 502, code: 'AUTH_ERROR', details, cause });
}

/** Chola returned a technical failure (non-2xx, or an exhausted 5xx). */
function upstreamError(message, { details = null, cause = null } = {}) {
  return cholaError(message, { status: 502, code: 'UPSTREAM_ERROR', details, cause });
}

/** The request timed out. */
function timeoutError(message, { details = null, cause = null } = {}) {
  return cholaError(message, { status: 504, code: 'TIMEOUT_ERROR', details, cause });
}

/** A response could not be read into the expected shape. */
function parseError(message, { details = null, cause = null } = {}) {
  return cholaError(message, { status: 502, code: 'PARSE_ERROR', details, cause });
}

/** Chola is not configured on this deployment (or the ops routes are off). 503. */
function configError(message, { details = null } = {}) {
  return cholaError(message, { status: 503, code: 'CONFIG_ERROR', details });
}

/**
 * The CALLER is not authenticated — the ops routes' X-Ops-Key. Distinct from
 * authError above, which is this service failing to authenticate with CHOLA:
 * that is a 502 (our credential, our problem) and this is a 401.
 */
function unauthorizedError(message, details = null) {
  return cholaError(message, { status: 401, code: 'UNAUTHORIZED', provider: null, details });
}

/** Nothing stored for what was asked. 404. */
function notFoundError(message, details = null) {
  return cholaError(message, { status: 404, code: 'NOT_FOUND', details });
}

// ── Payload guards ──────────────────────────────────────────────────────────
//
// The working implementation's core/validate.js, unchanged.

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

/**
 * Assert that every dot-notation path is present and non-empty.
 * @param {string[]} fields e.g. ['InsuredMembers', 'GenconProposalNumber']
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
//
// The working implementation's parsers/responseParser.js, unchanged.
//
// ⚠️ EVERY FIELD NAME BELOW WAS READ OFF A LIVE UAT RESPONSE (2026-09-09), not
// off the Data Dictionary. The two disagree in ways that silently produce null:
//
//   PremiumComputation  the premium is `TotalPremiumPayable_InclGST`.
//                       There is NO `TotalPremium`, `Premium` or `GrossPremium`
//                       field of any kind.
//   ProposalSave        the proposal number is `GENCONProposalNumber` —
//                       all-caps GENCON. The Data Dictionary calls it "GENCON
//                       Proposal Number" and the PolicyGeneration REQUEST field
//                       is `GenconProposalNumber`, so the camel-case spelling
//                       looks right and reads as null on every success.
//   PolicyGeneration    the policy number is `PolicyNumber` (the REQUEST field
//                       is `GenconPolicyNumber`).
//
// Business failures arrive as HTTP 200 with `Status: "Failure"` and Chola's own
// sentence in `Errormessage`, so `status` and `message` are surfaced on every
// extract and callers must check them — an unpriced quote and a priced one are
// both HTTP 200.
//
// `raw` carries the untouched body so a caller can read a field this does not
// name yet, which is what makes the Supreme and Super Topup products (whose
// responses could not be observed — health-flexi-supreme answers 404 and
// Health-supertopup 403 on the NovaCred credentials) usable the moment Chola
// enable them. The alternate spellings kept in each reader are the ones their
// own kit samples imply, not observed values.

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

/** Did Chola say this succeeded? Their own verdict, not an inference from HTTP. */
function readStatus(d) {
  const status = d.Status ?? d.status ?? null;
  const message = d.Errormessage ?? d.ErrorMessage ?? d.errorMessage ?? d.Message ?? null;
  const succeeded = String(status || '').trim().toLowerCase() === 'success';
  return { status, message: message || null, succeeded };
}

/** PremiumComputation. */
function extractPremium(data) {
  const d = data || {};
  const { status, message, succeeded } = readStatus(d);
  return {
    succeeded,
    status,
    message,
    // Payable, tax inclusive — the figure a buyer is charged.
    totalPremium: num(d.TotalPremiumPayable_InclGST),
    netPremium: num(d.TotalPremium_exclGST),
    tax: num(d.GST_on_TotalPremium),
    // Per-instalment figures. This journey is single-pay, so they equal the
    // totals, but they are what a modal (monthly/quarterly) policy would read.
    modalPremium: num(d.ModalPremiumPayable_InclGST),
    modalNetPremium: num(d.ModalPremium_exclGST),
    modalTax: num(d.GST_on_Modal_Premium),
    tier1: d.OptedforTier1Premium ?? null,
    raw: d,
  };
}

/** ProposalSave — the Gencon proposal number and Chola's re-priced premium. */
function extractProposal(data) {
  const d = data || {};
  const { status, message, succeeded } = readStatus(d);
  // All-caps GENCON is what the live API sends; the other spellings are kept so
  // a differently-cased product response still resolves rather than reading null.
  const rawNo = d.GENCONProposalNumber ?? d.GenconProposalNumber ?? d.genconProposalNumber
    ?? d.ProposalNumber ?? d.GenconProposalNo ?? d.ProposalNo ?? null;
  // A rejected proposal comes back with GENCONProposalNumber 0, not null — so
  // zero is read as "no proposal", or a failure would carry "0" downstream as
  // though it were a real reference.
  const proposalNo = rawNo == null || rawNo === '' || Number(rawNo) === 0 ? null : String(rawNo);
  return {
    succeeded: succeeded && proposalNo != null,
    status,
    message,
    genconProposalNumber: proposalNo,
    // Chola create the customer record on ProposalSave and return its id.
    customerId: d.CustomerID != null ? String(d.CustomerID) : null,
    uniqueTransactionId: d.UniqueTransactionID != null ? String(d.UniqueTransactionID) : null,
    // Chola RE-PRICE on ProposalSave. This is the amount the payment must be
    // tagged for; the quote's figure is not authoritative once this exists.
    premium: num(d.TotalPremiumPayable_InclGST),
    netPremium: num(d.NetPremium),
    premiumExclGst: num(d.TotalPremium_exclGST),
    tax: num(d.GST_on_TotalPremium),
    raw: d,
  };
}

/** PolicyGeneration — the Gencon policy number, or Chola's hosted payment page. */
function extractPolicy(data) {
  const d = data || {};
  const { status, message, succeeded } = readStatus(d);
  const policyNo = d.PolicyNumber ?? d.GenconPolicyNumber ?? d.genconPolicyNumber ?? d.PolicyNo ?? null;
  return {
    succeeded,
    status,
    message,
    genconPolicyNumber: policyNo || null,
    // With PayMode "Chola" the policy number is empty and this carries their
    // hosted payment page instead; with "Direct" it is the other way round.
    paymentUrl: d.URL || null,
    payzappId: d.PayzappID || null,
    raw: d,
  };
}

/**
 * PolicySchedule — the document links.
 *
 * An unissued policy — or a proposal number passed where a policy number was
 * expected — answers HTTP 200 with both URLs EMPTY rather than an error, so
 * `succeeded` is "there is a document", not "the call worked".
 */
function extractSchedule(data) {
  const d = data || {};
  const scheduleUrl = d.CMSScheduleURL || null;
  const cisUrl = d.CISScheduleURL || null;
  return {
    succeeded: Boolean(scheduleUrl || cisUrl),
    scheduleUrl,
    customerInformationSheetUrl: cisUrl,
    raw: d,
  };
}

/**
 * The success envelope every product operation answers with — the working
 * implementation's _envelope(), byte for byte, because the SPA reads
 * `res.data.<field>` (and `res.data.raw`) off exactly this shape.
 */
function envelope(operation, productKey, data, res) {
  return {
    ok: true,
    provider: CHOLA_PROVIDER,
    operation,
    product: productKey,
    data,
    meta: { httpStatus: res?.status, correlationId: res?.correlationId },
  };
}

/**
 * Chola answer PolicyGeneration and PolicySchedule with links on their own
 * INTERNAL address — verified on UAT 2026-09-09, both come back on
 * http://10.105.63.69, which no browser outside Chola's network can resolve.
 *
 * CHOLA_PUBLIC_URL_BASE rewrites the scheme/host/port of those links to a
 * publicly reachable origin, leaving the path and query untouched. Unset, the
 * link is passed through exactly as Chola sent it — the caller can then see the
 * real host and say so, which is far better than silently handing a buyer a
 * dead link.
 */
function rewriteUrl(url, base) {
  if (!url || !base) return url || null;
  try {
    const target = new URL(url);
    const origin = new URL(base);
    target.protocol = origin.protocol;
    target.host = origin.host;
    return target.toString();
  } catch {
    // A value that is not a URL is left alone rather than dropped: Chola send
    // "" for the field that does not apply, and that is meaningful.
    return url;
  }
}

// ── CKYC portal ─────────────────────────────────────────────────────────────

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/**
 * DOB_DOI, in the one format the portal accepts: DD-MMM-YYYY.
 *
 * ⚠️ THE KIT DOCUMENTS THE WRONG FORMAT. UAT_CKYC.postman_collection.json
 * annotates the field `"DOB_DOI": "13-07-2020",//dd-MM-yyyy` — and that exact
 * body, replayed verbatim on 2026-09-18, comes back HTTP 200 with:
 *   { "Status":"Failure",
 *     "ErrorMsg":"Invalid DOB/DOI. Expected format: DD-MMM-YYYY. ",
 *     "Policy_Gen_Flag":"No" }
 * while the same call with "13-JUL-2020" is accepted and reaches CERSAI. ISO
 * (1991-12-05) is rejected with the same sentence.
 *
 * Only forms that CANNOT mean anything else are converted:
 *   DD-MMM-YYYY  → passed through, upper-cased (already correct)
 *   dd-MM-yyyy   → converted   (the kit's documented form; also dd/MM/yyyy,
 *                               the separator the product APIs use)
 *   yyyy-MM-dd   → converted   (what an <input type="date"> yields)
 * Anything else — including MM-dd-yyyy, which is indistinguishable from the
 * documented form and would silently verify the wrong identity — is handed to
 * the portal exactly as written, so Chola name the problem in their own words
 * rather than this function guessing at it.
 */
function toPortalDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  if (/^\d{1,2}-[A-Za-z]{3}-\d{4}$/.test(s)) return s.toUpperCase();

  let d;
  let m;
  let y;
  const dmy = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  const ymd = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(s);
  if (dmy) {
    [, d, m, y] = dmy;
  } else if (ymd) {
    [, y, m, d] = ymd;
  } else {
    return s;
  }

  const month = MONTHS[Number(m) - 1];
  // A month outside 1-12 means the value was not the format it looked like
  // (MM-dd-yyyy, most likely). Send it unchanged and let the portal refuse it.
  return month ? `${String(d).padStart(2, '0')}-${month}-${y}` : s;
}

/**
 * The portal signals a stale/missing TokenKey with HTTP 200 and a body-level
 * failure — it never sends 401/403 — so it has to be detected from the body:
 *   { ..., "Status": "Failure", "ErrorMsg": "Invalid Token Key"    }  (bad token)
 *   { ..., "Status": "Failure", "ErrorMsg": "Enter CKYC Token Key" }  (no header)
 *   { ..., "Status": "Failure",
 *          "ErrorMsg": "Session Expired, please check timestamp." }  (EXPIRED)
 *
 * ⚠️ The third wording mentions neither "token" nor "key". It is what the portal
 * actually returns once a cached TokenKey ages out (observed on UAT 2026-09-09
 * from a long-running process). Matching only the first two meant the TokenKey
 * was never refreshed and every CKYC call failed for the rest of the process's
 * life.
 *
 * Matched narrowly on these wordings rather than on Status alone: a genuine
 * "no CKYC record found" result is also Status=Failure and must keep flowing
 * through to the caller as data rather than becoming an error.
 *
 * Casing differs by endpoint — Auth returns ErrorMSG, Verify/Query ErrorMsg.
 * @returns {string|null} the upstream message when it is a token rejection
 */
const TOKEN_REJECTION = /token\s*key|session\s*expired/i;

function tokenRejection(body) {
  if (!body || typeof body !== 'object') return null;
  const msg = String(body.ErrorMsg || body.ErrorMSG || body.errorMsg || '');
  return TOKEN_REJECTION.test(msg) ? msg : null;
}

// ── Small shared utilities ──────────────────────────────────────────────────

/**
 * A blank upstream response arrives as '' — or as {} once axios has parsed a
 * 204 — not as null. Both would otherwise survive normalization and reach the
 * caller as an all-null result: a "successful" proposal carrying no proposal
 * number. Treated as unparseable instead.
 */
function isEmptyBody(value) {
  if (value === undefined || value === null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object' && !Array.isArray(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * Headers as they may be shown or stored: every credential-shaped header is
 * reduced to its length, never a fragment of it — the bearer token, the Basic
 * pair and the CKYC TokenKey alike. Chola's own copy, so no other integration
 * can move it.
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

function trunc(value, max = 400) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  return s ? s.slice(0, max) : s;
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}

export {
  cholaError,
  validationError,
  authError,
  upstreamError,
  timeoutError,
  parseError,
  configError,
  unauthorizedError,
  notFoundError,
  getPath,
  isEmpty,
  requireFields,
  num,
  readStatus,
  extractPremium,
  extractProposal,
  extractPolicy,
  extractSchedule,
  envelope,
  rewriteUrl,
  toPortalDate,
  tokenRejection,
  isEmptyBody,
  safeHeaders,
  safeJson,
  trunc,
  hostOf,
};
