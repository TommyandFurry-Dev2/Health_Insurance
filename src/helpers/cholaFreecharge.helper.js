import crypto from 'node:crypto';

import {
  CHOLA_FREECHARGE_STATUS, FREECHARGE_SUCCESS_CODE, FREECHARGE_PENDING_CODES, FREECHARGE_REQUEST_ERROR_CODES,
} from '../constants/chola.constants.js';
import { parseError, upstreamError, safeJson } from './chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Freecharge (FCPG) through Chola — the pure half: request builders, response
// readers and the status verdict. No I/O lives here; the calls are
// services/cholaFreecharge.service.js and the flow
// services/cholaFreechargePayment.service.js.
//
// Where each rule comes from:
//   * request fields         Chola's "Free Charge APIs" Postman collection
//   * merchantTxnId charset  FCPG checkout API (^[a-zA-Z0-9_-]+$, max 30)
//   * { clientId, encData }  FCPG encryption doc — the envelope of every
//                            encrypted request, response and callback
//   * status codes           FCPG's published table (constants)
// ─────────────────────────────────────────────────────────────────────────────

const { SUCCESS, PENDING, FAILED } = CHOLA_FREECHARGE_STATUS;

// A JWS compact serialisation: what FCPG call encData ("JWS + JWE web token").
const JWS = /^[\w-]+\.[\w-]+\.[\w-]+$/;

/**
 * A fresh FCPG transaction id for one attempt on a proposal:
 * `<prefix><proposal>-<time><random>`, at most 30 characters of FCPG's charset.
 * Every attempt gets a new one — FCPG refuse a repeated merchantTxnId
 * (SPG-0047) — and the proposal stays readable in it for reconciliation.
 */
function newMerchantTxnId(proposalNo, prefix = 'NC', now = Date.now()) {
  const tail = `${now.toString(36)}${crypto.randomBytes(2).toString('hex')}`.toUpperCase();
  const room = 30 - prefix.length - 1 - tail.length;
  const proposal = String(proposalNo).replace(/[^a-zA-Z0-9]/g, '').slice(-room);
  return `${prefix}${proposal}-${tail}`;
}

/** The opaque reference a return page reads a payment by. Not guessable. */
function newReturnToken() {
  return crypto.randomBytes(16).toString('hex');
}

/** "8856.4" → "8856.40": FCPG take amounts as decimal strings. */
function formatAmount(amount) {
  return Number(amount).toFixed(2);
}

/** The same amount to the paisa. */
function sameAmount(a, b) {
  const x = Number(a);
  const y = Number(b);
  return Number.isFinite(x) && Number.isFinite(y) && Math.round(x * 100) === Math.round(y * 100);
}

/** FCPG's timestamp: epoch SECONDS, as the collection sends it. */
function epochSeconds(now = Date.now()) {
  return String(Math.floor(now / 1000));
}

/**
 * The checkout request Chola's crypto/encrypt seals — the collection's fields,
 * nothing added. No `signature`: FCPG require one inside the encrypted payload,
 * and Chola's wrapper is what holds the merchant's key to make it.
 */
function buildCheckoutRequest({
  merchantId, merchantTxnId, amount, proposalNo, callbackUrl, currency, now,
}) {
  return {
    merchantId,
    merchantTxnId,
    merchantTxnAmount: formatAmount(amount),
    timestamp: epochSeconds(now),
    merchantOrderId: String(proposalNo),
    callbackUrl,
    currency,
  };
}

/**
 * The callback URL with our reference on it, so a callback can be matched to
 * its payment even when its body cannot be read.
 */
function withReference(url, ref) {
  const parsed = new URL(url);
  parsed.searchParams.set('ref', ref);
  return parsed.toString();
}

function keysOf(value) {
  return value && typeof value === 'object' ? Object.keys(value) : typeof value;
}

/**
 * encData out of crypto/encrypt's answer. The collection saved no response for
 * it, so the shape is read the way FCPG document their envelope —
 * { clientId, encData } — then under a `data` wrapper, then a bare token. Only
 * a JWS-shaped value is accepted: anything else would send the buyer to FCPG
 * with a payload they cannot open.
 */
function readEncrypted(body) {
  const parsed = typeof body === 'string' ? (safeJson(body) ?? body) : body;
  if (typeof parsed === 'string') {
    if (JWS.test(parsed.trim())) return { encData: parsed.trim(), clientId: null };
  } else if (parsed && typeof parsed === 'object') {
    for (const holder of [parsed, parsed.data]) {
      if (holder && typeof holder === 'object' && typeof holder.encData === 'string' && JWS.test(holder.encData.trim())) {
        return { encData: holder.encData.trim(), clientId: holder.clientId ?? null };
      }
    }
    if (typeof parsed.data === 'string' && JWS.test(parsed.data.trim())) return { encData: parsed.data.trim(), clientId: null };
    // FCPG's own refusal: a status code and a sentence instead of a token.
    if (parsed.statusCode && parsed.statusCode !== FREECHARGE_SUCCESS_CODE) {
      throw upstreamError(`Freecharge refused the checkout: ${parsed.statusMessage || parsed.statusCode}`, {
        details: { statusCode: parsed.statusCode, statusMessage: parsed.statusMessage ?? null },
      });
    }
  }
  throw parseError('Chola Freecharge encrypt answered no encData', { details: { keys: keysOf(parsed) } });
}

function text(value) {
  if (value === undefined || value === null || value === '') return null;
  return String(value);
}

function amountOf(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * A decrypted callback or a txn/status answer, flattened. FCPG document
 * { statusCode, statusMessage, data: { merchantTxnId, txnReferenceId, amount,
 * … } }; a flat body, or one that arrives as a JSON string, reads the same.
 */
function readResult(body) {
  const parsed = typeof body === 'string' ? safeJson(body) : body;
  const top = parsed && typeof parsed === 'object' ? parsed : {};
  const data = top.data && typeof top.data === 'object' ? top.data : {};
  const pick = (...keys) => {
    for (const key of keys) {
      for (const source of [data, top]) {
        const value = source[key];
        if (value !== undefined && value !== null && value !== '') return value;
      }
    }
    return null;
  };
  return {
    statusCode: text(top.statusCode ?? data.statusCode),
    statusMessage: text(top.statusMessage ?? data.statusMessage),
    merchantTxnId: text(pick('merchantTxnId')),
    txnReferenceId: text(pick('txnReferenceId')),
    merchantOrderId: text(pick('merchantOrderId')),
    amount: amountOf(pick('amount', 'merchantTxnAmount')),
    currency: text(pick('currency')),
    txnType: text(pick('txnType')),
    txnMode: text(pick('txnMode')),
    txnSubMode: text(pick('txnSubMode')),
    errorCode: text(pick('errorCode')),
    errorDescription: text(pick('errorDescription')),
  };
}

/**
 * FCPG's verdict for a status code, by their table: SPG-0000 SUCCESS, the
 * PENDING codes PENDING, every other code FAILED — except the codes that only
 * say OUR request was refused, and no code at all, which are PENDING: they
 * say nothing about whether the buyer paid.
 */
function verdictOf(statusCode) {
  if (statusCode === FREECHARGE_SUCCESS_CODE) return SUCCESS;
  if (!statusCode || FREECHARGE_PENDING_CODES.has(statusCode) || FREECHARGE_REQUEST_ERROR_CODES.has(statusCode)) {
    return PENDING;
  }
  return FAILED;
}

/**
 * What a txn/status answer (with the callback, when one arrived) says about a
 * payment row. SUCCESS only when FCPG said SPG-0000 for this transaction and
 * the amount paid is the amount asked, with a txnReferenceId to tag
 * PolicyGeneration with; anything that does not add up is NEEDS_REVIEW, never
 * a policy.
 *
 * @param {object} p
 * @param {object} p.row       the payment row (merchant_txn_id, amount)
 * @param {object|null} p.status    readResult of txn/status, null when it could not be asked
 * @param {object|null} p.callback  readResult of the decrypted callback, if any
 * @param {Error|null}  p.error     why txn/status could not be asked
 */
function decidePayment({
  row, status, callback = null, error = null,
}) {
  const fromCallback = callback ? verdictOf(callback.statusCode) : null;
  if (!status) {
    return {
      status: PENDING,
      statusCode: null,
      statusMessage: `Freecharge could not be asked for the status: ${error?.message || 'no answer'}`,
    };
  }
  const base = {
    statusCode: status.statusCode,
    statusMessage: status.statusMessage,
    txnReferenceId: status.txnReferenceId || callback?.txnReferenceId || null,
    txnMode: status.txnMode || callback?.txnMode || null,
    txnSubMode: status.txnSubMode || callback?.txnSubMode || null,
  };
  const verdict = verdictOf(status.statusCode);

  if (verdict === SUCCESS) {
    const review = (why) => ({ ...base, status: CHOLA_FREECHARGE_STATUS.NEEDS_REVIEW, statusMessage: why });
    if (status.merchantTxnId && status.merchantTxnId !== row.merchant_txn_id) {
      return review(`txn/status answered SUCCESS for ${status.merchantTxnId}, not ${row.merchant_txn_id}.`);
    }
    const paid = status.amount ?? callback?.amount ?? null;
    if (paid === null) return review('Freecharge said SUCCESS but gave no amount to check against the premium.');
    if (!sameAmount(paid, row.amount)) {
      return { ...review(`Freecharge collected ${formatAmount(paid)}, but the premium is ${formatAmount(row.amount)}.`), paidAmount: paid };
    }
    if (!base.txnReferenceId) return { ...review('Freecharge said SUCCESS but gave no txnReferenceId to tag the policy with.'), paidAmount: paid };
    return { ...base, status: SUCCESS, paidAmount: paid };
  }
  if (verdict === FAILED) {
    if (fromCallback === SUCCESS) {
      return {
        ...base,
        status: CHOLA_FREECHARGE_STATUS.NEEDS_REVIEW,
        statusMessage: `The callback said SUCCESS but txn/status says ${status.statusCode} ${status.statusMessage || ''}`.trim(),
      };
    }
    return { ...base, status: FAILED };
  }
  return { ...base, status: PENDING };
}

export {
  newMerchantTxnId,
  newReturnToken,
  formatAmount,
  sameAmount,
  epochSeconds,
  buildCheckoutRequest,
  withReference,
  readEncrypted,
  readResult,
  verdictOf,
  decidePayment,
};
