// ─────────────────────────────────────────────────────────────────────────────
// Masks a decrypted GHI payload before it goes into an error's `details` or a
// log line. The controller returns `details` to the API caller, and GHI's error
// payloads may echo request data back. So personal data and credentials are
// replaced, while the structure, codes and messages are kept and GHI's reason
// stays readable.
//
// Moved unchanged from the working implementation (src/providers/galaxy/
// gxMask.js, 24 Nov 2026).
// ─────────────────────────────────────────────────────────────────────────────

export const MASK = '***REDACTED***';

// Exact keys, compared lower-case with anything but letters and digits removed.
const PERSONAL_KEYS = new Set([
  'name', 'firstname', 'middlename', 'lastname', 'fullname', 'proposername', 'insuredname',
  'membername', 'nomineename', 'customername', 'policyholdername', 'appointeename',
  'fathername', 'mothername', 'spousename',
  'dateofbirth', 'dob', 'birthdate',
  'mobile', 'mobileno', 'mobilenumber', 'phone', 'phoneno', 'phonenumber', 'contactno', 'contactnumber',
  'email', 'emailid', 'emailaddress',
  'pan', 'panno', 'pannumber', 'pancard', 'pancardno', 'pancardnumber',
  'passport', 'passportno', 'passportnumber', 'accountno', 'accountnumber', 'bankaccountnumber',
]);

// Any key containing one of these: address lines, Aadhaar fields, credentials and keys.
const SENSITIVE_PARTS = ['address', 'aadhaar', 'aadhar', 'token', 'secret', 'password', 'authorization', 'apikey', 'privatekey', 'checksum'];

// Personal data inside free text, such as an error message that quotes a value.
const VALUE_PATTERNS = [
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,      // email
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,                       // PAN
  /(?<!\d)(?:\+?91[-\s]?)?[6-9]\d{9}(?!\d)/g,      // Indian mobile number
  /(?<!\d)\d{4}\s?\d{4}\s?\d{4}(?!\d)/g,           // Aadhaar number
];

const MAX_DEPTH = 50;

function isSensitiveKey(key) {
  const k = String(key).toLowerCase().replace(/[^a-z0-9]/g, '');
  return PERSONAL_KEYS.has(k) || SENSITIVE_PARTS.some((p) => k.includes(p));
}

function maskText(s) {
  return VALUE_PATTERNS.reduce((out, re) => out.replace(re, MASK), s);
}

/** A masked deep copy of `value`; the input is not changed. */
export function maskPersonalData(value, depth = 0) {
  if (depth > MAX_DEPTH) return MASK;
  if (typeof value === 'string') return maskText(value);
  if (Array.isArray(value)) return value.map((v) => maskPersonalData(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = isSensitiveKey(k) && v !== null && v !== undefined && v !== '' ? MASK : maskPersonalData(v, depth + 1);
    }
    return out;
  }
  return value;
}
