import config, { missingCholaVariables } from '../config/env.js';
import { requestChola } from './cholaHttp.service.js';
import { getCholaToken } from './cholaAuth.service.js';
import { CHOLA_PRODUCTS, CHOLA_DEFAULT_PRODUCT } from '../constants/chola.constants.js';
import {
  validationError, upstreamError, parseError, configError,
  requireFields, extractPremium, extractProposal, extractSchedule, envelope, rewriteUrl,
  isEmptyBody, safeHeaders, safeJson, trunc,
} from '../helpers/chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transport for Chola MS's product APIs, plus the operations that ride on it.
//
// A port of the working implementation's CholaClient (callChola below) and
// CholaAdapter (the operations), with business behaviour kept exactly: the
// same required fields, the same FLEXI_HEALTH default, the same IntermediaryCode
// injection, the caller's body forwarded untouched otherwise, the same response
// normalisation and the same error codes and messages. What changed is only
// what the target architecture asks for — configuration through config/env.js
// with no bundled host, console logging in this service's format, and the
// exchange returned beside the answer for the controller.
//
//   getQuote        → PremiumComputation   IntermediaryCode injected
//   createProposal  → ProposalSave         IntermediaryCode injected; returns
//                                          GENCONProposalNumber + re-priced premium
//   policySchedule  → PolicySchedule       by POLICY number
//
// PolicyGeneration — the website's and the backend-built one — lives in
// cholaPolicyIssuer.service.js, because both paths share the evidence log and
// the APD path claims the proposal before anything is sent. CKYC is
// cholaCkyc.service.js.
//
// The three products (FLEXI_HEALTH, SUPREME, SUPER_TOPUP) share the flow but
// have different request field sets, so the caller's body is forwarded as-is
// and `product` only picks the endpoint path.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The variables without which no product call can be made. Checked per call
 * rather than at boot so a Chola-less deployment still starts and serves every
 * other insurer — only the /chola-ms endpoints answer 503.
 */
function assertConfigured() {
  const missing = missingCholaVariables();
  if (missing.length) {
    throw configError(`Chola is not configured. Missing: ${missing.join(', ')}`, { details: { missing } });
  }
}

/** The product key a request names, FLEXI_HEALTH when it names none. */
function resolveProduct(input) {
  const key = (input && input.product) || CHOLA_DEFAULT_PRODUCT;
  if (!CHOLA_PRODUCTS[key]) {
    throw validationError(`Unknown Chola product "${key}". Known: ${Object.keys(CHOLA_PRODUCTS).join(', ')}`, { field: 'product' });
  }
  return key;
}

/** IntermediaryCode from config when the caller sent none — the caller's own wins. */
function withIntermediary(body) {
  if (body && body.IntermediaryCode == null && config.chola.intermediaryCode) {
    return { IntermediaryCode: config.chola.intermediaryCode, ...body };
  }
  return body;
}

/**
 * The URL for a product operation — the only place a Chola product URL is built.
 *   {CHOLA_BASE_URL}/endpoint/<productPath>/v1.0.0/<Operation>
 * except Super Topup's ProposalSave, which is the absolute
 * CHOLA_TOPUP_PROPOSAL_URL.
 */
function endpointFor(productKey, operation) {
  const product = CHOLA_PRODUCTS[productKey];
  if (!product) throw configError(`Unknown Chola product "${productKey}"`);
  if (productKey === 'SUPER_TOPUP' && operation === 'ProposalSave') {
    if (!config.chola.topupProposalUrl) {
      throw configError('CHOLA_TOPUP_PROPOSAL_URL is not set (Super Topup ProposalSave host)');
    }
    return config.chola.topupProposalUrl;
  }
  if (!config.chola.baseUrl) throw configError('CHOLA_BASE_URL is not set');
  const path = config.chola.paths.product
    .replace('{product}', product.path)
    .replace('{operation}', operation);
  return `${config.chola.baseUrl}${path}`;
}

/** A Chola link with its host rewritten to CHOLA_PUBLIC_URL_BASE, if set. */
function publicUrl(url) {
  return rewriteUrl(url, config.chola.publicUrlBase);
}

/**
 * What went upstream beside what came back, for the controller to return and
 * audit. The Bearer token is reduced to its length by safeHeaders.
 */
function buildCholaExchange({ url, headers, body, attempts, response }) {
  return {
    url,
    method: 'POST',
    requestHeaders: safeHeaders(headers),
    requestBody: body ?? null,
    attempts: attempts ?? null,
    responseStatus: response?.status ?? null,
    responseBody: response?.data ?? null,
  };
}

/**
 * One request/response pair, as EVIDENCE for health_chola_policy_generation_logs
 * — the working implementation's exchange(), unchanged. The Authorization
 * header is replaced outright: a bearer token in a log table is a live
 * credential until it expires, and nobody reading the evidence needs any part
 * of it. The body is the JSON text exactly as sent, and the response the raw
 * text exactly as received.
 */
function evidenceOf({ productKey, operation, url, data, startedAt, res, error }) {
  return {
    productKey,
    operation,
    url,
    method: 'POST',
    requestHeaders: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ***MASKED***' },
    requestBody: JSON.stringify(data),
    httpStatus: res ? res.status : null,
    responseBody: res ? rawText(res.data) : null,
    correlationId: res ? res.correlationId : null,
    error: error ? { code: error.code || null, message: error.message } : null,
    durationMs: Date.now() - startedAt,
    at: new Date(startedAt),
  };
}

function rawText(value) {
  if (value == null) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/**
 * One authenticated Chola product call — the working implementation's
 * CholaClient.call, unchanged in behaviour:
 *
 *   * Bearer token injected; on a 401 the token is refreshed ONCE and the call
 *     replayed once
 *   * a string body is parsed as JSON when it is JSON
 *   * non-2xx       → UPSTREAM_ERROR "Chola <op> returned HTTP <n>"
 *   * empty body    → PARSE_ERROR (a blank 200 is not an all-null success)
 *
 * `maxRetries` overrides CHOLA_MAX_RETRIES for this call — 0 for anything that
 * must not be sent twice. `timeoutMs` overrides CHOLA_API_TIMEOUT_MS.
 *
 * `onExchange`, when given, is awaited once per request actually sent (the
 * re-send after a 401 included) with the evidence above. The response is kept
 * as raw text for that call so it can be shown to Chola byte for byte.
 *
 * @returns {Promise<{ data:any, status:number, correlationId:string, exchange:object }>}
 */
async function callChola({
  productKey, operation, body, maxRetries, timeoutMs, onExchange,
}) {
  const url = endpointFor(productKey, operation);
  const data = body ?? {};
  const context = {
    product: productKey,
    proposal: data.GenconProposalNumber,
    policy: data.GenconPolicyNumber,
  };
  let sentHeaders = null;

  const send = async (token) => {
    const startedAt = Date.now();
    sentHeaders = { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` };
    let res;
    try {
      res = await requestChola({
        opName: `${productKey}.${operation}`,
        method: 'POST',
        url,
        headers: sentHeaders,
        data,
        maxRetries: maxRetries ?? config.chola.maxRetries,
        ...(timeoutMs ? { timeoutMs } : {}),
        // Raw text in, parsed below — the same parse axios would have done.
        ...(onExchange ? { transformResponse: [(d) => d] } : {}),
        context,
      });
    } catch (error) {
      if (onExchange) {
        await onExchange(evidenceOf({ productKey, operation, url, data, startedAt, error }));
      }
      throw error;
    }
    if (onExchange) {
      await onExchange(evidenceOf({ productKey, operation, url, data, startedAt, res }));
    }
    return res;
  };

  let res;
  try {
    let token = await getCholaToken();
    res = await send(token);
    if (res.status === 401) {
      console.log(`[chola] ${productKey}.${operation} answered 401 — refreshing token and retrying once`);
      token = await getCholaToken({ force: true });
      res = await send(token);
    }
  } catch (error) {
    // Transport exhausted, token refused, or configuration missing. The
    // exchange is attached when a request was actually formed.
    if (sentHeaders && !error.exchange) {
      error.exchange = buildCholaExchange({
        url, headers: sentHeaders, body: data, attempts: error.attempts, response: error.response,
      });
    }
    throw error;
  }

  const exchange = buildCholaExchange({
    url, headers: sentHeaders, body: data, attempts: res.attempts, response: res,
  });
  const parsed = typeof res.data === 'string' ? safeJson(res.data) ?? res.data : res.data;

  if (res.status < 200 || res.status >= 300) {
    logRejection(`${productKey}.${operation}`, url, res.status, parsed);
    const error = upstreamError(`Chola ${operation} returned HTTP ${res.status}`, {
      details: { httpStatus: res.status, body: trunc(parsed) },
    });
    error.exchange = exchange;
    throw error;
  }
  if (isEmptyBody(parsed)) {
    const error = parseError(`Chola ${operation} returned an empty body`, {
      details: { httpStatus: res.status },
    });
    error.exchange = exchange;
    throw error;
  }

  return { data: parsed, status: res.status, correlationId: res.correlationId, exchange };
}

// Logged in full whether or not debug is on: the reason Chola refused a call
// lives in the body, not in the status — a WSO2 rejection carries a code like
// 900901, a WCF contract fault an ASP.NET "Request Error" page naming the field.
function logRejection(operation, url, status, data) {
  console.error('────────── Chola call REJECTED ───');
  console.error('operation    :', operation);
  console.error('URL          :', url);
  console.error('status       :', status);
  console.error('resp data    :', trunc(data, 800));
  console.error('──────────────────────────────────');
}

// ── Operations ──────────────────────────────────────────────────────────────
//
// Each resolves { result, exchange } — `result` is the envelope the working
// implementation returned, unchanged, and `exchange` is what the controller
// adds beside it.

/** PremiumComputation. Pricing only — nothing is created at Chola. */
async function getQuote(input = {}) {
  assertConfigured();
  const productKey = resolveProduct(input);
  const { product, ...rest } = input;
  const body = withIntermediary(rest);
  requireFields(body, ['InsuredMembers'], 'Chola PremiumComputation');
  const res = await callChola({ productKey, operation: 'PremiumComputation', body });
  const data = extractPremium(res.data);
  console.log(
    `[chola] quote parsed — product=${productKey} status=${data.status ?? null} `
    + `totalPremium=${data.totalPremium ?? null}`
  );
  return { result: envelope('getQuote', productKey, data, res), exchange: res.exchange };
}

/**
 * ProposalSave. Writes to Gencon and returns GENCONProposalNumber, which every
 * later step is keyed by — and Chola's RE-PRICED premium, which is the amount
 * PolicyGeneration must be tagged for.
 */
async function createProposal(input = {}) {
  assertConfigured();
  const productKey = resolveProduct(input);
  const { product, ...rest } = input;
  const body = withIntermediary(rest);
  const res = await callChola({ productKey, operation: 'ProposalSave', body });
  const data = extractProposal(res.data);
  console.log(
    `[chola] proposal parsed — product=${productKey} status=${data.status ?? null} `
    + `proposal=${data.genconProposalNumber ?? null} premium=${data.premium ?? null}`
  );
  return { result: envelope('createProposal', productKey, data, res), exchange: res.exchange };
}

/**
 * PolicySchedule — the policy document links for an ISSUED policy.
 *
 * Requires the POLICY number. A proposal number answers HTTP 200 with both
 * URLs empty rather than an error — even for a proposal whose policy has been
 * issued — so this cannot be used to discover a policy number.
 */
async function policySchedule(input = {}) {
  assertConfigured();
  const productKey = resolveProduct(input);
  const { product, ...rest } = input;
  requireFields(rest, ['GenconPolicyNumber'], 'Chola PolicySchedule');
  const res = await callChola({ productKey, operation: 'PolicySchedule', body: rest });
  const data = extractSchedule(res.data);
  data.scheduleUrl = publicUrl(data.scheduleUrl);
  data.customerInformationSheetUrl = publicUrl(data.customerInformationSheetUrl);
  return { result: envelope('policySchedule', productKey, data, res), exchange: res.exchange };
}

export {
  assertConfigured,
  resolveProduct,
  endpointFor,
  publicUrl,
  callChola,
  getQuote,
  createProposal,
  policySchedule,
};
