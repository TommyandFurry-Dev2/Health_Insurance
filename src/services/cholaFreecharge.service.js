import config, { missingCholaFreechargeVariables } from '../config/env.js';
import { requestChola } from './cholaHttp.service.js';
import {
  authError, configError, upstreamError, parseError, isEmptyBody, safeHeaders, safeJson, trunc,
} from '../helpers/chola.helper.js';
import { epochSeconds, formatAmount } from '../helpers/cholaFreecharge.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Freecharge (FCPG) through Chola MS's gateway — one function per request in
// Chola's "Free Charge APIs" Postman collection, plus the OAuth2 token they
// all ride on:
//
//   Token        POST {token URL}                       Basic, grant_type=client_credentials
//   encrypt      POST /endpoint/free-charge/v1/crypto/encrypt        the checkout request → encData
//   decrypt      POST /endpoint/free-charge/v1/crypto/decrypt        { clientId, encData } → the payload
//   txnStatus    POST /endpoint/free-charge/v1/checkout/txn/status   { merchantId, merchantTxnId, txnReferenceId }
//   createPayLink POST /endpoint/free-charge/v1/paylinkqr/create
//   payLinkStatus POST /endpoint/free-charge/v1/payment/link/status  { entityId, entityTxnId }
//   refund       POST /endpoint/free-charge/v1/refund
//
// Chola's wrapper does FCPG's signing and JWS+JWE encryption with the
// merchant's keys, so this service holds no Freecharge key: it sends the
// collection's plain JSON and reads plain JSON back.
//
// The token is a SEPARATE OAuth2 client from the product APIs'
// (cholaAuth.service.js): the product client is refused on these paths with
// 900908 "API Subscription validation failed". Same cache behaviour as that
// one — reused until CHOLA_TOKEN_SKEW_SECONDS before expiry, refreshed once
// after a 401, concurrent callers sharing one request.
//
// Never logged: the token, the client secret or the Basic value. Bodies only
// under CHOLA_DEBUG=1 — a decrypted callback names the buyer's payment.
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  token: null,
  expiryMs: 0,
  inflight: null,
};

/** Refuse the call, naming what is missing, unless the Freecharge leg is configured. */
function assertFreechargeConfigured() {
  const missing = missingCholaFreechargeVariables();
  if (missing.length) {
    throw configError(`Chola Freecharge payments are not configured. Missing: ${missing.join(', ')}`, {
      details: { missing },
    });
  }
}

function tokenEndpoint() {
  const fc = config.chola.freecharge;
  return fc.tokenUrl || `${fc.baseUrl}${fc.paths.token}`;
}

/** The Basic credential: CHOLA_FREECHARGE_BASIC_AUTH as issued, or base64(id:secret). */
function basicCredential() {
  const fc = config.chola.freecharge;
  if (fc.basicAuth) return String(fc.basicAuth).replace(/^Basic\s+/i, '').trim();
  return Buffer.from(`${fc.clientId}:${fc.clientSecret}`, 'utf8').toString('base64');
}

function tokenIsValid() {
  const skew = (config.chola.tokenSkewSeconds || 60) * 1000;
  return Boolean(state.token) && Date.now() < state.expiryMs - skew;
}

/** A valid bearer token for the Freecharge APIs, fetching or refreshing as needed. */
async function getFreechargeToken({ force = false } = {}) {
  if (!force && tokenIsValid()) return state.token;
  if (state.inflight) return state.inflight;
  state.inflight = fetchToken().finally(() => { state.inflight = null; });
  return state.inflight;
}

/** Forget the cached token. For tests and for an operator-driven rotation. */
function resetFreechargeToken() {
  state.token = null;
  state.expiryMs = 0;
  state.inflight = null;
}

async function fetchToken() {
  assertFreechargeConfigured();
  const res = await requestChola({
    opName: 'freecharge.token',
    method: 'POST',
    url: tokenEndpoint(),
    headers: { Authorization: `Basic ${basicCredential()}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'grant_type=client_credentials',
    maxRetries: 1,
    logBody: false,
  });

  const body = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  if (res.status < 200 || res.status >= 300 || !body || !body.access_token) {
    console.error(
      `❌ [chola] Freecharge token request refused — HTTP ${res.status}`
      + `${body?.error ? `, error "${body.error}"` : ''}`
      + `${body?.error_description ? `, "${body.error_description}"` : ''}`
    );
    throw authError('Chola Freecharge token request failed', {
      details: { httpStatus: res.status, body: trunc(body, 300) },
    });
  }

  state.token = body.access_token;
  const ttl = Number(body.expires_in) || 3600;
  state.expiryMs = Date.now() + ttl * 1000;
  console.log(`[chola] obtained Freecharge OAuth2 token — expires in ${ttl}s`);
  return state.token;
}

// WSO2's own refusals carry a six-digit 900xxx code: { code, message,
// description }. They are about our client (subscription, credentials,
// throttling), never about a payment.
function gatewayRefusal(body) {
  return body && typeof body === 'object' && /^9\d{5}$/.test(String(body.code ?? '')) ? body : null;
}

/**
 * One authenticated Freecharge call. Bearer injected; a 401 refreshes the token
 * once and replays once.
 *
 * Does NOT throw on an FCPG outcome: FCPG answer business results with a
 * statusCode in the body — some with HTTP 500 (payment/link/status answers
 * "Link data not found" that way) — so any body carrying a statusCode comes
 * back with its HTTP status for the caller to read. What throws: transport
 * failures, the gateway's own 900xxx refusals, an empty body, and a non-2xx
 * with no statusCode.
 *
 * `maxRetries` 0 for anything that must not be sent twice (refund, pay link).
 *
 * @returns {Promise<{ status:number, body:any, exchange:object, correlationId:string }>}
 */
async function callFreecharge({
  operation, path, body, maxRetries, context = null,
}) {
  assertFreechargeConfigured();
  const url = `${config.chola.freecharge.baseUrl}${path}`;
  let sentHeaders = null;

  const send = (token) => {
    sentHeaders = { 'Content-Type': 'application/json', Accept: '*/*', Authorization: `Bearer ${token}` };
    return requestChola({
      opName: `freecharge.${operation}`,
      method: 'POST',
      url,
      headers: sentHeaders,
      data: body,
      ...(maxRetries !== undefined ? { maxRetries } : {}),
      context,
    });
  };
  const exchangeOf = (res) => ({
    url,
    method: 'POST',
    requestHeaders: safeHeaders(sentHeaders),
    requestBody: body ?? null,
    attempts: res?.attempts ?? null,
    responseStatus: res?.status ?? null,
    responseBody: res ? (typeof res.data === 'string' ? safeJson(res.data) ?? res.data : res.data) : null,
  });

  let res;
  try {
    res = await send(await getFreechargeToken());
    if (res.status === 401) {
      console.log(`[chola] Freecharge ${operation} answered 401 — refreshing token and retrying once`);
      res = await send(await getFreechargeToken({ force: true }));
    }
  } catch (error) {
    if (sentHeaders && !error.exchange) error.exchange = exchangeOf(error.response);
    throw error;
  }

  const exchange = exchangeOf(res);
  const parsed = exchange.responseBody;
  const refusal = gatewayRefusal(parsed);
  if (refusal) {
    const make = res.status === 401 || res.status === 403 ? authError : upstreamError;
    const error = make(`Chola's gateway refused Freecharge ${operation}: ${refusal.description || refusal.message || refusal.code}`, {
      details: { httpStatus: res.status, code: String(refusal.code), body: trunc(parsed) },
    });
    error.exchange = exchange;
    throw error;
  }
  if (isEmptyBody(parsed)) {
    const error = parseError(`Chola Freecharge ${operation} returned an empty body`, { details: { httpStatus: res.status } });
    error.exchange = exchange;
    throw error;
  }
  const hasStatusCode = parsed && typeof parsed === 'object' && parsed.statusCode;
  if ((res.status < 200 || res.status >= 300) && !hasStatusCode) {
    const error = upstreamError(`Chola Freecharge ${operation} returned HTTP ${res.status}`, {
      details: { httpStatus: res.status, body: trunc(parsed) },
    });
    error.exchange = exchange;
    throw error;
  }
  return { status: res.status, body: parsed, exchange, correlationId: res.correlationId };
}

const paths = () => config.chola.freecharge.paths;
const merchantId = () => config.chola.freecharge.merchantId;

/** crypto/encrypt — seals a checkout request (buildCheckoutRequest) into encData. */
function encrypt(payload) {
  return callFreecharge({
    operation: 'encrypt', path: paths().encrypt, body: payload, context: { merchantTxnId: payload?.merchantTxnId },
  });
}

/** crypto/decrypt — opens the { clientId, encData } FCPG post back to the callback URL. */
function decrypt({ clientId, encData }) {
  return callFreecharge({
    operation: 'decrypt', path: paths().decrypt, body: { clientId: clientId || merchantId(), encData },
  });
}

/**
 * checkout/txn/status — the authoritative outcome of one checkout. FCPG mark
 * txnReferenceId optional, so it is sent only when a callback has given us one.
 */
function txnStatus({ merchantTxnId, txnReferenceId = null }) {
  return callFreecharge({
    operation: 'txnStatus',
    path: paths().txnStatus,
    body: { merchantId: merchantId(), merchantTxnId, ...(txnReferenceId ? { txnReferenceId } : {}) },
    context: { merchantTxnId },
  });
}

/**
 * paylinkqr/create — the collection's body, with Chola's merchant as entityId
 * and a fresh timestamp. Not retried: a second create is a second link.
 */
function createPayLink(fields) {
  const body = {
    ...fields,
    entityId: merchantId(),
    timestamp: epochSeconds(),
    currency: fields?.currency || config.chola.freecharge.currency,
  };
  return callFreecharge({
    operation: 'payLinkCreate', path: paths().payLinkCreate, body, maxRetries: 0, context: { entityTxnId: body.entityTxnId },
  });
}

/** payment/link/status — by the entityTxnId the link was created with. */
function payLinkStatus({ entityTxnId }) {
  return callFreecharge({
    operation: 'payLinkStatus',
    path: paths().payLinkStatus,
    body: { entityId: merchantId(), entityTxnId },
    context: { entityTxnId },
  });
}

/** refund — the collection's body. Never retried: money goes back once. */
function refund({
  merchantRefundTxnId, txnReferenceId, refundAmount, refundType,
}) {
  return callFreecharge({
    operation: 'refund',
    path: paths().refund,
    body: {
      merchantId: merchantId(),
      merchantRefundTxnId,
      txnReferenceId,
      refundType,
      refundAmount: formatAmount(refundAmount),
      currency: config.chola.freecharge.currency,
    },
    maxRetries: 0,
    context: { merchantRefundTxnId },
  });
}

export {
  assertFreechargeConfigured,
  tokenEndpoint,
  getFreechargeToken,
  resetFreechargeToken,
  callFreecharge,
  encrypt,
  decrypt,
  txnStatus,
  createPayLink,
  payLinkStatus,
  refund,
};
