import crypto from 'node:crypto';

// Keys whose values must never reach api_transactions.request_payload. The
// NivaBupa integration passes client secrets, bearer tokens and the SOAP
// encryption keys through the same helper functions that log — persisting
// those would put long-lived partner credentials in a table that support
// staff and analytics jobs can read.
const REDACTED_KEYS = [
  'client_secret', 'clientsecret', 'password', 'authorization', 'access_token',
  'accesstoken', 'token', 'encryptionkey', 'decryptionkey', 'bearer', 'secret',
  'apikey', 'api_key',
];

const REDACTION = '***REDACTED***';

// Depth-limited: NivaBupa payloads are shallow (member[] of flat objects), and
// an unbounded walk over a caller-supplied body is a denial-of-service vector
// on a public endpoint.
const MAX_DEPTH = 8;

function shouldRedact(key) {
  const normalized = String(key).toLowerCase().replace(/[^a-z_]/g, '');
  return REDACTED_KEYS.some((candidate) => normalized === candidate || normalized.includes(candidate));
}

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = shouldRedact(key) ? REDACTION : redact(entry, depth + 1);
  }
  return output;
}

// Base64 policy PDFs come back from /nivabupa/policy-download inside the
// response envelope. Keeping one in api_transactions.response_payload would
// put a multi-megabyte string in an append-only audit table on every download;
// the document itself is stored once, on journey_policies.
const MAX_STORED_STRING = 4096;

function truncateLargeStrings(value, depth = 0) {
  if (typeof value === 'string') {
    return value.length > MAX_STORED_STRING
      ? `${value.slice(0, MAX_STORED_STRING)}…[truncated ${value.length - MAX_STORED_STRING} chars]`
      : value;
  }
  if (value === null || value === undefined || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => truncateLargeStrings(item, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = truncateLargeStrings(entry, depth + 1);
  }
  return output;
}

function forAudit(value) {
  return truncateLargeStrings(redact(value));
}

function newUuid() {
  return crypto.randomUUID();
}

// 64 hex chars, matching journeys.resume_token CHAR(64). Random rather than a
// signed JWT: the token is a bearer capability checked against the row, so it
// must be revocable by deleting/rotating the row, which a self-contained
// signed token would not be.
function newResumeToken() {
  return crypto.randomBytes(32).toString('hex');
}

// NivaBupa sends and expects dates as '06/Aug/1998'. Stored verbatim in
// *_raw columns for byte-identical replay; this produces the DATE form used
// for age maths and reporting. Returns null on anything unparseable rather
// than guessing, so a bad date never becomes a wrong date in the DB.
const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

function toMysqlDate(value) {
  if (!value) return null;
  const raw = String(value).trim();

  // Already ISO (YYYY-MM-DD), possibly with a time component.
  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // NivaBupa DD/Mon/YYYY or DD-Mon-YYYY.
  const named = raw.match(/^(\d{1,2})[/-]([A-Za-z]{3,})[/-](\d{4})$/);
  if (named) {
    const month = MONTHS[named[2].slice(0, 3).toLowerCase()];
    if (month) return `${named[3]}-${month}-${String(named[1]).padStart(2, '0')}`;
  }

  // DD/MM/YYYY — ambiguous with MM/DD/YYYY, so only accepted when the first
  // component cannot be a month.
  const numeric = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (numeric && Number(numeric[1]) > 12) {
    return `${numeric[3]}-${String(numeric[2]).padStart(2, '0')}-${String(numeric[1]).padStart(2, '0')}`;
  }
  if (numeric && Number(numeric[2]) <= 12) {
    return `${numeric[3]}-${String(numeric[2]).padStart(2, '0')}-${String(numeric[1]).padStart(2, '0')}`;
  }

  return null;
}

// MySQL DECIMAL columns reject '' and 'N/A'; NivaBupa's payment callback sends
// empty pipe fields for absent amounts.
function toDecimal(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(String(value).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function toInt(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// VARCHAR overflow is a hard error in strict mode; a partner API that returns a
// longer-than-expected status message should not fail the save.
function clamp(value, maxLength) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export {
  redact,
  forAudit,
  truncateLargeStrings,
  newUuid,
  newResumeToken,
  toMysqlDate,
  toDecimal,
  toInt,
  clamp,
  REDACTION,
};
