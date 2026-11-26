// ─────────────────────────────────────────────────────────────────────────────
// Masks an insurer request or response before it is stored as
// request_masked / response_masked in a health_<insurer>_api_logs row.
//
// The exact bytes are kept separately, encrypted (request_enc / response_enc),
// for the retention period. This masked copy is what support and reporting
// read, so it keeps the structure, codes, amounts, statuses and references and
// replaces personal and health data and credentials.
//
// The same approach as helpers/galaxyMask.helper.js (left unchanged), with the
// key list widened for every insurer's field names: ICICI NomineeDOB,
// CkycNumber, HeightsInFeets, IsPED; Niva DOB / MOBILE / EMAIL_ID; and so on.
// ─────────────────────────────────────────────────────────────────────────────

export const MASK = '***';

// Any key that, lower-cased with everything but letters and digits removed,
// CONTAINS one of these.
// Over-matching is the safe direction: a masked status flag costs nothing,
// an unmasked date of birth does.
const SENSITIVE_PARTS = [
  'name', 'dob', 'dateofbirth', 'birth', 'mobile', 'phone', 'contactno', 'email',
  'pan', 'aadhaar', 'aadhar', 'uidno', 'uidnumber', 'passport', 'voter', 'drivinglicen',
  'ckyc', 'kycnumber', 'kycno', 'address', 'addr', 'street', 'landmark', 'account', 'ifsc', 'upi',
  'height', 'weight', 'bmi', 'ped', 'disease', 'medical', 'illness', 'ailment', 'question', 'answer',
  'declaration', 'habit', 'smok', 'alcohol', 'tobacco',
  'password', 'secret', 'token', 'authorization', 'apikey', 'privatekey', 'checksum', 'encparam', 'signature',
];

// Keys that contain a sensitive part but name a product, a file or a reference.
const SAFE_KEYS = new Set([
  'productname', 'planname', 'covername', 'discountname', 'zonename', 'filename', 'insurername',
  'insurancename', 'company', 'companyname', 'channelname', 'variantname', 'pancheck', 'requestuid',
]);

// Personal data inside free text, such as an error message that quotes a value.
const VALUE_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,      // email
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,                       // PAN
  /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g,      // Indian mobile number
  /(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/g,           // Aadhaar number
];

// Base64 documents, PDFs and other blobs are not worth keeping in a masked copy.
const MAX_STRING = 2048;
const MAX_DEPTH = 12;

function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (SAFE_KEYS.has(k)) return false;
  return SENSITIVE_PARTS.some((part) => k.includes(part));
}

// A URL keeps its scheme, host and path; its query string (payment-page
// session tokens, encrypted parameters) does not.
const URL_QUERY = /(https?:\/\/[^\s?#"']+)\?[^\s#"']*/gi;

function maskText(s) {
  const text = s.length > MAX_STRING ? `[${s.length} characters]` : s;
  return VALUE_PATTERNS.reduce((out, re) => out.replace(re, MASK), text.replace(URL_QUERY, `$1?${MASK}`));
}

/** A masked deep copy of `value`; the input is not changed. */
export function maskForStore(value, depth = 0) {
  if (depth > MAX_DEPTH) return MASK;
  if (typeof value === 'string') return maskText(value);
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (Array.isArray(value)) return value.map((v) => maskForStore(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // A sensitive key is masked whole, whatever it holds: an address block or
      // a medical questionnaire is personal data all the way down.
      const empty = v === null || v === undefined || v === '';
      out[k] = !empty && isSensitiveKey(k) ? MASK : maskForStore(v, depth + 1);
    }
    return out;
  }
  return value;
}
