import config, {
  missingFgVariables, missingFgPaymentVariables, fgIsUnconfigured,
} from '../config/env.js';
import * as fgApi from '../services/fgApi.service.js';
import * as fgCkyc from '../services/fgCkyc.service.js';
import * as fgPayment from '../services/fgPayment.service.js';
import * as fgPdf from '../services/fgPdf.service.js';
import * as journeyService from '../services/journey.service.js';
import * as logRepo from '../repositories/log.repository.js';
import { FG_API_NAMES } from '../constants/fg.constants.js';
import { gatewayUrl } from '../helpers/fgPayment.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Future Generali endpoints.
//
// Pass-throughs, in the same sense the NivaBupa and IFFCO Tokio controllers
// are: the caller sends the adapter's documented request shape
// ({ product, policy, client, risk, receipt? }) and gets FG's answer back. What
// this layer adds is the partner identity (from config, never from the
// browser), the payment round trip a single-page app cannot perform on its own,
// and an audit row per call.
//
// ── The response envelope is deliberately NOT the ITGI one ──────────────────
// These routes answer `{ ok, provider, operation, data, meta }` on success and
// `{ ok:false, error:{ code, message, provider, details } }` on failure —
// the envelope of the standalone integration service this integration was
// migrated FROM, not the flat `{ status:'ERROR', code, … }` shape the ITGI
// routes use.
//
// That is a choice, not an oversight. The SPA's Future Generali pages
// (pages/FgProposal.jsx, pages/FgReturn.jsx, utils/fgQuote.js) are already
// written against this envelope and read `response.data` for a quote, `res.ok`
// for an issuance and `res.kind` for a document. Changing it here would mean
// rewriting all of them to gain nothing a buyer or an operator can see, and
// every one of those rewrites is a chance to break a flow that works. The
// migration therefore moves the ROUTES and the BASE URL, and leaves the
// contract on both sides of the hop alone — the same discipline the IFFCO Tokio
// migration used when it kept ITGI's own request and response bodies.
//
// Every response additionally carries `fgRequest`: the URL, headers
// (credentials fingerprinted, never printed) and the complete body that went
// upstream. FG's single generic rejection is an EMPTY *Result with no reason
// attached, so the payload that produced one is the only thing that makes it
// diagnosable at all — the same reason the NivaBupa routes return
// `nivabupaRequest` and the ITGI ones `itgiRequest`.
//
// Persistence: FG calls are audited into the existing api_transactions table via
// recordStandaloneApiCall, with the journey id when the caller sent one. They do
// NOT write the typed journey_quotes / journey_proposals rows — those columns
// are shaped around NivaBupa's envelopes, and mapping FG's into them would mean
// either changing that schema or storing something misleading. This is the same
// decision the IFFCO Tokio controller made, for the same reason.
// ─────────────────────────────────────────────────────────────────────────────

// The failure envelope. `error.status` is set by the service layer: 400 for a
// local validation failure, 503 when FG is not configured, 504 on a timeout,
// 502 for anything FG rejected or could not answer. Anything without one is a
// bug in this service, not an upstream failure, so it answers 500.
function respondWithError(res, error) {
  return res.status(error.status || 500).json({
    ok: false,
    error: {
      code: error.code || 'FG_ERROR',
      message: error.message,
      provider: 'future-generali',
      ...(error.field ? { field: error.field } : {}),
      details: error.details || null,
    },
    fgRequest: error.exchange || null,
  });
}

// The success envelope every quote/proposal/issue route answers with.
function envelope(operation, data, meta = {}) {
  return {
    ok: data?.ok !== false,
    provider: 'future-generali',
    operation,
    data,
    meta,
  };
}

// One audit row per FG call, success or failure. Never throws: a failed audit
// write must not turn a successful quote into a 500 (recordStandaloneApiCall
// goes through journey.service's safeSave, and log.repository swallows its own
// errors on top).
function audit({
  req, apiName, startedAt, httpStatus, requestPayload, responsePayload, errorMessage, correlationId,
  endpointUrl,
}) {
  return journeyService.recordStandaloneApiCall({
    journeyId: req.journeyId || null,
    apiName,
    httpMethod: 'POST',
    endpointUrl: endpointUrl ?? safeEndpoint(),
    status: errorMessage ? 'FAILED' : 'SUCCESS',
    httpStatus: httpStatus || null,
    durationMs: Date.now() - startedAt,
    requestPayload,
    responsePayload,
    errorMessage,
    correlationId,
  });
}

// endpoint() throws when FG is unconfigured; an audit row must not be the thing
// that turns that into a 500, so the URL is simply omitted.
function safeEndpoint() {
  try {
    return fgApi.endpoint();
  } catch {
    return null;
  }
}

// FG's business rejections arrive as HTTP 200 with ok:false and their own
// plain-English wording ("The minimum sum insured shall be 500000"). Those are
// answers, not failures — but they are still worth finding in the audit table,
// so the row records why while the response stays a 200.
function businessFailure(data) {
  if (!data || data.ok !== false) return null;
  return `Future Generali rejected the request: ${data.errorMessage || data.status || 'no reason given'}`;
}

// ── Quote ───────────────────────────────────────────────────────────────────

// POST /future-generali/quote
//
// CreatePolicy with METHOD=ENQ. A premium enquiry only — nothing is created at
// FG, so this is the one FG call that is safe to retry.
export const getQuote = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus, product } = await fgApi.getQuote(req.body);

    await audit({
      req,
      apiName: FG_API_NAMES.QUOTE,
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data,
      errorMessage: businessFailure(data),
      correlationId: req.body?.policy?.uid || null,
    });

    return res.status(200).json({
      ...envelope('getQuote', data, { httpStatus, product: product.product }),
      fgRequest: exchange,
    });
  } catch (error) {
    console.error('❌ FG quote failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.QUOTE,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: error.exchange?.requestBody || req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.policy?.uid || null,
    });

    return respondWithError(res, error);
  }
};

// ── Proposal ────────────────────────────────────────────────────────────────

// POST /future-generali/proposal
//
// HealthPreCRTValidate with METHOD=CRT. Validates the full proposal and returns
// FG's transaction reference (strPreCRTTranID) on success.
//
// Two things a caller does not have to know about, because the service handles
// them: FG's client handshake (the first CRT call for a new customer fails with
// "Please retry with Client ID <n>", and the same request is replayed once with
// it), and that <Receipt><Amount> is required on THIS call and not only on
// issuance — an empty one is answered "Fail_Ex", a token that names nothing.
export const createProposal = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus, clientId } = await fgApi.createProposal(req.body);

    await audit({
      req,
      apiName: FG_API_NAMES.PROPOSAL,
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data,
      errorMessage: businessFailure(data),
      // FG's own reference for the attempt, present even on a rejection — it is
      // what they ask for when a proposal is queried.
      correlationId: data.preCrtTranId || req.body?.policy?.uid || null,
    });

    return res.status(200).json({
      ...envelope('createProposal', data, { httpStatus, clientId }),
      fgRequest: exchange,
    });
  } catch (error) {
    console.error('❌ FG proposal failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.PROPOSAL,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: error.exchange?.requestBody || req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.policy?.uid || null,
    });

    return respondWithError(res, error);
  }
};

// POST /future-generali/issue
//
// CreatePolicy with METHOD=CRT and a filled Receipt. The RAW issuance call, for
// reconciliation and support.
//
// ⚠️ The normal journey must use POST /future-generali/payment/issue instead:
// that one maps FG's payment references into the receipt and refuses to issue
// twice against one premium. This route does neither, so a caller that gets the
// receipt wrong here can buy a second policy with one payment.
export const issuePolicy = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, request, exchange, httpStatus, clientId } = await fgApi.issuePolicy(req.body);

    await audit({
      req,
      apiName: FG_API_NAMES.ISSUE,
      startedAt,
      httpStatus,
      requestPayload: request,
      responsePayload: data,
      errorMessage: businessFailure(data),
      correlationId: data.policyNo || req.body?.receipt?.uniqueTranKey || null,
    });

    return res.status(200).json({
      ...envelope('issuePolicy', data, { httpStatus, clientId }),
      fgRequest: exchange,
    });
  } catch (error) {
    console.error('❌ FG issuance failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.ISSUE,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: error.exchange?.requestBody || req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.receipt?.uniqueTranKey || null,
    });

    return respondWithError(res, error);
  }
};

// ── CKYC ────────────────────────────────────────────────────────────────────
//
// Both routes answer the NORMALISED CKYC object directly rather than wrapping it
// in the envelope above — which is what the SPA's parseFgCkyc reads, and what
// the standalone service returned. GC-CKYC 3.0.0 and the legacy NL-CKYC service
// normalise to the same keys, so nothing downstream branches on which answered.

// POST /future-generali/ckyc/create
//
// Submits the identity. If CERSAI hold a record the KYC completes outright;
// otherwise `uploadUrl` is returned for the customer to complete verification on
// FG's own hosted page — there is no document-upload API of any kind in FG's
// kit, so that link is the only route they provide.
//
// ⚠️ Pass `proposalId` when RETRYING. GC-CKYC resume that verification and
// return the same id and URL; without it a retry mints a NEW record and orphans
// anything the customer has already uploaded.
export const createCkyc = async (req, res) => {
  const startedAt = Date.now();

  try {
    const { data, exchange, httpStatus } = await fgCkyc.createCKYC(req.body);

    await audit({
      req,
      apiName: FG_API_NAMES.CKYC_CREATE,
      startedAt,
      httpStatus,
      endpointUrl: exchange?.url || null,
      // The request carries a PAN or Aadhaar number and a DOB. It is stored
      // because a KYC that produced the wrong answer cannot be investigated
      // without knowing what was asked.
      requestPayload: exchange?.requestBody || req.body,
      responsePayload: {
        flavour: data.flavour,
        proposalId: data.proposalId,
        finalStatus: data.finalStatus,
        hasCkycNumber: Boolean(data.ckycNumber),
        hasUploadUrl: Boolean(data.uploadUrl),
      },
      errorMessage: data.ok ? null : (data.errorMessage || data.message || null),
      correlationId: data.proposalId || req.body?.reqId || null,
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('❌ FG CKYC create failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.CKYC_CREATE,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: req.body,
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: req.body?.reqId || null,
    });

    return respondWithError(res, error);
  }
};

// POST /future-generali/ckyc/status
//
// Poll until finalStatus is 1 or 3. A 0 means the KYC has not completed, with
// the reason in `message` — which is the only field that says anything a
// customer could act on, so it is surfaced rather than left in `raw`.
export const getCkycStatus = async (req, res) => {
  const startedAt = Date.now();
  const proposalId = req.body?.proposalId;

  try {
    const { data, exchange, httpStatus } = await fgCkyc.getStatus(proposalId);

    await audit({
      req,
      apiName: FG_API_NAMES.CKYC_STATUS,
      startedAt,
      httpStatus,
      endpointUrl: exchange?.url || null,
      requestPayload: { proposalId },
      responsePayload: {
        flavour: data.flavour,
        finalStatus: data.finalStatus,
        hasCkycNumber: Boolean(data.ckycNumber),
        message: data.message,
      },
      errorMessage: data.ok ? null : (data.errorMessage || null),
      correlationId: proposalId || null,
    });

    return res.status(200).json(data);
  } catch (error) {
    console.error('❌ FG CKYC status failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.CKYC_STATUS,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: { proposalId },
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: proposalId || null,
    });

    return respondWithError(res, error);
  }
};

// ── Payment ─────────────────────────────────────────────────────────────────

// POST /future-generali/payment/session
//
// No upstream call: FG expose no payment API, so this only assembles the form
// the browser POSTs to their gateway, CheckSum included. The checksum is built
// HERE rather than in the browser because it must match the posted values
// exactly, and the response key must never reach a bundle.
//
// ⚠️ PASS `proposal`. It is kept against the TransactionID, and the callback
// issues from it WITHOUT the browser taking part. Without it, the only copy of
// the payload FG validated is in the buyer's localStorage, and issuance depends
// on that surviving a trip to an external payment page — incognito, a cleared
// store, another device or a closed tab each collect the premium and leave
// nobody able to issue. Observed on UAT 2026-08-21 on a real ₹13,886 payment.
// The response says which case you are in, via `proposalHeldForIssuance`.
export const createPaymentSession = async (req, res) => {
  const startedAt = Date.now();

  try {
    const session = fgPayment.createSession(req.body);

    await audit({
      req,
      apiName: FG_API_NAMES.PAYMENT_SESSION,
      startedAt,
      httpStatus: 200,
      endpointUrl: session.url,
      // Field NAMES and the identifiers, never the customer's contact details
      // and never the CheckSum.
      requestPayload: {
        transactionId: req.body?.transactionId,
        proposalNumber: req.body?.proposalNumber,
        paymentOption: req.body?.paymentOption,
        premiumAmount: req.body?.premiumAmount,
        proposalHeldForIssuance: session.proposalHeldForIssuance,
      },
      responsePayload: {
        gatewayUrl: session.url,
        fields: session.fields.map((field) => field.name),
      },
      correlationId: req.body?.transactionId || null,
    });

    return res.status(200).json(session);
  } catch (error) {
    // Nothing was called upstream, so there is no api_transactions row to write
    // — the failure goes on journey_events as an ERROR, the same way the ITGI
    // payment validation failure does.
    await journeyService.safeSave('fgPaymentValidation', () => logRepo.recordError({
      journeyId: req.journeyId || null,
      message: 'FG payment/session rejected',
      errorCode: error.code || 'FG_VALIDATION_ERROR',
      errorMessage: error.message,
    }));

    return respondWithError(res, error);
  }
};

// ALL /future-generali/payment/return
//
// ⚠️ THIS IS THE ONLY CHANNEL BY WHICH A PAYMENT OUTCOME REACHES US.
//
// FG collect the premium on their own gateway page and POST the outcome —
// ENCRYPTED — to the ResponseURL sent on the payment form. A static SPA route
// cannot read a POST body and must never hold the decryption key, so this route
// decrypts it, keeps the result, and sends the browser on with an OPAQUE token.
// No payment detail ever travels in a URL, a referrer header or a log.
//
// Registered for every method: the observed callback is a form POST, but a
// payment outcome is not the place to assume that will never change, and the
// route must never 404 — a callback that lands on nothing is a buyer who paid
// and whose references are gone.
//
// Answered with a 303 rather than JSON because this request IS the buyer's
// browser arriving back from the gateway.
export const handlePaymentReturn = async (req, res) => {
  const startedAt = Date.now();
  const redirectBase = `${config.frontendUrl}${config.fg.frontendReturnPath}`;

  // Logged verbatim, before anything is read out of it.
  console.log('\n========== FG Payment Callback Received ==========');
  console.log('Timestamp  :', new Date().toISOString());
  console.log('Request URL:', req.originalUrl);
  console.log('Method     :', req.method);
  console.log('Query keys :', Object.keys(req.query || {}));
  console.log('Body keys  :', Object.keys(req.body || {}));
  console.log('=================================================');

  // The value can arrive on either side depending on how FG redirect.
  const source = { ...(req.query || {}), ...(req.body || {}) };
  let token = null;
  let parsed = null;

  try {
    const outcome = fgPayment.handleReturn(source, { journeyId: req.journeyId || null });
    token = outcome.token;
    parsed = outcome.result;

    console.log(`   Outcome  : ${parsed.status}`);
    console.log(`   WS_P_ID  : ${parsed.wsPId || '—'}`);
    console.log(`   PGID     : ${parsed.pgid || '—'}`);

    await audit({
      req,
      apiName: FG_API_NAMES.PAYMENT_CALLBACK,
      startedAt,
      httpStatus: 200,
      endpointUrl: null,
      // The raw callback, kept because it is the ONLY durable record of this
      // payment if the in-memory token mapping is lost to a restart. The
      // ciphertext is the whole point of keeping it: it can be decrypted again.
      requestPayload: source,
      responsePayload: {
        status: parsed.status,
        wsPId: parsed.wsPId,
        pgid: parsed.pgid,
        transactionId: parsed.transactionId,
        premium: parsed.premium,
        encrypted: parsed.encrypted,
        duplicate: outcome.duplicate,
      },
      // Anything other than a verified success is recorded as FAILED so it is
      // findable: money may have moved without a policy, and this row is the
      // only record of it.
      errorMessage: parsed.ok
        ? null
        : `FG payment callback: ${parsed.status}${parsed.error ? ` — ${parsed.error}` : ''}`,
      correlationId: parsed.wsPId || parsed.transactionId || null,
    });

    const url = `${redirectBase}${redirectBase.includes('?') ? '&' : '?'}ref=${encodeURIComponent(token)}`;
    console.log('   Redirecting to:', `${redirectBase}?ref=…`);
    return res.redirect(303, url);
  } catch (error) {
    // A callback that ARRIVED but could not be processed is the worst case in
    // this flow: money may have moved and the references are in a body nothing
    // recorded. Persist the raw callback before redirecting, whatever else
    // fails — it is what reconciliation with FG is done from.
    console.error('❌ FG payment callback processing failed:', error.message);
    console.error(error.stack);

    await journeyService.safeSave('fgPaymentCallbackFailure', () => logRepo.recordApiTransaction({
      journeyId: req.journeyId || null,
      apiName: FG_API_NAMES.PAYMENT_CALLBACK,
      direction: 'INBOUND',
      status: 'FAILED',
      requestPayload: source,
      errorMessage: error.message,
      correlationId: parsed?.wsPId || null,
    }));

    // The SPA shows "we could not read this payment result — do not pay again"
    // for this, never "no payment received".
    const url = `${redirectBase}${redirectBase.includes('?') ? '&' : '?'}error=callback`;
    return res.redirect(303, url);
  }
};

// GET /future-generali/payment/result/:token
//
// What the return page reads. The token is opaque and short-lived.
export const getPaymentResult = async (req, res) => {
  const result = fgPayment.getResult(req.params.token);

  if (!result) {
    return res.status(404).json({
      ok: false,
      error: {
        code: 'PAYMENT_REF_UNKNOWN',
        message: 'This payment reference is unknown or has expired. If money has left the '
          + 'account, do NOT pay again — it can be reconciled with Future Generali from the '
          + 'callback recorded against this service.',
        provider: 'future-generali',
      },
    });
  }

  return res.status(200).json({
    ok: true,
    provider: 'future-generali',
    operation: 'paymentResult',
    data: result,
  });
};

// POST /future-generali/payment/issue
//
// Issues the policy for a paid proposal, mapping FG's payment references into
// the receipt (WS_P_ID → <UniqueTranKey>, PGID → <TranRefNo>) and issuing AT
// MOST ONCE per payment — so calling it twice is safe, and a repeated callback
// racing the returning page cannot buy two policies with one premium.
//
// `force` pushes past an attempt FG never ANSWERED. It is only ever set by a
// deliberate human action, because FG may already hold a policy for that
// payment.
export const issueAfterPayment = async (req, res) => {
  try {
    const outcome = await fgPayment.issueAfterPayment({
      token: req.body?.token,
      proposal: req.body?.proposal,
      force: req.body?.force === true,
      journeyId: req.journeyId || null,
    });
    // Already audited inside the service — the callback path starts issuance
    // without a request to hang an audit on, so it owns that write for both.
    return res.status(200).json(outcome);
  } catch (error) {
    console.error('❌ FG payment issuance failed:', error.details || error.message);
    return respondWithError(res, error);
  }
};

// ── Policy document ─────────────────────────────────────────────────────────

// GET /future-generali/policy/:policyNo/pdf
//
// JSON, so a caller can see what FG answered. `?meta=1` reports that WITHOUT
// pulling half a megabyte down with it, which is what makes polling cheap —
// and polling is necessary, because FG generate the document 15–25 seconds
// AFTER issuance and answer for it in the meantime exactly as they answer for a
// policy number they have never heard of.
export const getPolicyPdf = async (req, res) => {
  const startedAt = Date.now();
  const { policyNo } = req.params;

  try {
    const result = await fgPdf.getPdf({ policyNo, followUrl: req.query.meta !== '1' });

    await audit({
      req,
      apiName: FG_API_NAMES.POLICY_PDF,
      startedAt,
      httpStatus: result.httpStatus,
      endpointUrl: result.exchange?.url || null,
      requestPayload: { policyNo, meta: req.query.meta === '1' },
      // Never the document itself, and never its link.
      responsePayload: { kind: result.kind, bytes: result.bytes || null, ok: result.ok },
      errorMessage: result.ok ? null : (result.message || `kind=${result.kind}`),
      correlationId: policyNo,
    });

    // The exchange carries the full SOAP response, which on a successful fetch
    // is the document itself. Stripped from the body: the caller asked what FG
    // said, not for half a megabyte of base64 twice over.
    const { exchange, ...body } = result;
    return res.status(200).json(body);
  } catch (error) {
    console.error('❌ FG policy document failed:', error.details || error.message);

    await audit({
      req,
      apiName: FG_API_NAMES.POLICY_PDF,
      startedAt,
      httpStatus: error.details?.httpStatus || null,
      requestPayload: { policyNo },
      responsePayload: error.details || null,
      errorMessage: error.message,
      correlationId: policyNo,
    });

    return respondWithError(res, error);
  }
};

// GET /future-generali/policy/:policyNo/pdf/download
//
// Streams a real application/pdf, because a PDF is for the browser to render
// rather than for JavaScript to marshal through memory.
//
// `?download=1` sets Content-Disposition: attachment. That choice has to be made
// HERE rather than with an <a download> attribute in the page: the SPA is a
// different origin from this service, and a browser IGNORES that attribute
// cross-origin — without this, "Download" silently becomes "view", which is
// indistinguishable from the feature being broken.
export const downloadPolicyPdf = async (req, res) => {
  const { policyNo } = req.params;

  try {
    const result = await fgPdf.getPdf({ policyNo });

    if (!result.ok || !result.pdfBase64) {
      // FG generate the document a little after issuance and answer for it
      // exactly as they answer for a policy number they do not know. Telling the
      // buyer "no document" the moment they land from the payment page is wrong
      // far more often than it is right, so a retryable answer says to WAIT
      // rather than to phone the insurer. The policy itself is unaffected.
      const notReady = result.retryable === true || result.kind === 'empty';
      return res.status(notReady ? 404 : 502).json({
        ok: false,
        error: {
          code: notReady ? 'PDF_NOT_READY' : 'PDF_UNAVAILABLE',
          message: notReady
            ? 'The policy document is not available from Future Generali yet. It is usually '
              + 'ready within a few minutes of issuance — the policy itself is unaffected.'
            : result.message || `Future Generali returned no document (${result.kind}).`,
          provider: 'future-generali',
          details: {
            kind: result.kind,
            retryable: notReady,
            // FG's own words, kept so nothing is lost behind our sentence.
            upstreamMessage: result.message || null,
          },
        },
      });
    }

    const buffer = Buffer.from(result.pdfBase64, 'base64');
    const disposition = req.query.download === '1' ? 'attachment' : 'inline';
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `${disposition}; filename="${String(policyNo).replace(/[^\w.-]/g, '_')}.pdf"`
    );
    res.setHeader('Content-Length', buffer.length);
    return res.end(buffer);
  } catch (error) {
    console.error('❌ FG policy document download failed:', error.details || error.message);
    return respondWithError(res, error);
  }
};

// ── Configuration probe ─────────────────────────────────────────────────────

// GET /future-generali/config/test
//
// Reports whether this process can reach FG at all, without calling them and
// without printing a single value. FG have no token endpoint to test against —
// they identify the caller by codes inside the payload — so what is checkable
// is the configuration itself.
//
// The three legs are reported SEPARATELY because they fail independently: a
// deployment can quote perfectly while having no gateway configured, and the
// first sign of that gap would otherwise be a buyer who cannot pay.
export const testConfig = async (req, res) => {
  const missing = missingFgVariables();
  const paymentMissing = missingFgPaymentVariables();
  const ckycFlavour = fgCkyc.flavour();

  const ready = missing.length === 0;

  return res.status(ready ? 200 : 503).json({
    ok: ready,
    provider: 'future-generali',
    operation: 'configTest',
    data: {
      configured: ready,
      unconfigured: fgIsUnconfigured(),
      // Names only — never a credential, never a vendor or agent code.
      missing,
      quote: {
        ready,
        // Host and path only.
        endpoint: ready ? fgApi.endpoint() : null,
      },
      payment: {
        ready: ready && paymentMissing.length === 0,
        missing: paymentMissing,
        gatewayUrl: gatewayUrl() || null,
        // What FG are told to POST the outcome to. A mismatch between this and
        // the route this process actually serves is invisible until a real
        // payment lands on a 404 and the references are lost.
        responseUrl: config.fg.payment.returnUrl || null,
      },
      ckyc: {
        // 'gc-ckyc-3.0.0' | 'nl-ckyc' | 'none'
        flavour: ckycFlavour,
        ready: ckycFlavour !== 'none',
      },
      policyDocument: {
        ready,
        endpoint: ready ? fgPdf.endpoint() : null,
      },
      // Set via FG_BANCA_CHANNEL. Quoting works without it; the proposal and
      // issuance legs both fail with "BancaChannel Value INVALID" until FG issue
      // the correct value for the configured vendor code.
      bancaChannelSet: Boolean(config.fg.bancaChannel),
      frontendReturn: `${config.frontendUrl}${config.fg.frontendReturnPath}`,
    },
  });
};
