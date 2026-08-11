import * as nivabupaApi from '../services/genericApi.service.js';
import * as journeyService from '../services/journey.service.js';
import config from '../config/env.js';
import {
  applyBusinessDefaults,
  resolveTransactionNumber,
  logProposalPayloadAudit,
} from '../helpers/proposal.helper.js';

// Pass-through: caller sends the UW request shape (Proposal.POLICY / NOMINEE
// / MEMBER[] / PROPOSER, per UW request.txt) — same auth/forward mechanics
// as Premium.
//
// Response shape unchanged (status / payload / data); uwStatus is added when a
// journey is in context.
export const getUwDecision = async (req, res) => {
  const startedAt = Date.now();
  const journeyId = req.journeyId;
  const payload = req.body;

  try {
    // Channel constants only, and no transaction lookup: underwriting runs
    // before the buyer reaches the gateway, so no transaction number exists yet
    // and TRANSACTION_NUMBER is omitted rather than sent blank.
    //
    // PAYMENT_RECEIVED_FLAG is passed through rather than forced. The frontend
    // builder sends 'Y' on both calls per Niva Bupa's instruction ("always Y,
    // never N"), and this endpoint does not override it — but neither does it
    // stamp 'Y' onto a caller that deliberately sent something else, since at
    // this point in the flow no money has actually moved. Data Push, the call
    // Niva Bupa observed and the one that runs post-payment, does assert it.
    const { applied } = applyBusinessDefaults(payload, { enforcePaymentReceived: false });
    if (applied.length) {
      console.log('🔧 UW DECISION — business defaults applied:', applied);
    }
    logProposalPayloadAudit('UW DECISION', payload);

    const { data, exchange } = await nivabupaApi.getUwDecision(payload);

    // Autosave: the UW decision lands on the journey's proposal row so a buyer
    // who breaks after underwriting resumes at the review screen with the
    // decision intact, instead of being underwritten a second time.
    const saved = await journeyService.recordUwDecision({
      journeyId,
      requestPayload: payload,
      responsePayload: data,
      httpSucceeded: true,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.uwDecisionUrl,
      context: req.journeyContext,
    });

    return res.status(200).json({
      status: "SUCCESS",
      payload, // Request payload
      data,     // NivaBupa response
      // The full exchange — URL, headers and the body as sent. `payload` above
      // is the same object, but only this says which URL it went to and what
      // the business-defaults pass changed on the way (see the log line above);
      // the browser posted one body and a different one can leave here.
      nivabupaRequest: exchange,
      ...(saved ? { uwStatus: saved.uw_status, journeyId: req.journey.uuid } : {}),
    });
  } catch (error) {
    console.error("❌ NivaBupa UW decision call failed:", error.response?.data || error.message);
    console.log("📤 Request Payload:", req.body);

    await journeyService.recordUwDecision({
      journeyId,
      requestPayload: payload,
      responsePayload: error.response?.data || null,
      httpSucceeded: false,
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.uwDecisionUrl,
      errorMessage: error.message,
      context: req.journeyContext,
    });

    return res.status(502).json({
      status: "ERROR",
      message: error.message,
      payload: req.body, // Request payload
      nivabupa_response: error.response?.data || null,
      nivabupaRequest: error.exchange || null,
    });
  }
};

// Pass-through: caller sends the full proposal payload (per data push
// dictionary.xlsx) — pushes it to NivaBupa and returns their
// { RESPONSE: { STATUS, POLICY_CODE, STATUS_MESSAGE } } envelope.
//
// This is the step that produces the application number, so persisting its
// result is what lets a journey that breaks here check its own status later —
// POLICY_CODE is the only input /nivabupa/proposal-status accepts, and it is
// returned exactly once.
export const submitDataPush = async (req, res) => {
  const startedAt = Date.now();
  const journeyId = req.journeyId;

  try {
    // The gateway's own transaction id, taken from what the caller stamped on
    // the payload and otherwise recovered from this server's own payments row
    // (matched on SOURCING_APPNO). Never invented — see the helper.
    const { transactionNumber, paymentDate, source } = await resolveTransactionNumber(req.body, { journeyId });
    if (!transactionNumber) {
      console.warn(
        '⚠️  DATAPUSH — no payment transaction number available; TRANSACTION_NUMBER will be omitted. ' +
        'Check that the gateway callback landed and was correlated (nivabupa_journey_payments).'
      );
    }

    const { applied } = applyBusinessDefaults(req.body, {
      transactionNumber,
      // Only fall back to the stored timestamp when the caller sent none, so a
      // client that already stamped the callback's value keeps it.
      paymentDate: req.body?.Proposal?.POLICY?.PAYMENT_INFO?.PAYMENT_DATE || paymentDate,
    });
    if (applied.length) {
      console.log('🔧 DATAPUSH — business defaults applied:', applied);
    }
    // Printed immediately before the request goes upstream — the DATAPUSH API
    // trace in genericApi.service.js prints the full body right after this.
    logProposalPayloadAudit('DATAPUSH', req.body, { transactionSource: source });

    // { data, exchange } — `data` is NivaBupa's envelope, unchanged, so every
    // existing reader (the DB write below, the frontend's res.data.Response)
    // sees exactly what it did before. `exchange` is the new debugging half.
    const { data, exchange } = await nivabupaApi.submitDataPush(req.body);

    const saved = await journeyService.recordDataPush({
      journeyId,
      requestPayload: req.body,
      responsePayload: data,
      httpSucceeded: true,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.dataPushUrl,
      context: req.journeyContext,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      data,
      // What this server actually sent upstream — URL, headers and the complete
      // body — returned so it can be read in the browser's Network tab beside
      // NivaBupa's reply, instead of only in the server log. The body is a
      // verbatim echo of what the caller posted (this endpoint is a
      // pass-through), so it discloses nothing to that caller it did not
      // already hold; the parts it could not know are the URL, the headers and
      // the confirmation that nothing was rewritten in between.
      nivabupaRequest: exchange,
      ...(saved
        ? {
          journeyId: req.journey.uuid,
          applicationNumber: saved.application_number,
          datapushStatus: saved.datapush_status,
        }
        : {}),
    });
  } catch (error) {
    console.error('❌ NivaBupa data push failed:', error.response?.data || error.message);

    await journeyService.recordDataPush({
      journeyId,
      requestPayload: req.body,
      responsePayload: error.response?.data || null,
      httpSucceeded: false,
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.dataPushUrl,
      errorMessage: error.message,
      context: req.journeyContext,
    });

    return res.status(502).json({
      status: 'ERROR',
      message: error.message,
      nivabupa_response: error.response?.data || null,
      // The rejection is only actionable next to the payload that caused it,
      // which is exactly the case where reading the server log is least
      // convenient.
      nivabupaRequest: error.exchange || null,
    });
  }
};
