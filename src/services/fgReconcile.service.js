import axios from 'axios';

import config from '../config/env.js';
import {
  upstreamError, parseError, escapeXml, buildFgExchange, textOf, num,
} from '../helpers/fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// FG's Common Reconciliation Service — FetchTRNDetails.
//
// This is the server-to-server confirmation of a payment, and FG describe it as
// a SECURITY measure rather than a bookkeeping one (NewPaymentIntegration
// v1.39, "PAYMENT PROCESS"):
//
//   "As a recommended security measure, you validate each transaction response
//    via an API call. Transaction revalidation protects from request/response
//    tampering possible in browser calls."
//
// ── Why this integration in particular needs it ─────────────────────────────
// The payment outcome reaches this service as a form POST to a PUBLIC route,
// and the DES key that encrypts it is printed in FG's own integration PDF — the
// same key for every FG partner. The ciphertext therefore authenticates
// nothing: possession of the kit is enough to produce a well-formed
// `Response=Success` for any TransactionID.
//
// The remaining obstacle is that issuance only proceeds for a TransactionID
// this service is holding a proposal against — which is exactly what a buyer
// who started a payment and abandoned it has. Revalidating against FG closes
// that: their answer is the one part of the exchange an attacker cannot forge.
//
// ── The contract, verbatim from v1.39 ───────────────────────────────────────
//   POST {FG_RECONCILE_URL}
//   <FetchTRNDetails xmlns="http://tempuri.org/">
//     <transactionId>T497555205</transactionId>
//     <source>webaggregator</source>
//   </FetchTRNDetails>
//
//   <Response xmlns="http://tempuri.org/">
//     <validationError/><exceptionError/>
//     <listQuickPayFields><QuickPayField>
//       <TransactionStatus>Success</TransactionStatus>
//       <PaymentAmount>2530</PaymentAmount>
//       <TransactionId>T497555205</TransactionId>
//       <PGTransactionID>18387194847</PGTransactionID>
//       <AuthCode>009274</AuthCode>
//       <FG_Transaction_ID>TD960044</FG_Transaction_ID>
//       …
//     </QuickPayField></listQuickPayFields>
//   </Response>
//
// Note this is a plain ASMX service on a DIFFERENT host from the BO service and
// with a different envelope — it is not the TCS Health service and does not
// share its configuration.
// ─────────────────────────────────────────────────────────────────────────────

/** Is revalidation configured at all? */
function isConfigured() {
  return Boolean(config.fg.payment.reconcileUrl);
}

function buildEnvelope(transactionId, source) {
  return (
    '<?xml version="1.0" encoding="utf-8"?>'
    + '<soap:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
    + 'xmlns:xsd="http://www.w3.org/2001/XMLSchema" '
    + 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">'
    + '<soap:Body>'
    + '<FetchTRNDetails xmlns="http://tempuri.org/">'
    + `<transactionId>${escapeXml(transactionId)}</transactionId>`
    + `<source>${escapeXml(source)}</source>`
    + '</FetchTRNDetails>'
    + '</soap:Body>'
    + '</soap:Envelope>'
  );
}

/**
 * Pull one element's text out of the response.
 *
 * Deliberately a regex rather than a parser: FG's own documented sample answer
 * contains a stray `<script>window._wordtune_extension_installed = true;</script>`
 * — a browser extension contaminated the document their integration team
 * published — and a strict parser is entitled to reject that. Reading the
 * elements individually survives it, and survives whatever else is wrapped
 * around them.
 */
function pick(xml, element) {
  const match = xml.match(new RegExp(`<${element}[^>]*>([\\s\\S]*?)</${element}>`, 'i'));
  return match ? match[1].trim() : null;
}

/**
 * Normalise FG's answer.
 *
 * @returns {{
 *   found: boolean, succeeded: boolean, status: string|null,
 *   paymentAmount: number|null, transactionId: string|null,
 *   pgTransactionId: string|null, fgTransactionId: string|null,
 *   authCode: string|null, transactionDate: string|null,
 *   paymentGateway: string|null, validationError: string|null,
 *   exceptionError: string|null,
 * }}
 */
function parseReconcileResponse(xml) {
  if (!xml || typeof xml !== 'string') {
    throw parseError('The Future Generali reconciliation service returned an empty response');
  }

  const validationError = pick(xml, 'validationError');
  const exceptionError = pick(xml, 'exceptionError');

  // No QuickPayField at all means FG hold no such transaction. That is a
  // definite answer — "this payment did not happen" — and is exactly what a
  // forged callback produces.
  const field = xml.match(/<QuickPayField>([\s\S]*?)<\/QuickPayField>/i);
  if (!field) {
    return {
      found: false,
      succeeded: false,
      status: null,
      paymentAmount: null,
      transactionId: null,
      pgTransactionId: null,
      fgTransactionId: null,
      authCode: null,
      transactionDate: null,
      paymentGateway: null,
      validationError: validationError || null,
      exceptionError: exceptionError || null,
    };
  }

  const block = field[1];
  const status = pick(block, 'TransactionStatus');

  return {
    found: true,
    succeeded: /^success$/i.test(String(status || '').trim()),
    status: status || null,
    paymentAmount: num(pick(block, 'PaymentAmount')),
    transactionId: pick(block, 'TransactionId'),
    pgTransactionId: pick(block, 'PGTransactionID'),
    fgTransactionId: pick(block, 'FG_Transaction_ID'),
    authCode: pick(block, 'AuthCode'),
    transactionDate: pick(block, 'TransactionDate'),
    paymentGateway: pick(block, 'PaymentGateway'),
    validationError: validationError || null,
    exceptionError: exceptionError || null,
  };
}

/**
 * Ask FG what really happened to a transaction.
 *
 * @param {string} transactionId the TransactionID posted to the gateway, which
 *   FG echo back as TID on the callback
 * @returns {Promise<{data: object, exchange: object, httpStatus: number}>}
 * @throws when FG cannot be reached or answer unreadably — the caller must
 *   treat that as UNKNOWN, never as a failed payment.
 */
async function fetchTransactionDetails(transactionId) {
  if (!isConfigured()) {
    throw upstreamError(
      'Future Generali transaction revalidation is not configured. Set FG_RECONCILE_URL.',
      { missing: ['FG_RECONCILE_URL'] }
    );
  }

  const url = config.fg.payment.reconcileUrl;
  const source = config.fg.payment.reconcileSource;
  const body = buildEnvelope(transactionId, source);
  const headers = {
    'Content-Type': 'text/xml; charset=utf-8',
    SOAPAction: 'http://tempuri.org/FetchTRNDetails',
  };

  let response;
  try {
    response = await axios.post(url, body, {
      headers,
      timeout: config.timeouts.fg,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
  } catch (error) {
    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    const wrapped = upstreamError(
      timedOut
        ? `Future Generali transaction revalidation timed out after ${config.timeouts.fg}ms`
        : `Future Generali transaction revalidation failed: ${error.message}`,
      { errorCode: error.code || null, endpoint: url }
    );
    if (timedOut) {
      wrapped.status = 504;
      wrapped.code = 'FG_TIMEOUT_ERROR';
    }
    wrapped.exchange = buildFgExchange({ url, headers, body, error });
    throw wrapped;
  }

  const text = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const exchange = buildFgExchange({ url, headers, body, response });

  if (response.status < 200 || response.status >= 300) {
    const error = upstreamError(
      `Future Generali transaction revalidation returned HTTP ${response.status}`,
      { httpStatus: response.status, endpoint: url, snippet: text.slice(0, 300) }
    );
    error.exchange = exchange;
    throw error;
  }

  let data;
  try {
    data = parseReconcileResponse(text);
  } catch (error) {
    error.exchange = exchange;
    throw error;
  }

  console.log(
    `[fg] transaction revalidated — id=${transactionId} found=${data.found} `
    + `status=${data.status} amount=${data.paymentAmount}`
  );

  return { data, exchange, httpStatus: response.status };
}

/**
 * Decide whether a callback may be trusted enough to issue against.
 *
 * Three outcomes, and the third is the point of the whole exercise:
 *
 *   verified   — FG confirm a successful transaction for this id, for an amount
 *                that matches what was collected. Issue.
 *   rejected   — FG say it did not succeed, do not hold it at all, or hold it
 *                for a DIFFERENT amount. Do not issue: this is either a failed
 *                payment or a tampered one, and both must be refused.
 *   unknown    — FG could not be reached or could not be read. NOT a rejection:
 *                the money may well have moved. The caller must fall back to
 *                its own judgement and say so, never silently treat it as
 *                either outcome.
 *
 * @param {object} p
 * @param {object} p.result       the parsed callback (wsPId, pgid, transactionId, premium)
 * @param {number|string} [p.expectedAmount] what the buyer was asked to pay
 */
async function verifyPayment({ result, expectedAmount }) {
  const transactionId = result?.transactionId;

  if (!transactionId) {
    return {
      outcome: 'unknown',
      reason: 'the callback carried no TransactionID (TID), so there is nothing to revalidate',
      details: null,
    };
  }

  let details;
  try {
    ({ data: details } = await fetchTransactionDetails(transactionId));
  } catch (error) {
    return {
      outcome: 'unknown',
      reason: `Future Generali could not be asked to confirm this transaction: ${error.message}`,
      details: null,
    };
  }

  if (!details.found) {
    return {
      outcome: 'rejected',
      reason: 'Future Generali hold no transaction with this id. The payment callback claimed a '
        + 'successful payment that Future Generali have no record of.',
      details,
    };
  }

  if (!details.succeeded) {
    return {
      outcome: 'rejected',
      reason: `Future Generali report this transaction as "${details.status}", not a success.`,
      details,
    };
  }

  const expected = Number(expectedAmount);
  const paid = Number(details.paymentAmount);
  if (Number.isFinite(expected) && Number.isFinite(paid)) {
    const tolerance = config.fg.payment.reconcileAmountTolerance;
    if (Math.abs(paid - expected) > tolerance) {
      return {
        outcome: 'rejected',
        reason: `Future Generali report ${paid} collected against ${expected} expected — a `
          + `difference of ${Math.abs(paid - expected).toFixed(2)}, beyond the ${tolerance} `
          + 'tolerance. Treated as tampering and refused.',
        details,
      };
    }
  }

  return { outcome: 'verified', reason: null, details };
}

export {
  isConfigured,
  fetchTransactionDetails,
  verifyPayment,
  parseReconcileResponse,
  buildEnvelope,
};
