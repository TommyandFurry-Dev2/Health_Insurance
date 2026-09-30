import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import config, {
  missingCholaVariables, cholaIsUnconfigured, missingCholaCkycVariables,
} from '../config/env.js';
import * as cholaApi from '../services/cholaApi.service.js';
import * as cholaCkyc from '../services/cholaCkyc.service.js';
import * as cholaIssuer from '../services/cholaPolicyIssuer.service.js';
import * as journeyService from '../services/journey.service.js';
import {
  CHOLA_API_NAMES, CHOLA_PROVIDER, CHOLA_DEFAULT_PRODUCT, CHOLA_PAYMENT_MODES, CHOLA_PROPOSAL_STATUS,
} from '../constants/chola.constants.js';
import { configError, unauthorizedError, notFoundError } from '../helpers/chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS endpoints.
//
// Pass-throughs, in the same sense the other insurers' controllers are: the
// caller sends Chola's own documented PascalCase request body (the service only
// injects IntermediaryCode and strips `product`), and gets the working
// implementation's normalised answer back. What this layer adds is an audit row
// per call and the exchange that went upstream.
//
// ── The response envelope is the working implementation's, unchanged ────────
// Success:  { ok, provider:'chola', operation, product, data, meta }
// Failure:  { ok:false, error:{ code, message, provider, details } }
//
// The same decision the ICICI migration made, for the same reason: the SPA's
// Chola pages (CholaProposal.jsx, utils/cholaQuote.js, utils/cholaCkyc.js) read
// `res.data` / `res.data.raw` off exactly this envelope, and api/cholaClient.js
// maps exactly these bare error codes to buyer-facing sentences. Only the base
// URL and the route paths move.
//
// `cholaRequest` is ADDED beside the envelope — the URL, headers (the Bearer
// token reduced to its length) and body that went upstream — the way the other
// insurers return `iciciRequest` / `itgiRequest` / `fgRequest`. Additive, so
// nothing reading the envelope is affected. Deliberately omitted from CKYC,
// whose body is a PAN, Aadhaar or passport number.
//
// Persistence: every call is audited into the existing api_transactions table
// via recordStandaloneApiCall, with the journey id when the caller sent one —
// the same decision the ITGI, FG and ICICI controllers made. PolicyGeneration
// is additionally evidenced byte for byte in health_chola_policy_generation_logs
// (see services/cholaPolicyIssuer.service.js).
// ─────────────────────────────────────────────────────────────────────────────

// The failure envelope, exactly as the working implementation's error handler
// wrote it. `error.status` is set only on errors this integration classified
// (400 validation, 401 ops key, 404, 503 configuration, 502 auth/upstream/parse,
// 504 timeout); anything else — a database error on the ops routes, a bug here —
// answers 500.
function respondWithError(res, error, { exchange = true } = {}) {
  return res.status(error.chola ? error.status : 500).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message,
      provider: error.provider || null,
      details: error.details || null,
    },
    ...(exchange ? { cholaRequest: error.exchange || null } : {}),
  });
}

// One audit row per Chola call, success or failure. Never throws: a failed
// audit write must not turn a successful quote into a 500 (recordStandaloneApiCall
// goes through journey.service's safeSave, and log.repository swallows its own
// errors on top).
function audit({
  req, apiName, startedAt, httpStatus, endpointUrl,
  requestPayload, responsePayload, errorMessage, errorCode, correlationId,
}) {
  return journeyService.recordStandaloneApiCall({
    journeyId: req.journeyId || null,
    apiName,
    httpMethod: 'POST',
    endpointUrl: endpointUrl || null,
    status: errorMessage ? 'FAILED' : 'SUCCESS',
    httpStatus: httpStatus || null,
    durationMs: Date.now() - startedAt,
    requestPayload,
    responsePayload,
    errorCode: errorCode || null,
    errorMessage: errorMessage || null,
    // The Gencon proposal (or policy) number wherever the call has one, so every
    // row of one purchase can be found by the number Chola's desk asks for.
    correlationId: correlationId || null,
  });
}

// The upstream HTTP status of a failed call, when one was received.
function failedHttpStatus(error) {
  return error.exchange?.responseStatus ?? error.details?.httpStatus ?? null;
}

// The endpoint URL for an audit row. endpointFor throws when CHOLA_BASE_URL is
// unset or the product is unknown; an audit row must not be the thing that
// turns that into a 500.
function safeEndpoint(body, operation) {
  try {
    return cholaApi.endpointFor(body?.product || CHOLA_DEFAULT_PRODUCT, operation);
  } catch {
    return null;
  }
}

// Chola answer a business rejection as HTTP 200 with Status "Failure" and
// their own sentence; the envelope carries it as data.succeeded === false. It
// is recorded as FAILED so it is findable, while the caller still gets the
// 200 and Chola's wording, exactly as before.
//
// The backend-built PolicyGeneration carries its verdict in `status` instead
// (PAYMENT_FAILED / NEEDS_REVIEW), and is flagged the same way.
function businessFailure(operation, data) {
  if (!data) return null;
  const backendVerdict = [CHOLA_PROPOSAL_STATUS.PAYMENT_FAILED, CHOLA_PROPOSAL_STATUS.NEEDS_REVIEW].includes(data.status);
  if (data.succeeded !== false && !backendVerdict) return null;
  return `Chola ${operation} did not succeed: ${data.message || data.outcome || data.status || 'no reason given'}`;
}

/**
 * The shared shape of every JSON product route: call, audit, answer.
 *
 * @param {object}   spec
 * @param {string}   spec.operation      Chola's operation name, for the audit URL
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
        endpointUrl: exchange?.url || safeEndpoint(body, operation),
        requestPayload: body,
        responsePayload: result.data,
        errorMessage: businessFailure(operation, result.data),
        correlationId: correlationOf(body, result),
      });

      return res.status(200).json({ ...result, cholaRequest: exchange || null });
    } catch (error) {
      console.error(`❌ Chola ${operation} failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

      await audit({
        req,
        apiName,
        startedAt,
        httpStatus: failedHttpStatus(error),
        endpointUrl: error.exchange?.url || safeEndpoint(body, operation),
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

// ── Quote → proposal → PolicyGeneration → schedule ──────────────────────────

// POST /chola-ms/PremiumComputation   (also /chola-ms/quote)
//
// Pricing only — nothing is created at Chola.
export const getQuote = passThrough({
  operation: 'PremiumComputation',
  apiName: CHOLA_API_NAMES.QUOTE,
  run: (body) => cholaApi.getQuote(body),
  correlationOf: () => null,
});

// POST /chola-ms/ProposalSave   (also /chola-ms/proposal)
//
// Writes to Gencon. Returns GENCONProposalNumber and the RE-PRICED premium,
// which is what PolicyGeneration must be tagged for.
export const createProposal = passThrough({
  operation: 'ProposalSave',
  apiName: CHOLA_API_NAMES.PROPOSAL,
  run: (body) => cholaApi.createProposal(body),
  correlationOf: (body, result) => result?.data?.genconProposalNumber || body.UniqueTransactionID,
});

// POST /chola-ms/PolicyGeneration   (also /chola-ms/issue)
//
// ⚠️ NOT IDEMPOTENT. Tags the payment against a saved proposal: with PayMode
// "Chola" it answers Chola's hosted payment URL, with "Direct" the policy
// number. Under CHOLA_PAYMENT_MODE=APD it issues from NovaCred's deposit and
// answers the policy number with no payment page.
export const issuePolicy = passThrough({
  operation: 'PolicyGeneration',
  apiName: CHOLA_API_NAMES.POLICY_GENERATION,
  run: (body) => cholaIssuer.issuePolicy(body),
  correlationOf: (body) => body.GenconProposalNumber,
});

// POST /chola-ms/PolicySchedule   (also /chola-ms/policy/schedule)
//
// The policy document links for an ISSUED policy, by POLICY number.
export const policySchedule = passThrough({
  operation: 'PolicySchedule',
  apiName: CHOLA_API_NAMES.POLICY_SCHEDULE,
  run: (body) => cholaApi.policySchedule(body),
  correlationOf: (body) => body.GenconPolicyNumber,
});

// ── CKYC ────────────────────────────────────────────────────────────────────

// Which identifier a CKYC was attempted with, never the identifier itself. A
// PAN or Aadhaar number does not belong in an append-only audit table.
const CKYC_ID_FIELDS = [
  ['ckycNo', 'CKYC'], ['panNo', 'PAN'], ['aadharNo', 'AADHAAR'], ['passportNo', 'PASSPORT'],
  ['voterId', 'VOTER_ID'], ['dlNo', 'DL'], ['cin', 'CIN'],
];

function describeCkycRequest(body) {
  const idTypes = CKYC_ID_FIELDS.filter(([field]) => body[field]).map(([, type]) => type);
  return {
    appRefNo: body.appRefNo ?? null,
    transactionId: body.transactionId ?? null,
    verifyType: body.verifyType ?? null,
    customerType: body.customerType ?? null,
    idTypes,
  };
}

// Outcome and Chola's references only — not the name, DOB or identifiers the
// portal echoes back.
function describeCkycResponse(d) {
  if (!d || typeof d !== 'object') return { body: typeof d };
  return {
    status: d.Status ?? null,
    errorMsg: d.ErrorMsg ?? d.ErrorMSG ?? null,
    transactionId: d.Transaction_ID ?? null,
    ckycNumberReturned: Boolean(d.CKYC_No),
    redirectionUrlReturned: Object.entries(d).some(([key, value]) => /redirect/i.test(key) && Boolean(value)),
    policyGenFlag: d.Policy_Gen_Flag ?? null,
  };
}

function ckycHandler({ apiName, operation, run }) {
  return async (req, res) => {
    const startedAt = Date.now();
    const body = req.body ?? {};

    try {
      const { result, exchange } = await run(body);
      const d = result.data;
      const verified = String(d?.Status || '').trim().toLowerCase() === 'success';

      await audit({
        req,
        apiName,
        startedAt,
        httpStatus: exchange?.responseStatus,
        endpointUrl: exchange?.url || null,
        requestPayload: describeCkycRequest(body),
        responsePayload: describeCkycResponse(d),
        // A "Failure" here is a KYC OUTCOME (no record, invalid DOB), returned
        // to the caller as data — recorded as FAILED so it is findable.
        errorMessage: verified ? null : `Chola ${operation}: ${d?.ErrorMsg || d?.Status || 'no status returned'}`,
        correlationId: body.appRefNo,
      });

      return res.status(200).json(result);
    } catch (error) {
      console.error(`❌ Chola ${operation} failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);

      await audit({
        req,
        apiName,
        startedAt,
        httpStatus: failedHttpStatus(error),
        endpointUrl: error.exchange?.url || null,
        requestPayload: describeCkycRequest(body),
        responsePayload: null,
        errorCode: error.code || 'INTERNAL_ERROR',
        errorMessage: error.message,
        correlationId: body.appRefNo,
      });

      return respondWithError(res, error, { exchange: false });
    }
  };
}

// POST /chola-ms/CholaMS_CKYC_Verify   (also /chola-ms/ckyc/verify)
//
// Verifies a customer against CERSAI. Answers either a CKYC number or an
// eKYC redirection URL to send the customer to.
export const ckycVerify = ckycHandler({
  apiName: CHOLA_API_NAMES.CKYC_VERIFY,
  operation: 'CholaMS_CKYC_Verify',
  run: (body) => cholaCkyc.verify(body),
});

// POST /chola-ms/CholaMS_CKYC_Query   (also /chola-ms/ckyc/query)
//
// The outcome of a verification the customer completed on Chola's hosted
// eKYC page, by the App_Ref_No the verify call was made with.
export const ckycQuery = ckycHandler({
  apiName: CHOLA_API_NAMES.CKYC_QUERY,
  operation: 'CholaMS_CKYC_Query',
  run: (body) => cholaCkyc.query(body),
});

// ── Ops: backend-built PolicyGeneration (APD) ───────────────────────────────
//
// Never called by the website. These act on NovaCred's own account with Chola
// (APD debits our deposit), so they are not reachable without the X-Ops-Key,
// and they are switched OFF — not open — while CHOLA_OPS_KEY is unset.

/**
 * Guard for the ops routes: the caller must send `X-Ops-Key` equal to
 * CHOLA_OPS_KEY. Read per request, so a restart with a new .env — or a test —
 * never sees a stale value.
 */
export function requireOpsKey(req, res, next) {
  const expected = String(config.chola.opsKey || '');
  if (!expected) {
    return respondWithError(res, configError('Ops routes are disabled: CHOLA_OPS_KEY is not set.'), { exchange: false });
  }
  const given = Buffer.from(String(req.headers['x-ops-key'] || ''));
  const want = Buffer.from(expected);
  // Length first: timingSafeEqual throws on unequal lengths.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return respondWithError(res, unauthorizedError('A valid X-Ops-Key header is required.'), { exchange: false });
  }
  return next();
}

// POST /chola-ms/ops/PolicyGeneration
//
// { product?, GenconProposalNumber, Amount, paymentReference? } → PolicyGeneration
// in CHOLA_PAYMENT_MODE, built by the backend and sent exactly once.
export const opsPolicyGeneration = passThrough({
  operation: 'PolicyGeneration',
  apiName: CHOLA_API_NAMES.OPS_POLICY_GENERATION,
  run: (body) => cholaIssuer.issue(body, { source: 'ops' }),
  correlationOf: (body) => body.GenconProposalNumber,
});

function jsonRead(read) {
  return async (req, res) => {
    try {
      return res.status(200).json(await read(req));
    } catch (error) {
      console.error(`❌ Chola ops read failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);
      return respondWithError(res, error, { exchange: false });
    }
  };
}

// GET /chola-ms/ops/proposals — proposals the backend has tagged, with status.
export const opsListProposals = jsonRead((req) => cholaIssuer.listProposals({ limit: req.query.limit }));

// GET /chola-ms/ops/proposals/:proposalNo/PolicyGeneration — raw evidence for one.
export const opsProposalLogs = jsonRead((req) => cholaIssuer.listPolicyGenerationLogs({
  genconProposalNumber: req.params.proposalNo, limit: req.query.limit,
}));

// GET /chola-ms/ops/PolicyGeneration/logs — the most recent evidence, any proposal.
export const opsListLogs = jsonRead((req) => cholaIssuer.listPolicyGenerationLogs({ limit: req.query.limit }));

// GET /chola-ms/ops/proposals/:proposalNo/pdf — the stored policy PDF, if any.
export const opsProposalPdf = async (req, res) => {
  try {
    const row = await cholaIssuer.cholaStore().findPolicyPdf(req.params.proposalNo);
    if (!row) {
      return respondWithError(res, notFoundError('No policy PDF is stored for this proposal.'), { exchange: false });
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${String(row.gencon_policy_number || req.params.proposalNo).replace(/[^\w.-]/g, '_')}.pdf"`
    );
    return res.end(row.policy_pdf);
  } catch (error) {
    console.error(`❌ Chola ops PDF failed: [${error.code || 'INTERNAL_ERROR'}] ${error.message}`);
    return respondWithError(res, error, { exchange: false });
  }
};

// ── The ops screen ──────────────────────────────────────────────────────────
//
// Static and holds no data: it asks for the ops key and reads the routes above
// with it. The script is served as its own file rather than inline because
// helmet's Content-Security-Policy (script-src 'self') blocks inline scripts.
//
// The page is told where it is mounted — '' or the /health alias — so its
// calls reach this router however the request arrived.

const OPS_HTML = fileURLToPath(new URL('../ops/chola.html', import.meta.url));
const OPS_SCRIPT = fileURLToPath(new URL('../ops/chola-ops.js', import.meta.url));

// GET /chola-ms/ops
export const opsScreen = (req, res) => {
  try {
    const base = `${req.baseUrl || ''}/chola-ms`;
    const html = fs.readFileSync(OPS_HTML, 'utf8').replaceAll('__CHOLA_BASE__', base);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(html);
  } catch (error) {
    return respondWithError(res, error, { exchange: false });
  }
};

// GET /chola-ms/ops/chola-ops.js
export const opsScript = (req, res) => {
  try {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(fs.readFileSync(OPS_SCRIPT, 'utf8'));
  } catch (error) {
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

// GET /chola-ms/config/test
//
// Reports whether this process can reach Chola at all, without calling them
// and without printing a single value — the same probe every other insurer
// exposes. 503 when a required variable is missing, naming it. The product and
// CKYC legs are reported separately because they fail independently.
//
// Deliberately does not mint a token: that is a live call against a
// rate-limited gateway, and `npm run smoke:chola token` exists for it.
export const testConfig = async (req, res) => {
  const missing = missingCholaVariables();
  const ckycMissing = missingCholaCkycVariables();
  const ready = missing.length === 0;
  const mode = config.chola.paymentMode;

  return res.status(ready ? 200 : 503).json({
    ok: ready,
    provider: CHOLA_PROVIDER,
    operation: 'configTest',
    data: {
      configured: ready,
      unconfigured: cholaIsUnconfigured(),
      // Names only.
      missing,
      baseUrl: describeUrl(config.chola.baseUrl),
      quoteEndpoint: ready ? describeUrl(cholaApi.endpointFor(CHOLA_DEFAULT_PRODUCT, 'PremiumComputation')) : null,
      superTopupProposalUrl: describeUrl(config.chola.topupProposalUrl),
      ckyc: {
        configured: ckycMissing.length === 0,
        missing: ckycMissing,
        baseUrl: describeUrl(config.chola.ckyc.baseUrl),
      },
      paymentMode: mode,
      paymentModeValid: CHOLA_PAYMENT_MODES.includes(mode),
      // APD in production is refused at request time; say so here first.
      apdRefusedHere: mode === 'APD' && config.env === 'production',
      publicUrlBaseSet: Boolean(config.chola.publicUrlBase),
      opsRoutesEnabled: Boolean(config.chola.opsKey),
    },
  });
};
