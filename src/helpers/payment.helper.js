import {
  PAYMENT_QUERYSTRING_FIELDS,
  PAYMENT_MANDATORY_FIELDS,
  PAYMENT_SUCCESS_CODE,
  NIVABUPA_RETURN_PAGE,
} from '../constants/payment.constants.js';

function normalizeField(value) {
  return value !== undefined && value !== null ? value : '';
}

function findMissingMandatoryFields(body) {
  return PAYMENT_MANDATORY_FIELDS.filter((field) => !body[field]);
}

// "field=value" pairs, pipe-separated, EVERY field in
// PAYMENT_QUERYSTRING_FIELDS always present in this exact order — never
// omitted, blank ('') when not supplied. Previously optional/absent
// fields were filtered out entirely; changed per the API spec's own
// wording for policynumber ("Mandatory in case of Renewal Only
// otherwise blank" — "blank" meaning present-but-empty, not absent),
// which implies the gateway expects a complete, fixed-length field set
// on every request, not a variable-length one.
function buildPaymentQuerystring(body) {
  return PAYMENT_QUERYSTRING_FIELDS
    .map((field) => `${field}=${normalizeField(body[field])}`)
    .join('|');
}

function logPaymentPlaintext(body, querystring) {
  console.log('\n📤 NivaBupa payment/initiate — plaintext before encryption:');
  for (const field of PAYMENT_QUERYSTRING_FIELDS) {
    console.log(`   ${field} = ${JSON.stringify(normalizeField(body[field]))}`);
  }
  console.log('   Full plaintext:', querystring);
}

// Field order is fixed by NivaBupa's documented returnMessage format.
function parseReturnMessage(decrypted) {
  const fields = decrypted.split('|');

  return {
    source: fields[0],
    uniqueReferenceId: fields[1],       // policy number
    payablePremium: fields[2],          // amount
    transactionDateTime: fields[3],
    uniqueReferenceNoRepeat: fields[4],
    paymentTransactionId: fields[5],    // transaction id
    paymentStatus: fields[6],
    paymentStatusDescription: fields[6] === PAYMENT_SUCCESS_CODE ? 'SUCCESS' : 'FAILED_OR_OTHER',
    failedReason: fields[7],            // error message, if any
    standingInstructionTaken: fields[8],
    standingInstructionNo: fields[9],
    paymentGatewayUsed: fields[10]
  };
}

// Caps the exact error carried in the redirect. A WAF block answers with a full
// HTML page, and the whole message is URL-encoded into the return page's query
// string — uncapped, it can exceed the frontend server's request-line limit and
// the buyer gets a 414 instead of the error.
const CALLBACK_ERROR_DETAIL_MAX = 700;

// Shows the exact failure on the return page rather than a generic message, so a
// UAT decResp failure can be diagnosed from the page itself: error.message starts
// with the HTTP status and carries Niva Bupa's response body (SOAP Fault / WAF
// page), and soapCause names which failure mode that is (see soap.service.js).
// Neither contains the EncryptionKey or the ciphertext — the request XML is never
// put on the error. The full exception and stack still go to the server log.
function buildSafeCallbackErrorMessage(error) {
  const message = String(error.message || 'Unknown error').replace(/\s+/g, ' ').trim();
  const detail = message.length > CALLBACK_ERROR_DETAIL_MAX
    ? `${message.slice(0, CALLBACK_ERROR_DETAIL_MAX)}…`
    : message;
  return error.soapCause ? `${detail} | Cause: ${error.soapCause}` : detail;
}

// Longer than any real return page, short enough that a junk value is refused
// before it is parsed or written anywhere.
const FRONTEND_RETURN_URL_MAX = 500;

function originOf(value) {
  try {
    return new URL(String(value).trim()).origin;
  } catch {
    return null;
  }
}

// Whether handlePaymentReturn may send the buyer to the return page a frontend
// named on payment/initiate (body.frontendReturnUrl) instead of FRONTEND_URL.
// Yes only for an absolute http(s) URL whose origin is on allowedOrigins and
// whose path ends in the Niva Bupa return page, with no credentials, query
// string or fragment (the payment outcome is appended as the query string).
//
// Returns { url } with only the origin and path kept, or { url: null, reason }.
// No value at all is not a refusal ({ url: null, reason: null }): the old app
// names no page, and its buyers go to FRONTEND_URL exactly as before.
function resolveFrontendReturnUrl(value, allowedOrigins) {
  if (value === undefined || value === null || value === '') return { url: null, reason: null };
  if (typeof value !== 'string' || value.length > FRONTEND_RETURN_URL_MAX) {
    return { url: null, reason: `not a string of at most ${FRONTEND_RETURN_URL_MAX} characters` };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { url: null, reason: 'not an absolute URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: null, reason: `${parsed.protocol} is not http(s)` };
  }
  if (parsed.username || parsed.password) return { url: null, reason: 'carries credentials' };
  if (parsed.search || parsed.hash) return { url: null, reason: 'carries a query string or fragment' };
  const allowed = (allowedOrigins || []).map(originOf).filter(Boolean);
  if (!allowed.includes(parsed.origin)) return { url: null, reason: `origin ${parsed.origin} is not allowed` };
  if (!parsed.pathname.endsWith(NIVABUPA_RETURN_PAGE)) {
    return { url: null, reason: `path ${parsed.pathname} is not a ${NIVABUPA_RETURN_PAGE} page` };
  }
  return { url: `${parsed.origin}${parsed.pathname}`, reason: null };
}

export {
  findMissingMandatoryFields,
  buildPaymentQuerystring,
  logPaymentPlaintext,
  parseReturnMessage,
  buildSafeCallbackErrorMessage,
  resolveFrontendReturnUrl,
};
