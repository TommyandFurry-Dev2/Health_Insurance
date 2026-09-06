import config from '../config/env.js';
import * as itgiApi from '../services/itgiApi.service.js';
import * as itgiCkyc from '../services/itgiCkyc.service.js';
import * as journeyService from '../services/journey.service.js';
import * as logRepo from '../repositories/log.repository.js';
import { ITGI_API_NAMES } from '../constants/itgi.constants.js';
import {
  buildPaymentForm,
  parsePaymentResponse,
  paymentGatewayUrl,
} from '../helpers/itgi.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// IFFCO Tokio (ITGI) endpoints.
//
// Pass-throughs, in the same sense the NivaBupa controllers are: the caller
// sends ITGI's own documented request shape and gets ITGI's answer back. What
// this layer adds is the partner identity (from config, never from the
// browser), local validation of the table-driven rules, and an audit row per
// call.
//
// Every response carries `itgiRequest` — the URL, headers and complete body
// that went upstream — for the same reason the NivaBupa endpoints return
// `nivabupaRequest`: ITGI's rejections routinely name a field that is
// perfectly correct, so the rejection is only actionable next to the payload
// that produced it.
//
// Persistence: ITGI calls are audited into the existing api_transactions table
// via recordStandaloneApiCall, with the journey id when the caller sent one
// (the ITGI router runs the same optional resolveJourney middleware). They do
// NOT write the typed journey_quotes / journey_proposals rows — those columns
// are shaped around NivaBupa's envelopes, and mapping ITGI's into them would
// mean either changing that schema or storing something misleading. The audit
// row holds the full request and response either way.
// ─────────────────────────────────────────────────────────────────────────────

// The failure envelope, matching the NivaBupa controllers' shape with `itgi_`
// where they say `nivabupa_`.
//
// `error.status` is set by the service layer: 400 for a local validation
// failure, 503 when ITGI is not configured, 504 on a timeout, 502 for anything
// ITGI rejected or could not answer. Anything without one is a bug in this
// service, not an upstream failure, so it answers 500.
function respondWithError(res, error) {
  return res.status(error.status || 500).json({
    status: 'ERROR',
    code: error.code || 'ITGI_ERROR',
    message: error.message,
    ...(error.field ? { field: error.field } : {}),
    // ITGI's own error[] / errors[] entries, which name the offending fields.
    itgi_response: error.details || error.response?.data || null,
    itgiRequest: error.exchange || null,
  });
}

// One audit row per ITGI call, success or failure. Never throws: a failed audit
// write must not turn a successful quote into a 500 (recordStandaloneApiCall
// goes through journey.service's safeSave, and log.repository swallows its own
// errors on top).
function audit({ req, apiName, operation, startedAt, httpStatus, requestPayload, responsePayload, errorMessage, correlationId }) {
  return journeyService.recordStandaloneApiCall({
    journeyId: req.journeyId || null,
    apiName,
    httpMethod: 'POST',
    endpointUrl: operation ? safeEndpoint(operation) : null,
    status: errorMessage ? 'FAILED' : 'SUCCESS',
    httpStatus: httpStatus || null,
    durationMs: Date.now() - startedAt,
    requestPayload,
    responsePayload,
    errorMessage,
    correlationId,
  });
}

// endpointFor throws when ITGI is unconfigured; an audit row must not be the
// thing that turns that into a 500, so the URL is simply omitted.
function safeEndpoint(operation) {
  try {
    return itgiApi.endpointFor(operation);
  } catch {
    return null;
  }
}

// The gateway form for a proposal that has just succeeded, or null when ITGI's
// answer cannot produce one. See its call site: a proposal that reached ITGI
// must return its orderNo whatever else is missing.
function paymentFormFor(data) {
  if (!data?.orderNo) return null;
  try {
    return buildPaymentForm({
      orderNo: data.orderNo,
      traceNo: data.traceNo,
      ptnrTransactionLogId: data.ptnrTransactionLogId,
      paymentUrl: data.paymentUrl,
    });
  } catch (error) {
    console.warn(
      `⚠️  ITGI proposal ${data.orderNo} succeeded but its payment form could not be built: ${error.message}`
    );
    return null;
  }
}

// ── Quote ───────────────────────────────────────────────────────────────────

// POST /iffcotokio/premium
//
// Body is ITGI's premium request (uniqueReferenceNo, contractType, health{…}).
// contractType defaults to ITGI_CONTRACT_TYPE and partnerDetail.partnerCode to
// ITGI_PARTNER_CODE, so a caller sends neither.
export const getPremium = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus } = await itgiApi.getPremium(req.body);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PREMIUM,
      operation: 'premium',
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data.raw,
      correlationId: request.uniqueReferenceNo,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      contractType: request.contractType,
      data,
      itgiRequest: exchange,
    });
  } catch (error) {
    console.error('❌ ITGI premium call failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PREMIUM,
      operation: 'premium',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.uniqueReferenceNo,
    });

    return respondWithError(res, error);
  }
};

// ── Proposal ────────────────────────────────────────────────────────────────

// POST /iffcotokio/proposal
//
// Returns orderNo + the hosted payment URL and the three hidden fields the
// browser posts to it. `itgiKYCReferenceNo` is mandatory — get it from
// /iffcotokio/kyc/fetch (or /kyc/create) — and ITGI check it against the
// proposer's own details, so it must be that person's reference.
export const submitProposal = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus } = await itgiApi.submitProposal(req.body);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PROPOSAL,
      operation: 'proposal',
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data.raw,
      // The orderNo is what every later call and the payment redirect key on.
      correlationId: data.orderNo || request.uniqueReferenceNo,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      contractType: request.contractType,
      data,
      // Ready to auto-submit — the SPA does not have to know ITGI's field names.
      //
      // Never allowed to fail the response: the proposal SUCCEEDED, and it
      // created something at ITGI. If their answer is missing a field the form
      // needs, the caller must still receive the orderNo — it is the identifier
      // every later call and their own support desk key on, and turning this
      // into a 400 would throw away the one thing worth keeping. `data` carries
      // the same three ids either way; only the assembled form is lost.
      payment: paymentFormFor(data),
      itgiRequest: exchange,
    });
  } catch (error) {
    console.error('❌ ITGI proposal call failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PROPOSAL,
      operation: 'proposal',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.uniqueReferenceNo,
    });

    return respondWithError(res, error);
  }
};

// ── Payment ─────────────────────────────────────────────────────────────────

// POST /iffcotokio/payment/initiate
//
// No upstream call: ITGI's payment is a browser round trip, so this only
// assembles the form. The proposal response already carries the same thing —
// this exists for the caller that has an orderNo but no longer has the response
// it came in (a resumed journey, a retried payment), so the gateway URL comes
// from configuration rather than from a value the browser has to have kept.
export const initiatePayment = async (req, res) => {
  const startedAt = Date.now();

  try {
    const form = buildPaymentForm({
      orderNo: req.body?.orderNo,
      traceNo: req.body?.traceNo,
      ptnrTransactionLogId: req.body?.ptnrTransactionLogId,
      paymentUrl: req.body?.paymentUrl,
    });

    await audit({
      req,
      apiName: ITGI_API_NAMES.PAYMENT_INITIATE,
      startedAt,
      requestPayload: form.fields,
      responsePayload: { gatewayUrl: form.gatewayUrl },
      correlationId: req.body?.orderNo,
    });

    return res.status(200).json({ status: 'SUCCESS', ...form });
  } catch (error) {
    // Nothing was called upstream, so there is no api_transactions row to write
    // — the failure goes on journey_events as an ERROR, the same way the
    // NivaBupa payment validation failure does.
    await journeyService.safeSave('itgiPaymentValidation', () => logRepo.recordError({
      journeyId: req.journeyId || null,
      message: 'ITGI payment/initiate rejected',
      errorCode: error.code || 'ITGI_VALIDATION_ERROR',
      errorMessage: error.message,
    }));

    return respondWithError(res, error);
  }
};

// GET|POST /iffcotokio/payment/return
//
// ⚠️ THIS IS THE ONLY CHANNEL BY WHICH A POLICY NUMBER REACHES US.
//
// ITGI collect the premium on their own page and issue the policy themselves —
// partner-end confirmation is disabled for our partner code — so nothing in our
// flow ever learns the policy number except this redirect:
//
//   {responseUrl}?ITGIResponse=product|orderNo|traceNo|policyNo|premium|message
//
// The URL is registered with ITGI against our partner code, so its path is
// fixed on their side and must stay publicly reachable at a stable address.
// Six live UAT payments on 2026-08-26 landed on a host that had no handler for
// it: every one answered "Route not found" and every policy number was lost.
//
// Answered with a 302 into the SPA rather than JSON, because this request IS
// the buyer's browser arriving back from the gateway — the same reason the
// NivaBupa callback redirects. Registered for both GET and POST: the observed
// redirects are GETs carrying a query string, but a payment outcome is not the
// place to assume the method will never change.
export const handlePaymentReturn = async (req, res) => {
  const startedAt = Date.now();
  const redirectBase = `${config.frontendUrl}${config.itgi.frontendReturnPath}`;

  // Logged verbatim, before anything is read out of it.
  console.log('\n========== ITGI Payment Callback Received ==========');
  console.log('Timestamp  :', new Date().toISOString());
  console.log('Request URL:', req.originalUrl);
  console.log('Method     :', req.method);
  console.log('Query      :', req.query);
  console.log('Body       :', req.body);
  console.log('===================================================');

  // The value can arrive on either side depending on how ITGI redirect.
  const source = { ...(req.query || {}), ...(req.body || {}) };
  const parsed = parsePaymentResponse(source);

  try {
    if (!parsed.present) {
      // Deliberately not thrown: the buyer is standing in front of a browser
      // and must land somewhere, and there is nothing to reconcile — no
      // ITGIResponse means no payment outcome was reported at all.
      console.warn('⚠️  ITGI callback carried no ITGIResponse parameter.');
    } else {
      console.log('   Order     :', parsed.orderNo);
      console.log('   Policy    :', parsed.policyNo);
      console.log('   Premium   :', parsed.premiumPayable);
      console.log('   Outcome   :', parsed.message, parsed.description ? `— ${parsed.description}` : '');
    }

    await audit({
      req,
      apiName: ITGI_API_NAMES.PAYMENT_CALLBACK,
      startedAt,
      httpStatus: 200,
      requestPayload: source,
      responsePayload: parsed,
      // A callback that reported anything other than SUCCESS, or carried no
      // ITGIResponse at all, is recorded as FAILED so it is findable: money may
      // have moved without a policy, and this row is the only record of it.
      errorMessage: parsed.succeeded
        ? null
        : `ITGI payment callback: ${parsed.present ? (parsed.message || 'unknown outcome') : 'no ITGIResponse parameter'}`,
      correlationId: parsed.policyNo || parsed.orderNo || null,
    });

    const query = new URLSearchParams({
      status: parsed.succeeded ? 'SUCCESS' : (parsed.message || 'ERROR'),
      // The policy number is the whole point of this handler. It exists nowhere
      // else, so it goes to the SPA even when the outcome was not a success.
      policyNumber: parsed.policyNo || '',
      orderNo: parsed.orderNo || '',
      traceNo: parsed.traceNo || '',
      premium: parsed.premiumPayable != null ? String(parsed.premiumPayable) : '',
      product: parsed.product || '',
    });
    if (!parsed.succeeded && parsed.description) query.set('message', parsed.description);
    if (!parsed.present) query.set('message', 'ITGI returned no payment outcome');
    // Present when the caller carried a journey through the ITGI flow, so the
    // SPA can rehydrate on landing rather than rebuilding from the query string.
    if (req.journey) {
      query.set('journeyId', req.journey.uuid);
      query.set('resumeToken', req.journey.resume_token);
    }

    console.log('   Redirecting to:', `${redirectBase}?${query.toString()}`);
    return res.redirect(302, `${redirectBase}?${query.toString()}`);
  } catch (error) {
    // A callback that arrived but could not be processed is the worst case in
    // this flow: money may have moved and the policy number is in a query
    // string nothing recorded. Persist the raw callback before redirecting.
    console.error('❌ ITGI payment callback processing failed:', error.message);
    console.error(error.stack);

    await journeyService.safeSave('itgiPaymentCallbackFailure', () => logRepo.recordApiTransaction({
      journeyId: req.journeyId || null,
      apiName: ITGI_API_NAMES.PAYMENT_CALLBACK,
      direction: 'INBOUND',
      status: 'FAILED',
      requestPayload: source,
      errorMessage: error.message,
      correlationId: parsed.policyNo || parsed.orderNo || null,
    }));

    const query = new URLSearchParams({
      status: 'ERROR',
      message: 'The payment outcome could not be processed. Do not pay again — quote the order number to support.',
      policyNumber: parsed.policyNo || '',
      orderNo: parsed.orderNo || '',
    });
    return res.redirect(302, `${redirectBase}?${query.toString()}`);
  }
};

// POST /iffcotokio/payment/confirmation
//
// Only usable when premium is collected at OUR end. ITGI have that switched off
// for our partner code and answer "Payment at partner end is not allowed for
// this product." — see the service. Exposed so the flow is complete the day
// they enable it.
export const confirmPayment = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus } = await itgiApi.confirmPayment(req.body);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PAYMENT_CONFIRMATION,
      operation: 'paymentConfirmation',
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data.raw,
      correlationId: request.orderNo,
    });

    return res.status(200).json({ status: 'SUCCESS', data, itgiRequest: exchange });
  } catch (error) {
    console.error('❌ ITGI payment confirmation failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.PAYMENT_CONFIRMATION,
      operation: 'paymentConfirmation',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.orderNo,
    });

    return respondWithError(res, error);
  }
};

// ── Policy document ─────────────────────────────────────────────────────────

// POST /iffcotokio/policy-download
//
// Takes { policyDownloadNo } — the POLICY number from the payment redirect.
// `orderNo` is accepted as a fallback only because a caller holding one and not
// the other is the common case immediately after issuance; ITGI answer "Policy
// number not found against your partner code" for an orderNo, which is correct
// and not a bug.
export const downloadPolicy = async (req, res) => {
  const startedAt = Date.now();

  try {
    const input = { ...req.body };
    if (!input.policyDownloadNo && input.orderNo) input.policyDownloadNo = input.orderNo;

    const { data, request, exchange, httpStatus } = await itgiApi.downloadPolicy(input);

    await audit({
      req,
      apiName: ITGI_API_NAMES.POLICY_DOWNLOAD,
      operation: 'policyDownload',
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data.raw,
      correlationId: request.policyDownloadNo,
    });

    return res.status(200).json({ status: 'SUCCESS', data, itgiRequest: exchange });
  } catch (error) {
    console.error('❌ ITGI policy download failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.POLICY_DOWNLOAD,
      operation: 'policyDownload',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.policyDownloadNo || req.body?.orderNo,
    });

    return respondWithError(res, error);
  }
};

// ── CKYC ────────────────────────────────────────────────────────────────────

// POST /iffcotokio/kyc/fetch
//
// The only source of `itgiKYCReferenceNo`. `No Record` is an outcome, not a
// failure: it answers 200 with noRecord true so the caller can offer to create.
export const fetchCkyc = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, exchange, httpStatus } = await itgiCkyc.fetchCkyc(req.body);

    await audit({
      req,
      apiName: ITGI_API_NAMES.KYC_FETCH,
      operation: 'kycFetch',
      startedAt,
      httpStatus,
      // The search request carries a PAN/Aadhaar number and a mobile. It is
      // stored because a KYC search that produced the wrong answer cannot be
      // investigated without knowing what was asked; forAudit() redacts
      // credential-shaped keys and truncates anything large (utils/sanitize.js).
      requestPayload: exchange?.requestBody || req.body,
      responsePayload: { status: data.status, verified: data.verified, noRecord: data.noRecord },
      errorMessage: null,
    });

    return res.status(200).json({ status: 'SUCCESS', data, itgiRequest: exchange });
  } catch (error) {
    console.error('❌ ITGI CKYC fetch failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.KYC_FETCH,
      operation: 'kycFetch',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
    });

    return respondWithError(res, error);
  }
};

// POST /iffcotokio/kyc/create
//
// WRITES a record at ITGI and, through them, at CERSAI. Only ever to be reached
// from an explicit customer action after a `No Record` search — it is slow (44s
// observed) and it is not idempotent.
export const createCkyc = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, exchange, httpStatus } = await itgiCkyc.createCkyc(req.body);

    await audit({
      req,
      apiName: ITGI_API_NAMES.KYC_CREATE,
      operation: 'kycCreate',
      startedAt,
      httpStatus,
      // The base64 document uploads are truncated by forAudit before storage —
      // the audit row records that a create was attempted and with what
      // metadata, not multi-megabyte scans of somebody's PAN card.
      requestPayload: exchange?.requestBody || req.body,
      responsePayload: { status: data.status, recordCreated: data.recordCreated, documentStored: data.documentStored },
    });

    return res.status(200).json({ status: 'SUCCESS', data, itgiRequest: exchange });
  } catch (error) {
    console.error('❌ ITGI CKYC create failed:', error.details || error.message);

    await audit({
      req,
      apiName: ITGI_API_NAMES.KYC_CREATE,
      operation: 'kycCreate',
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
    });

    return respondWithError(res, error);
  }
};

// ── Configuration probe ─────────────────────────────────────────────────────

// GET /iffcotokio/config/test
//
// Reports whether this process can reach ITGI at all, without calling them and
// without printing a single value. The NivaBupa equivalent is
// GET /nivabupa/token/test; ITGI have no token endpoint to test against, so
// what is checkable is the configuration itself.
export const testConfig = async (req, res) => {
  try {
    itgiApi.assertConfigured();
    return res.status(200).json({
      status: 'SUCCESS',
      message: 'IFFCO Tokio is configured',
      // Host and path only — never the credential, never the partner code.
      premiumEndpoint: itgiApi.endpointFor('premium'),
      paymentGatewayUrl: paymentGatewayUrl(),
      contractTypeDefault: config.itgi.defaultContractType,
      // What ITGI hold as our payment response URL, if this deployment was told.
      // A mismatch between this and the route actually served is invisible until
      // a real payment lands on a 404 and the policy number is lost.
      registeredPaymentReturnUrl: config.itgi.returnUrl,
    });
  } catch (error) {
    return respondWithError(res, error);
  }
};
