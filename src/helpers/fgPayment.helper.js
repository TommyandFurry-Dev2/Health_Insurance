import crypto from 'node:crypto';

import config, { missingFgPaymentVariables } from '../config/env.js';
import {
  CHECKSUM_FIELDS,
  PAYMENT_OPTIONS,
  PAYMENT_RESULT,
  PAYMENT_CIPHER_KEYS,
  PAYMENT_PLAINTEXT_FIELDS,
} from '../constants/fg.constants.js';
import { fgError, validationError, configError, parseError } from './fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Future Generali — payment collection (step 4 of their web-aggregator flow).
//
// FG expose NO payment API. The browser is handed to their gateway page with a
// form POST, the buyer pays there, and the outcome comes back as an ENCRYPTED
// form POST to a ResponseURL of our choosing. So this file holds the three
// things a single-page app cannot do for itself:
//
//   * the CheckSum — a SHA-256 over the eleven posted values, which must match
//     them exactly
//   * the decryption of FG's response — the key must never reach a browser
//     bundle
//   * reading that response into one shape, including the case where it arrives
//     and cannot be read at all
//
// ── Why "undecryptable" is its own outcome ──────────────────────────────────
// A response that ARRIVES but cannot be read is not a failed payment. Money may
// well have moved. Reporting it as "not received" is what invites a buyer to
// pay a second time, so it is returned as `unverified` with the reason kept,
// and every caller is expected to say so rather than offer to pay again.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The four variables the payment leg needs on top of the four every FG call
 * needs. Checked per call rather than at boot, so a deployment that quotes and
 * proposes but has no gateway configured still serves those legs — only the
 * payment routes answer 503.
 */
function assertPaymentConfigured() {
  const missing = missingFgPaymentVariables();
  if (missing.length > 0) {
    throw configError(
      `Future Generali payment is not configured. Set ${missing.join(', ')} in the environment.`,
      { missing }
    );
  }
}

// ── CheckSum ────────────────────────────────────────────────────────────────
//
// v1.39, "To Generate CheckSum", verbatim:
//
//   string text = "TransactionID|PaymentOption|ResponseURL|ProposalNumber|
//                  PremiumAmount|UserIdentifier|UserId|FirstName|LastName|
//                  Mobile|Email|"
//   Generatehash256: SHA256Managed().ComputeHash(UTF8.GetBytes(text))
//                    then String.Format("{0:x2}") per byte
//
// Three details the document is explicit about and which are easy to get wrong:
//   - there is a TRAILING pipe after Email;
//   - Vendor is NOT part of the input, despite sitting next to it in the form;
//   - CheckSum is obviously not part of its own input.
//
// It is a SHA-256 digest — 64 lowercase hex characters — not an encoding of the
// string. There is no secret in it, so it is an integrity check rather than a
// signature, and it must be built from the SAME values that go into the form or
// the two disagree and FG reject the payment.

/** The exact string hashed — exposed so a mismatch can be diagnosed. */
function checksumInput(values) {
  return `${CHECKSUM_FIELDS.map((field) => String(values[field] ?? '')).join('|')}|`;
}

/** @returns {string} 64 lowercase hex chars. */
function paymentChecksum(values) {
  return crypto.createHash('sha256')
    .update(Buffer.from(checksumInput(values), 'utf8'))
    .digest('hex');
}

/** The configured gateway. One URL, from one variable — see config/env.js. */
function gatewayUrl() {
  return config.fg.payment.gatewayUrl;
}

/**
 * Build the form the browser POSTs to FG's gateway. Nothing is sent from here —
 * the buyer has to land on FG's page themselves.
 *
 * @returns {{ url:string, fields:{name:string,value:string}[], checksumFields:string[] }}
 */
function buildPaymentRequest({
  transactionId, paymentOption, proposalNumber, premiumAmount, customer = {}, responseUrl,
}) {
  assertPaymentConfigured();
  const p = config.fg.payment;

  const missing = [];
  if (!transactionId) missing.push('transactionId');
  if (!proposalNumber) missing.push('proposalNumber');
  if (!(Number(premiumAmount) > 0)) missing.push('premiumAmount');
  if (!customer.firstName) missing.push('customer.firstName');
  if (!customer.mobile) missing.push('customer.mobile');
  if (!customer.email) missing.push('customer.email');
  if (missing.length) {
    throw validationError(
      `The Future Generali payment request is missing: ${missing.join(', ')}`,
      missing[0],
      { missing }
    );
  }

  const option = String(paymentOption || '');
  if (!PAYMENT_OPTIONS.some((entry) => entry.value === option)) {
    throw validationError(
      `Unknown Future Generali paymentOption "${option}". Valid: `
      + PAYMENT_OPTIONS.map((entry) => `${entry.value} [${entry.label}]`).join(', '),
      'paymentOption',
      { got: option, valid: PAYMENT_OPTIONS }
    );
  }

  const values = {
    TransactionID: String(transactionId),
    PaymentOption: option,
    // Ours, and the one field on this form whose correctness we control: FG
    // POST the outcome here. It must be reachable from FG's servers and must
    // point at this service's callback, never at the SPA.
    ResponseURL: responseUrl || p.returnUrl,
    ProposalNumber: String(proposalNumber),
    PremiumAmount: String(premiumAmount),
    UserIdentifier: p.userIdentifier,
    UserId: p.userId,
    FirstName: customer.firstName || '',
    LastName: customer.lastName || '',
    Mobile: customer.mobile || '',
    Email: customer.email || '',
  };

  const fields = CHECKSUM_FIELDS.map((name) => ({ name, value: values[name] }));
  // Vendor sits alongside CheckSum in FG's own submission but outside its input.
  // Optional per v1.39 ("Blank [.Net] or 0[.Net] or 1[PHP]") and confirmed
  // optional on UAT; sent because that is what has worked to date.
  if (p.vendor !== '') fields.push({ name: 'Vendor', value: p.vendor });
  fields.push({ name: 'CheckSum', value: paymentChecksum(values) });

  return { url: gatewayUrl(), fields, checksumFields: CHECKSUM_FIELDS };
}

// ── Response decryption ─────────────────────────────────────────────────────
//
// Their payment document (v1.39, "For Encryption and Decryption") specifies a
// DecryptText over a fixed 8-byte key, a fixed 8-byte IV, and one transport
// fix-up applied first:
//
//   GetDecryptText(text) -> DecryptText(text.Replace("$", "+"))
//
// The key and IV themselves are configuration, not code: they arrive as
// FG_PG_CRYPTO_KEY and FG_PG_CRYPTO_IV, and the values FG publish are recorded
// in .env.example. No credential-shaped literal belongs in this file.
//
// An 8-byte key with an 8-byte IV is single DES. Node's OpenSSL 3 build no
// longer offers `des-cbc` outside the legacy provider, so this uses
// `des-ede3-cbc` with the key repeated three times: 3DES with K1=K2=K3 is
// DEFINED as single DES, so the plaintext is identical and nothing about the
// wire format changes. Verified against FG's own documented sample, which
// decrypts to:
//
//   WS_P_ID=TP025482&TID=AJ12345009&PGID=403993715515706205&Premium=100.00&Response=Success

/** @returns {Buffer} the 24-byte 3DES key derived from FG's 8-byte key. */
function keyBuffer() {
  const raw = Buffer.from(config.fg.payment.cryptoKey || '', 'utf8');
  if (raw.length !== 8) {
    throw parseError(
      `The Future Generali payment key must be 8 bytes, got ${raw.length}. Check FG_PG_CRYPTO_KEY.`,
      { keyBytes: raw.length }
    );
  }
  return Buffer.concat([raw, raw, raw]);
}

/** @returns {Buffer} the 8-byte IV. */
function ivBuffer() {
  const parts = String(config.fg.payment.cryptoIv || '')
    .split(',')
    .map((n) => Number(n.trim()));
  if (parts.length !== 8 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw parseError(
      'The Future Generali payment IV must be 8 comma-separated byte values. Check FG_PG_CRYPTO_IV.',
      { got: config.fg.payment.cryptoIv }
    );
  }
  return Buffer.from(parts);
}

/**
 * Restore the base64 FG mangled for URL transport.
 *
 * Only "$" -> "+" is documented. Whitespace is also restored because a form
 * POST that has been through a query string can arrive with "+" already decoded
 * to a space — skipping either step corrupts every ciphertext containing one.
 */
function restoreBase64(value) {
  return String(value).replace(/\$/g, '+').replace(/\s/g, '+');
}

/**
 * @param {string} cipherText base64 (possibly "$"-mangled) ciphertext
 * @returns {string} plaintext
 * @throws never returns a partial or empty string — "could not decrypt" and
 *   "payment not received" are different answers and must not be conflated.
 */
function decryptPaymentResponse(cipherText) {
  if (cipherText == null || String(cipherText).trim() === '') {
    throw parseError('The Future Generali payment response is empty');
  }

  const normalised = restoreBase64(cipherText);
  let data;
  try {
    data = Buffer.from(normalised, 'base64');
  } catch (error) {
    throw parseError('The Future Generali payment response is not valid base64', {
      cause: error.message,
    });
  }

  if (data.length === 0 || data.length % 8 !== 0) {
    throw parseError(
      `The Future Generali payment response is not a whole number of DES blocks (${data.length} bytes)`,
      { bytes: data.length }
    );
  }

  let plain;
  try {
    const decipher = crypto.createDecipheriv('des-ede3-cbc', keyBuffer(), ivBuffer());
    plain = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (error) {
    throw parseError('The Future Generali payment response could not be decrypted', {
      cause: error.message,
    });
  }

  // A wrong key decrypts to bytes, not to text. Caught here rather than letting
  // unreadable output be parsed into an empty, "failed" payment.
  // eslint-disable-next-line no-control-regex
  if (!/^[\x09\x0a\x0d\x20-\x7e]*$/.test(plain)) {
    throw parseError(
      'The Future Generali payment response decrypted to non-printable data — wrong key or IV'
    );
  }

  return plain;
}

// ── Reading the callback ────────────────────────────────────────────────────

function firstPresent(body, keys) {
  for (const key of keys) {
    if (body[key] != null && String(body[key]).trim() !== '') return String(body[key]);
  }
  return null;
}

function parseQueryish(text) {
  const out = {};
  for (const [key, value] of new URLSearchParams(text).entries()) out[key] = value;
  return out;
}

/** Case-insensitive read, because FG are not consistent about casing. */
function pick(obj, name) {
  const hit = Object.keys(obj).find((key) => key.toLowerCase() === name.toLowerCase());
  return hit ? obj[hit] : null;
}

/**
 * Normalise whatever FG POST to the ResponseURL into one shape.
 *
 * After decryption their payload is a query string. Two of its fields are not
 * merely informational — the kit is explicit that WS_P_ID becomes
 * <UniqueTranKey> and PGID becomes <TranRefNo> on the issuance request, so
 * losing either means a paid customer whose policy cannot be issued.
 *
 * @param {object} body the POSTed form body, or the query object on a GET
 */
function parsePaymentReturn(body = {}) {
  const empty = {
    status: PAYMENT_RESULT.EMPTY, ok: false, response: null, wsPId: null, pgid: null,
    transactionId: null, premium: null, encrypted: false, error: null, fields: {},
  };

  const keys = Object.keys(body || {});
  if (!keys.length) return empty;

  // FG may post the fields in the clear, or as one encrypted blob. Plaintext is
  // RECOGNISED by the field names themselves rather than assumed.
  let fields = null;
  let encrypted = false;

  const plainCandidate = keys.some(
    (key) => PAYMENT_PLAINTEXT_FIELDS.some((name) => name.toLowerCase() === key.toLowerCase())
  );

  if (plainCandidate) {
    fields = {};
    for (const key of keys) fields[key] = String(body[key]);
  } else {
    const cipher = firstPresent(body, PAYMENT_CIPHER_KEYS) || firstPresent(body, keys);
    if (!cipher) return empty;
    encrypted = true;
    try {
      fields = parseQueryish(decryptPaymentResponse(cipher));
    } catch (error) {
      // Something arrived. It could not be read. That is not "no payment".
      return { ...empty, status: PAYMENT_RESULT.UNVERIFIED, encrypted: true, error: error.message };
    }
  }

  // A blob that decrypted but carries none of FG's fields is equally unread.
  const response = pick(fields, 'Response');
  const wsPId = pick(fields, 'WS_P_ID');
  if (!response && !wsPId) {
    return {
      ...empty,
      status: PAYMENT_RESULT.UNVERIFIED,
      encrypted,
      error: 'The decrypted payload carried no recognisable Future Generali payment fields',
      fields,
    };
  }

  const ok = String(response || '').trim().toLowerCase() === 'success';

  return {
    status: ok ? PAYMENT_RESULT.SUCCESS : PAYMENT_RESULT.FAILURE,
    ok,
    response: response || null,
    wsPId: wsPId || null,          // → <UniqueTranKey> on issuance
    pgid: pick(fields, 'PGID'),    // → <TranRefNo> on issuance
    transactionId: pick(fields, 'TID'),
    premium: pick(fields, 'Premium'),
    encrypted,
    error: null,
    fields,
  };
}

/**
 * A payment may only lead to issuance when FG said Success AND both references
 * the issuance request needs are present. Missing either is a reconciliation
 * case, not an issuance case.
 *
 * @returns {string[]} reasons it cannot proceed; empty when it can
 */
function issuanceBlockers(result) {
  if (!result || result.status !== PAYMENT_RESULT.SUCCESS) {
    return [`payment status is "${result ? result.status : 'unknown'}", not success`];
  }
  const missing = [];
  if (!result.wsPId) missing.push('WS_P_ID (required as <UniqueTranKey>)');
  if (!result.pgid) missing.push('PGID (required as <TranRefNo>)');
  return missing;
}

/**
 * The Receipt block's two date elements, as FG write them on a real
 * post-payment issuance: `dd/MM/yyyy HH:mm:ss`.
 *
 * Their sources disagree. The FHA field table says "dd/MM/yyyy", Min Len 10,
 * Max Len 10, and the kit's Postman sample sends "03/02/2025". But the issuance
 * payload FG supplied for a real gateway-settled payment sends
 * "16/04/2026 10:21:59" — and its TranRefNo (4039937676717898095) is a
 * PayU-family reference, i.e. exactly the case this code is in.
 *
 * A payment has a time as well as a date, and the reference nearest to our own
 * situation carries it, so it is sent. FG_RECEIPT_DATE_WITH_TIME=false falls
 * back to the documented 10-character form without a code change.
 */
function receiptStamp(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  if (config.fg.receiptDateWithTime === false) return date;
  return `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export {
  assertPaymentConfigured,
  buildPaymentRequest,
  paymentChecksum,
  checksumInput,
  gatewayUrl,
  decryptPaymentResponse,
  restoreBase64,
  parsePaymentReturn,
  issuanceBlockers,
  receiptStamp,
  fgError,
};
