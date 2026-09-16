import config, { missingIciciVariables } from '../config/env.js';
import { requestIcici, isMultipart } from './iciciHttp.service.js';
import { getIciciToken } from './iciciAuth.service.js';
import { forAudit } from '../utils/sanitize.js';
import {
  ICICI_OPERATIONS, PRODUCT_CODES, STATUS_MASTER,
} from '../constants/icici.constants.js';
import {
  validationError, upstreamError, parseError, configError,
  requireFields, isEmpty, extractPremium, extractProposal, envelope, safeHeaders, safeJson, trunc,
} from '../helpers/icici.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transport for ICICI Lombard's "Elevate" business APIs, plus the operations
// that ride on it.
//
// A port of the working implementation's ElevateClient (callIcici below) and
// ElevateAdapter (the operations), with business behaviour kept exactly: the
// same required fields, the same ProductCode default, the same request bodies
// forwarded untouched, the same response normalisation and the same error
// codes and messages. What changed is only what the target architecture asks
// for — configuration through config/env.js with no bundled host, console
// logging in this service's format, and the exchange returned beside the
// answer for the controller.
//
//   getQuote        → premium            ProductCode defaulted to 18
//   createProposal  → proposal-payment   returns PaymentUrl + ProposalId
//   issuePolicy     → policy sync        partner-collected payment only
//   policyStatus    → proposal status    authoritative after a hosted payment
//   emiDue / processEmi / coi / zone
//
// CKYC and OVD live in iciciCkyc.service.js.
//
// ── IDs ─────────────────────────────────────────────────────────────────────
// ICICI mint the TransactionId (`bnc_…`) on PREMIUM, and every later call —
// CKYC, proposal, status, COI — is keyed by that same value. Nothing here
// generates, rewrites or substitutes it: callers send ICICI's own id back and
// it is forwarded verbatim. `txn_…` (the PGI id policy sync mints) and
// `kyc_…` (the CKYC KycID) are likewise ICICI's, never ours.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The variables without which no call can be made. Checked per call rather
 * than at boot so an ICICI-less deployment still starts and serves every other
 * insurer — only the /icici-lombard endpoints answer 503.
 */
function assertConfigured() {
  const missing = missingIciciVariables();
  if (missing.length) {
    throw configError(`Elevate is not configured. Missing: ${missing.join(', ')}`, { details: { missing } });
  }
}

/** `{ url, method }` for a named operation — the only place an ICICI URL is built. */
function endpointFor(operation, params = {}) {
  const op = ICICI_OPERATIONS[operation];
  if (!op) throw configError(`Unknown Elevate operation "${operation}"`);
  if (!config.icici.baseUrl) throw configError('EL_BASE_URL is not set');
  const path = config.icici.paths[op.pathKey]
    .replace('{clientname}', encodeURIComponent(params.clientname || config.icici.clientName || ''))
    .replace('{transactionId}', encodeURIComponent(params.transactionId || ''));
  return { url: `${config.icici.baseUrl}${path}`, method: op.method };
}

/**
 * What went upstream beside what came back, for the controller to return and
 * audit. The Bearer token is reduced to its length by safeHeaders, a multipart
 * body is named rather than serialised, and a binary answer is reported by size.
 */
function buildIciciExchange({ url, method, headers, body, attempts, response }) {
  const responseData = response?.data ?? null;
  return {
    url,
    method,
    requestHeaders: safeHeaders(headers),
    requestBody: isMultipart(body) ? '[multipart form-data]' : (body ?? null),
    attempts: attempts ?? null,
    responseStatus: response?.status ?? null,
    responseBody: Buffer.isBuffer(responseData) ? `[binary ${responseData.length} bytes]` : responseData,
  };
}

/**
 * One authenticated ICICI business call — the working implementation's
 * ElevateClient.call, unchanged in behaviour:
 *
 *   * Bearer token injected; on a 401 the token is refreshed ONCE and the call
 *     replayed once
 *   * a string body is parsed as JSON when it is JSON
 *   * non-2xx                → UPSTREAM_ERROR "Elevate <op> returned HTTP <n>"
 *   * `Success: false`       → UPSTREAM_ERROR carrying ICICI's own wording
 *   * empty body             → PARSE_ERROR
 *
 * @param {object} p
 * @param {string} p.operation
 * @param {object} [p.body]          JSON body (POST), or a form-data instance
 * @param {object} [p.params]        path params (COI)
 * @param {object} [p.headers]       extra headers (e.g. multipart)
 * @param {string} [p.responseType]  'arraybuffer' for endpoints that answer with
 *   a binary document rather than JSON (COI). Without it the PDF is decoded as
 *   text and silently corrupted.
 * @param {object} [p.context]       identifiers to print on the request line
 * @returns {Promise<{ data:any, status:number, correlationId:string, exchange:object }>}
 */
async function callIcici({ operation, body, params, headers, responseType, context }) {
  const { url, method } = endpointFor(operation, params);
  let sentHeaders = null;

  const send = async (token) => {
    sentHeaders = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...headers,
    };
    return requestIcici({
      opName: operation,
      method,
      url,
      headers: sentHeaders,
      data: method === 'GET' ? undefined : (body ?? {}),
      maxRetries: config.icici.maxRetries,
      ...(responseType ? { responseType } : {}),
      context,
    });
  };

  let res;
  try {
    let token = await getIciciToken();
    res = await send(token);
    if (res.status === 401) {
      console.log(`[icici] ${operation} answered 401 — refreshing token and retrying once`);
      token = await getIciciToken({ force: true });
      res = await send(token);
    }
  } catch (error) {
    // Transport exhausted, token refused, or configuration missing. The
    // exchange is attached when a request was actually formed.
    if (sentHeaders && !error.exchange) {
      error.exchange = buildIciciExchange({
        url, method, headers: sentHeaders, body, attempts: error.attempts, response: error.response,
      });
    }
    throw error;
  }

  const exchange = buildIciciExchange({
    url, method, headers: sentHeaders, body, attempts: res.attempts, response: res,
  });
  const data = typeof res.data === 'string' ? safeJson(res.data) ?? res.data : res.data;

  if (res.status < 200 || res.status >= 300) {
    logRejection(operation, url, res.status, data);
    const error = upstreamError(`Elevate ${operation} returned HTTP ${res.status}`, {
      details: { httpStatus: res.status, body: trunc(data) },
    });
    error.exchange = exchange;
    throw error;
  }

  if (data && typeof data === 'object' && !Buffer.isBuffer(data) && data.Success === false) {
    // ICICI put their explanation in different fields depending on the service.
    // CKYC in particular sends NO `ErrorMessage` at all — the customer-facing
    // text is in `DisplayMessage` and the reason code in `StatusCode` (verified
    // on UAT 2026-08-19: a declined CKYC returns StatusCode 451, DisplayMessage
    // "Failed: - Request failed, please retry with alternate KYC options.",
    // ErrorMessage absent). Reading only ErrorMessage turned that into
    // "unknown error" and threw away the one sentence the customer could act on.
    const message = data.ErrorMessage || data.DisplayMessage || data.TechnicalError || 'unknown error';
    logRejection(operation, url, res.status, data);
    const error = upstreamError(`Elevate ${operation} failed: ${message}`, {
      details: {
        errorCode: data.ErrorCode,
        errorId: data.ErrorId,
        statusCode: data.StatusCode,
        errorMessage: data.ErrorMessage,
        displayMessage: data.DisplayMessage,
        technicalError: data.TechnicalError,
        // The document-upload fallback ICICI offer when CKYC cannot resolve.
        ovdLink: data.OVDLink,
        corelationId: data.CorelationId,
      },
    });
    error.exchange = exchange;
    throw error;
  }

  if (data === undefined || data === null) {
    const error = parseError(`Elevate ${operation} returned an empty body`);
    error.exchange = exchange;
    throw error;
  }

  return { data, status: res.status, correlationId: res.correlationId, exchange };
}

// Logged in full whether or not debug is on: the reason ICICI refused a call
// lives in the body, not in the status. forAudit strips credential-shaped keys
// and truncates anything large.
function logRejection(operation, url, status, data) {
  console.error('────────── ICICI call REJECTED ───');
  console.error('operation    :', operation);
  console.error('URL          :', url);
  console.error('status       :', status);
  if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    console.error('ErrorCode    :', data.ErrorCode ?? null);
    console.error('StatusCode   :', data.StatusCode ?? null);
    console.error('ErrorMessage :', data.ErrorMessage ?? null);
    console.error('Display      :', data.DisplayMessage ?? null);
    console.error('CorelationId :', data.CorelationId ?? null);
  }
  console.error('resp data    :', trunc(Buffer.isBuffer(data) ? `[binary ${data.length} bytes]` : forAudit(data)));
  console.error('──────────────────────────────────');
}

// ── Operations ──────────────────────────────────────────────────────────────
//
// Each resolves { result, exchange } — `result` is the envelope the working
// implementation returned, unchanged, and `exchange` is what the controller
// adds beside it.

/** Premium (quote). `input` is the Premium request body. */
async function getQuote(input) {
  assertConfigured();
  const body = { ProductCode: PRODUCT_CODES.ELEVATE_HEALTH, ...input };
  requireFields(body, ['RequestId', 'SumInsured', 'Tenure', 'Insured'], 'Elevate premium');
  // IL's own kit is inconsistent here: the Premium field table names the
  // property `Pincode` while the sample request sends `PinCode`. Either
  // spelling satisfies the check and the caller's body is forwarded as-is, so
  // whichever one IL's gateway actually reads still arrives untouched.
  if (isEmpty(body.Pincode) && isEmpty(body.PinCode)) {
    throw validationError('Missing required field(s) for Elevate premium: Pincode (or PinCode)', {
      context: 'Elevate premium', missing: ['Pincode'],
    });
  }
  const res = await callIcici({ operation: 'premium', body, context: { requestId: body.RequestId } });
  const data = extractPremium(res.data);
  console.log(
    `[icici] quote parsed — transactionId=${data?.transactionId ?? null} `
    + `totalPremium=${data?.totalPremium ?? null} corelationId=${data?.corelationId ?? null}`
  );
  return { result: envelope('getQuote', data, res), exchange: res.exchange, request: body };
}

/**
 * Proposal (proposal-payment). Returns PaymentUrl + ProposalId.
 * NomineeName/NomineeDOB are mandatory in the Proposal field table, and
 * AppointeeName/DOB/Relationship become mandatory when the nominee is a minor.
 */
async function createProposal(input) {
  assertConfigured();
  requireFields(
    input,
    ['RequestId', 'TransactionId', 'Proposer', 'Insured', 'PaymentDetails', 'NomineeName', 'NomineeDOB'],
    'Elevate proposal'
  );
  const res = await callIcici({
    operation: 'proposal',
    body: input,
    context: { transactionId: input.TransactionId, requestId: input.RequestId },
  });
  const data = extractProposal(res.data);
  console.log(
    `[icici] proposal parsed — transactionId=${data?.transactionId ?? input.TransactionId} `
    + `proposalId=${data?.proposalId ?? null} status=${data?.status ?? null} `
    + `paymentUrl=${data?.paymentUrl ? 'present' : 'ABSENT'}`
  );
  return { result: envelope('createProposal', data, res), exchange: res.exchange, request: input };
}

/** Policy Sync — confirms payment and issues the policy. */
async function issuePolicy(input) {
  assertConfigured();
  requireFields(input, ['RequestId', 'TransactionId', 'PaymentDetails'], 'Elevate policy sync');
  const res = await callIcici({
    operation: 'policySync',
    body: input,
    context: { transactionId: input.TransactionId, requestId: input.RequestId },
  });
  const d = res.data;
  const data = {
    transactionId: d.TransactionId ?? null,
    policyNo: d.PolicyNo ?? d.PolicyNumber ?? null,
    status: d.Status ?? null,
    statusDescription: STATUS_MASTER[d.Status] ?? null,
    startDate: d.StartDate ?? null,
    endDate: d.EndDate ?? null,
    raw: d,
  };
  console.log(
    `[icici] policy sync parsed — transactionId=${data.transactionId ?? input.TransactionId} `
    + `policyNo=${data.policyNo} status=${data.status}`
  );
  return { result: envelope('issuePolicy', data, res), exchange: res.exchange, request: input };
}

/**
 * Policy status by TransactionId.
 *
 * This is the authoritative post-payment call for the ICICI-HOSTED payment
 * flow: when the customer pays on ICICI's own gateway, ICICI issue the policy
 * themselves and this reports the outcome. Policy Sync is not part of that
 * path — it exists for partner-collected payment (see issuePolicy).
 *
 * The response does NOT carry a `Status` field, despite the kit's field table
 * listing one. Verified on UAT 2026-08-20: an issued policy comes back with
 * `ProposalStatus: "NC"`, `PolicyStatus: "ACTIVE"` and `PaymentStatus: "Paid"`
 * and no `Status` at all, so reading `d.Status` produced a permanent null and
 * the caller could never tell an issued policy from a draft one.
 */
async function policyStatus(input) {
  assertConfigured();
  requireFields(input, ['TransactionId', 'RequestId'], 'Elevate policy status');
  const res = await callIcici({
    operation: 'policyStatus',
    body: input,
    context: { transactionId: input.TransactionId, requestId: input.RequestId },
  });
  const d = res.data;
  // `Status` is kept as a fallback only so an alternate response shape that
  // does send it still resolves, rather than being read as the primary.
  const proposalStatus = d.ProposalStatus ?? d.Status ?? null;
  const data = {
    transactionId: d.TransactionId ?? null,
    policyNo: d.PolicyNo ?? d.PolicyNumber ?? null,
    // The payment verdict — "Paid", "Failed", or absent when never attempted.
    paymentStatus: d.PaymentStatus ?? null,
    // Proposal lifecycle code, mapped through the Status Master below.
    proposalStatus,
    // Policy lifecycle: "ACTIVE" once issued, "DRAFT" before that.
    policyStatus: d.PolicyStatus ?? null,
    policySubStatus: d.PolicySubStatus ?? null,
    // Retained so existing callers reading `status` keep working.
    status: proposalStatus,
    statusDescription: STATUS_MASTER[proposalStatus] ?? null,
    startDate: d.StartDate ?? null,
    endDate: d.EndDate ?? null,
    raw: d,
  };
  console.log(
    `[icici] policy status parsed — transactionId=${data.transactionId ?? input.TransactionId} `
    + `paymentStatus=${data.paymentStatus} proposalStatus=${data.proposalStatus} `
    + `policyStatus=${data.policyStatus} policyNo=${data.policyNo}`
  );
  return { result: envelope('policyStatus', data, res), exchange: res.exchange, request: input };
}

/** EMI due details. */
async function emiDue(input) {
  assertConfigured();
  requireFields(input, ['RequestId', 'TransactionId'], 'Elevate EMI due');
  const res = await callIcici({
    operation: 'emiDue',
    body: input,
    context: { transactionId: input.TransactionId, requestId: input.RequestId },
  });
  const d = res.data;
  const list = d.EMIDueDetail || d.EMIDetails || [];
  return {
    result: envelope('emiDue', { emiDueDetail: list, transactionId: d.TransactionId ?? null, raw: d }, res),
    exchange: res.exchange,
    request: input,
  };
}

/** Process a single EMI installment. */
async function processEmi(input) {
  assertConfigured();
  requireFields(input, ['RequestId', 'TransactionId', 'InstallmentNo', 'PaymentTransactionId', 'EMIAmount'], 'Elevate process EMI');
  const res = await callIcici({
    operation: 'emiProcess',
    body: input,
    context: { transactionId: input.TransactionId, requestId: input.RequestId },
  });
  const d = res.data;
  return {
    result: envelope('processEmi', {
      transactionId: d.TransactionId ?? null, policyNo: d.PolicyNo ?? null, emiAmount: d.EMIAmount ?? null, raw: d,
    }, res),
    exchange: res.exchange,
    request: input,
  };
}

/**
 * Fetch the Certificate of Insurance.
 *
 * The kit describes a JSON body carrying a base64 `COI`, but UAT answers with
 * the PDF itself as the response body (verified 2026-08-20: 1.1 MB starting
 * `%PDF-1.3`, digitally signed by ICICI Lombard). Reading `d.COI` off that
 * returned null while the real document sat unused in the raw body, and
 * letting axios decode those bytes as text corrupted them — hence the
 * arraybuffer request and the magic-byte sniff below.
 *
 * Both shapes are handled: whichever arrives, the caller gets base64.
 */
async function coi({ transactionId, clientname } = {}) {
  assertConfigured();
  if (!transactionId) throw configError('coi requires transactionId');
  const res = await callIcici({
    operation: 'coi',
    params: { transactionId, clientname },
    responseType: 'arraybuffer',
    context: { transactionId },
  });

  const buf = Buffer.isBuffer(res.data) ? res.data : Buffer.from(res.data ?? '');

  // A PDF body — the shape UAT actually returns.
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') {
    console.log(`[icici] COI received — transactionId=${transactionId} PDF ${buf.length} bytes`);
    return {
      result: envelope('coi', {
        coi: buf.toString('base64'),
        contentType: 'application/pdf',
        byteLength: buf.length,
        filename: `ICICI-COI-${transactionId}.pdf`,
        status: null,
        // Deliberately not echoed: it is the whole document again, and a
        // megabyte of binary in a JSON envelope helps nobody.
        raw: null,
      }, res),
      exchange: res.exchange,
    };
  }

  // Otherwise the documented JSON shape.
  let d;
  try {
    d = JSON.parse(buf.toString('utf8'));
  } catch {
    const error = parseError('Elevate coi returned neither a PDF nor JSON', {
      details: { byteLength: buf.length, head: buf.subarray(0, 60).toString('latin1') },
    });
    error.exchange = res.exchange;
    throw error;
  }
  const base64 = d.COI ?? d.Coi ?? d.coi ?? null;
  console.log(
    `[icici] COI received — transactionId=${transactionId} JSON, document ${base64 ? 'present' : 'ABSENT'} `
    + `status=${d.Status ?? null}`
  );
  return {
    result: envelope('coi', {
      coi: base64,
      contentType: base64 ? 'application/pdf' : null,
      byteLength: base64 ? Buffer.from(base64, 'base64').length : null,
      filename: base64 ? `ICICI-COI-${transactionId}.pdf` : null,
      status: d.Status ?? null,
      raw: d,
    }, res),
    exchange: res.exchange,
  };
}

/** Zone lookup by pincode. `input`: { PinCode, IssuanceSystem, ProductCode }. */
async function zone(input) {
  assertConfigured();
  requireFields(input, ['PinCode', 'IssuanceSystem', 'ProductCode'], 'Elevate zone');
  const res = await callIcici({ operation: 'zone', body: input, context: { pinCode: input.PinCode } });
  const d = res.data;
  return {
    result: envelope('zone', {
      pinCode: d.PinCode ?? null, stateId: d.StateId ?? null, stateName: d.StateName ?? null,
      cityDistrictId: d.CityDistrictId ?? null, cityDistrictName: d.CityDistrictName ?? null,
      zone: d.Zone ?? null, raw: d,
    }, res),
    exchange: res.exchange,
    request: input,
  };
}

export {
  assertConfigured,
  endpointFor,
  callIcici,
  getQuote,
  createProposal,
  issuePolicy,
  policyStatus,
  emiDue,
  processEmi,
  coi,
  zone,
};
