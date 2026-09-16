import config, { missingIciciVariables, iciciIsUnconfigured } from '../config/env.js';
import * as iciciApi from '../services/iciciApi.service.js';
import * as iciciCkyc from '../services/iciciCkyc.service.js';
import * as journeyService from '../services/journey.service.js';
import { ICICI_API_NAMES, ICICI_PROVIDER } from '../constants/icici.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard ("Elevate") endpoints.
//
// Pass-throughs, in the same sense the other insurers' controllers are: the
// caller sends ICICI's own documented PascalCase request body (the adapter only
// defaults ProductCode), and gets the working implementation's normalised
// answer back. What this layer adds is an audit row per call and the exchange
// that went upstream.
//
// ── The response envelope is the working implementation's, unchanged ────────
// Success:  { ok, provider:'elevate', operation, data, meta }
// Failure:  { ok:false, error:{ code, message, provider, details } }
//
// The same decision the Future Generali migration made, for the same reason:
// the SPA's ICICI pages (ElevateProposal.jsx, ElevateReturn.jsx,
// utils/elevateQuote.js, utils/elevateCkyc.js) read `res.data.<field>` off
// exactly this envelope, and api/elevateClient.js maps exactly these bare error
// codes to buyer-facing sentences. Changing either would mean rewriting those
// pages to gain nothing a buyer or an operator can see. Only the base URL and
// the route paths move.
//
// `iciciRequest` is ADDED beside the envelope — the URL, headers (the Bearer
// token reduced to its length) and body that went upstream — the way the other
// insurers return `nivabupaRequest` / `itgiRequest` / `fgRequest`. Additive, so
// nothing reading the envelope is affected. Deliberately omitted from CKYC and
// OVD (the body is a PAN or Aadhaar number, or document scans) and from COI
// (the body is the policy document itself).
//
// Persistence: every call is audited into the existing api_transactions table
// via recordStandaloneApiCall, with the journey id when the caller sent one —
// the same decision the ITGI and FG controllers made. ICICI calls do NOT write
// the typed journey_quotes / journey_proposals rows, which are shaped around
// NivaBupa's envelopes. No table was added for ICICI.
// ─────────────────────────────────────────────────────────────────────────────

// The failure envelope, exactly as the working implementation's error handler
// wrote it. `error.status` is set only on errors this integration classified
// (400 validation, 503 configuration, 502 auth/upstream/parse, 504 timeout);
// anything else is a bug here rather than an upstream failure, and answers 500.
function respondWithError(res, error, { exchange = true } = {}) {
  return res.status(error.icici ? error.status : 500).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message,
      provider: error.provider || null,
      details: error.details || null,
    },
    ...(exchange ? { iciciRequest: error.exchange || null } : {}),
  });
}

// One audit row per ICICI call, success or failure. Never throws: a failed
// audit write must not turn a successful quote into a 500 (recordStandaloneApiCall
// goes through journey.service's safeSave, and log.repository swallows its own
// errors on top).
function audit({
  req, apiName, startedAt, httpMethod = 'POST', httpStatus, endpointUrl,
  requestPayload, responsePayload, errorMessage, errorCode, correlationId,
}) {
  return journeyService.recordStandaloneApiCall({
    journeyId: req.journeyId || null,
    apiName,
    httpMethod,
    endpointUrl: endpointUrl || null,
    status: errorMessage ? 'FAILED' : 'SUCCESS',
    httpStatus: httpStatus || null,
    durationMs: Date.now() - startedAt,
    requestPayload,
    responsePayload,
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    // ICICI's own TransactionId (bnc_…) wherever the call has one, so every row
    // of one journey can be found by the id ICICI's support desk asks for.
    correlationId: correlationId || null,
  });
}

// The upstream HTTP status of a failed call, when one was received.
function failedHttpStatus(error) {
  return error.exchange?.responseStatus ?? error.details?.httpStatus ?? null;
}

// The endpoint URL for an audit row. endpointFor throws when EL_BASE_URL is
// unset; an audit row must not be the thing that turns that into a 500.
function safeEndpoint(operation) {
  try {
    return iciciApi.endpointFor(operation).url;
  } catch {
    return null;
  }
}

/**
 * The shared shape of every JSON pass-through route: call, audit, answer.
 *
 * @param {object}   spec
 * @param {string}   spec.operation      config path key, for the audit URL
 * @param {string}   spec.apiName        api_transactions.api_name
 * @param {Function} spec.run            (body) => { result, exchange }
 * @param {Function} spec.correlationOf  (body, result?) => the id to record
 */
function passThrough({ operation, apiName, run, correlationOf }) {
  return async (req, res) => {
    const startedAt = Date.now();
    // The working implementation parsed bodies with Express 4, where a request
    // without one still arrived as {}. Express 5 leaves it undefined.
    const body = req.body ?? {};

    try {
      const { result, exchange } = await run(body);

      await audit({
        req,
        apiName,
        startedAt,
        httpStatus: exchange?.responseStatus,
        endpointUrl: exchange?.url || safeEndpoint(operation),
        requestPayload: body,
        responsePayload: result.data,
        correlationId: correlationOf(body, result),
      });

      return res.status(200).json({ ...result, iciciRequest: exchange || null });
    } catch (error) {
      console.error(`❌ ICICI ${operation} failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

      await audit({
        req,
        apiName,
        startedAt,
        httpStatus: failedHttpStatus(error),
        endpointUrl: error.exchange?.url || safeEndpoint(operation),
        requestPayload: body,
        responsePayload: error.details || null,
        errorCode: error.code || 'INTERNAL_ERROR',
        errorMessage: error.message,
        correlationId: correlationOf(body, null),
      });

      return respondWithError(res, error);
    }
  };
}

// ── Quote → proposal → (hosted payment) → status ────────────────────────────

// POST /icici-lombard/quote
//
// Premium. Returns ICICI's TransactionId (bnc_…), which every later step of the
// journey is keyed by — recorded as the correlation id so the row can be found
// by it.
export const getQuote = passThrough({
  operation: 'premium',
  apiName: ICICI_API_NAMES.QUOTE,
  run: (body) => iciciApi.getQuote(body),
  correlationOf: (body, result) => result?.data?.transactionId || body.RequestId,
});

// POST /icici-lombard/proposal
//
// Proposal-payment. Returns ProposalId + PaymentUrl (ICICI's hosted gateway).
// ICICI refuse it with `458 KYC PENDING` until CKYC has resolved against the
// same TransactionId.
export const createProposal = passThrough({
  operation: 'proposal',
  apiName: ICICI_API_NAMES.PROPOSAL,
  run: (body) => iciciApi.createProposal(body),
  correlationOf: (body) => body.TransactionId,
});

// POST /icici-lombard/issue
//
// Policy Sync — for PARTNER-collected payment only. On ICICI's hosted gateway
// they issue the policy themselves and /policy/status is the call to make.
export const issuePolicy = passThrough({
  operation: 'policySync',
  apiName: ICICI_API_NAMES.POLICY_SYNC,
  run: (body) => iciciApi.issuePolicy(body),
  correlationOf: (body) => body.TransactionId,
});

// POST /icici-lombard/policy/status
//
// The authoritative read after a hosted payment: PaymentStatus is ICICI's
// verdict on the money, ProposalStatus/PolicyStatus on the policy.
export const policyStatus = passThrough({
  operation: 'policyStatus',
  apiName: ICICI_API_NAMES.POLICY_STATUS,
  run: (body) => iciciApi.policyStatus(body),
  correlationOf: (body) => body.TransactionId,
});

// ── Servicing ───────────────────────────────────────────────────────────────

// POST /icici-lombard/emi/due
export const emiDue = passThrough({
  operation: 'emiDue',
  apiName: ICICI_API_NAMES.EMI_DUE,
  run: (body) => iciciApi.emiDue(body),
  correlationOf: (body) => body.TransactionId,
});

// POST /icici-lombard/emi/process
export const processEmi = passThrough({
  operation: 'emiProcess',
  apiName: ICICI_API_NAMES.EMI_PROCESS,
  run: (body) => iciciApi.processEmi(body),
  correlationOf: (body) => body.TransactionId,
});

// POST /icici-lombard/zone
export const zone = passThrough({
  operation: 'zone',
  apiName: ICICI_API_NAMES.ZONE,
  run: (body) => iciciApi.zone(body),
  correlationOf: (body) => body.PinCode,
});

// GET /icici-lombard/coi/:transactionId
//
// Certificate of insurance, as base64 whichever shape ICICI answer in. The
// document never goes into the audit row, the log, or an `iciciRequest` echo.
export const coi = async (req, res) => {
  const startedAt = Date.now();
  const { transactionId } = req.params;

  try {
    const { result, exchange } = await iciciApi.coi({ transactionId });

    await audit({
      req,
      apiName: ICICI_API_NAMES.COI,
      startedAt,
      httpMethod: 'GET',
      httpStatus: exchange?.responseStatus,
      endpointUrl: exchange?.url || null,
      requestPayload: { transactionId },
      responsePayload: {
        hasDocument: Boolean(result.data.coi),
        contentType: result.data.contentType,
        byteLength: result.data.byteLength,
        filename: result.data.filename,
        status: result.data.status,
      },
      errorMessage: result.data.coi ? null : 'ICICI returned no certificate',
      correlationId: transactionId,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error(`❌ ICICI coi failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

    await audit({
      req,
      apiName: ICICI_API_NAMES.COI,
      startedAt,
      httpMethod: 'GET',
      httpStatus: failedHttpStatus(error),
      endpointUrl: error.exchange?.url || null,
      requestPayload: { transactionId },
      responsePayload: error.details || null,
      errorCode: error.code || 'INTERNAL_ERROR',
      errorMessage: error.message,
      correlationId: transactionId,
    });

    return respondWithError(res, error, { exchange: false });
  }
};

// ── CKYC ────────────────────────────────────────────────────────────────────

// Which identifier a CKYC was attempted with, never the identifier itself.
// An Aadhaar number does not belong in an append-only audit table.
function describeCkycRequest(body) {
  let idType = null;
  if (body.panNumber) idType = 'PAN';
  else if (body.ckycNumber) idType = 'CKYC';
  else if (body.aadhaarNumber) idType = 'AADHAAR';
  return { transactionId: body.transactionId ?? null, idType };
}

// POST /icici-lombard/ckyc
//
// A "not verified" answer is an OUTCOME, not a failure: it arrives as HTTP 200
// with isKycSuccess false and ICICI's own DisplayMessage, which is what tells
// the customer to retry with a different document. Recorded as FAILED in the
// audit table so it is findable.
export const ckyc = async (req, res) => {
  const startedAt = Date.now();
  const body = req.body ?? {};

  try {
    const { result, exchange } = await iciciCkyc.ckyc(body);
    const d = result.data;

    await audit({
      req,
      apiName: ICICI_API_NAMES.CKYC,
      startedAt,
      httpStatus: exchange?.responseStatus,
      endpointUrl: exchange?.url || safeEndpoint('ckyc'),
      requestPayload: describeCkycRequest(body),
      // Outcome and ICICI's reference only — not the masked name, DOB,
      // contact details or addresses they return.
      responsePayload: {
        isKycSuccess: d.isKycSuccess,
        kycId: d.kycId ?? null,
        statusCode: d.statusCode,
        displayMessage: d.displayMessage,
        ovdLinkOffered: Boolean(d.ovdLink),
      },
      errorMessage: d.isKycSuccess ? null : `ICICI CKYC not verified: ${d.displayMessage || d.statusCode || 'no reason given'}`,
      correlationId: body.transactionId,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error(`❌ ICICI ckyc failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

    await audit({
      req,
      apiName: ICICI_API_NAMES.CKYC,
      startedAt,
      httpStatus: failedHttpStatus(error),
      endpointUrl: error.exchange?.url || safeEndpoint('ckyc'),
      requestPayload: describeCkycRequest(body),
      responsePayload: error.details || null,
      errorCode: error.code || 'INTERNAL_ERROR',
      errorMessage: error.message,
      correlationId: body.transactionId,
    });

    return respondWithError(res, error, { exchange: false });
  }
};

// POST /icici-lombard/ckyc/ovd
//
// The document-upload fallback when CKYC does not resolve. Not wired into the
// current health UI. The audit row records the proof TYPES, never the files.
export const ovdInitiate = async (req, res) => {
  const startedAt = Date.now();
  const body = req.body ?? {};
  const described = {
    quoteTransactionId: body.quoteTransactionId ?? null,
    proofOfIdentityType: body.proofOfIdentityType ?? null,
    proofOfAddressType: body.proofOfAddressType ?? null,
  };

  try {
    const { result, exchange } = await iciciCkyc.ovdInitiate(body);

    await audit({
      req,
      apiName: ICICI_API_NAMES.OVD_INITIATE,
      startedAt,
      httpStatus: exchange?.responseStatus,
      endpointUrl: exchange?.url || safeEndpoint('ovdInitiate'),
      requestPayload: described,
      responsePayload: { isKycSuccess: result.data.isKycSuccess, errorCode: result.meta.errorCode ?? null },
      correlationId: body.quoteTransactionId,
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error(`❌ ICICI ovdInitiate failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

    await audit({
      req,
      apiName: ICICI_API_NAMES.OVD_INITIATE,
      startedAt,
      httpStatus: failedHttpStatus(error),
      endpointUrl: error.exchange?.url || safeEndpoint('ovdInitiate'),
      requestPayload: described,
      responsePayload: error.details || null,
      errorCode: error.code || 'INTERNAL_ERROR',
      errorMessage: error.message,
      correlationId: body.quoteTransactionId,
    });

    return respondWithError(res, error, { exchange: false });
  }
};

// ── Configuration probe ─────────────────────────────────────────────────────

// Host and path only — never a credential.
function describeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

// GET /icici-lombard/config/test
//
// Reports whether this process can reach ICICI at all, without calling them and
// without printing a single value — the same probe IFFCO Tokio and Future
// Generali expose. 503 when a required variable is missing, naming it.
//
// Deliberately does not mint a token: that is a live call against a
// rate-limited gateway, and `npm run smoke:icici token` exists for it.
export const testConfig = async (req, res) => {
  const missing = missingIciciVariables();
  const ready = missing.length === 0;

  return res.status(ready ? 200 : 503).json({
    ok: ready,
    provider: ICICI_PROVIDER,
    operation: 'configTest',
    data: {
      configured: ready,
      unconfigured: iciciIsUnconfigured(),
      // Names only.
      missing,
      baseUrl: describeUrl(config.icici.baseUrl),
      premiumEndpoint: ready ? describeUrl(iciciApi.endpointFor('premium').url) : null,
      passwordPreEncrypted: config.icici.passwordPreEncrypted,
      // Only meaningful when the password is encrypted here.
      aesMode: config.icici.passwordPreEncrypted ? null : config.icici.aesMode,
      // COI builds its path from this; without it the certificate URL is wrong.
      clientNameSet: Boolean(config.icici.clientName),
    },
  });
};
