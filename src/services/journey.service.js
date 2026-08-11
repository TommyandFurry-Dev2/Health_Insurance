import config from '../config/env.js';
import db from '../db/index.js';
import * as userRepo from '../repositories/user.repository.js';
import * as journeyRepo from '../repositories/journey.repository.js';
import * as quoteRepo from '../repositories/quote.repository.js';
import * as proposalRepo from '../repositories/proposal.repository.js';
import * as kycRepo from '../repositories/kyc.repository.js';
import * as paymentRepo from '../repositories/payment.repository.js';
import * as policyRepo from '../repositories/policy.repository.js';
import * as logRepo from '../repositories/log.repository.js';
import {
  JOURNEY_STEPS,
  JOURNEY_STATUS,
  EVENT_TYPES,
  KYC_STATUS,
  POLICY_STATUS,
  UW_STATUS,
  resumeRouteFor,
} from '../constants/journey.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Persistence must never break the integration.
//
// Every NivaBupa endpoint in this service worked as a pass-through before
// journey persistence existed, and a buyer mid-purchase must not get a 500
// because MySQL is unreachable or a column overflowed. So every save the
// existing controllers make goes through safeSave(): failures are logged with
// full context and the request continues.
//
// The one deliberate exception is the journey API itself (create/resume) —
// there, a failed write means the caller asked for a journey and did not get
// one, so it throws.
// ─────────────────────────────────────────────────────────────────────────────
async function safeSave(label, fn) {
  try {
    return await fn();
  } catch (error) {
    console.error(`⚠️  Journey persistence failed [${label}]:`, error.message);
    if (config.env !== 'production') console.error(error.stack);
    return null;
  }
}

// ── Create / resume ─────────────────────────────────────────────────────────

// Mobile is the identity: it is the only field mandatory on both
// payment/initiate and proposal-status, so it is the one value guaranteed to
// exist for any journey that can reach payment.
async function createJourney(details = {}, context = {}) {
  return db.transaction(async (connection) => {
    const user = await userRepo.findOrCreateByMobile(details, connection);
    const journey = await journeyRepo.create(user.id, details, connection);

    await logRepo.recordEvent({
      journeyId: journey.id,
      eventType: EVENT_TYPES.JOURNEY_CREATED,
      toStep: JOURNEY_STEPS.JOURNEY_STARTED,
      message: `Journey created for ${user.mobile}`,
      metadata: { productCode: journey.product_code, insurerCode: journey.insurer_code },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    }, connection);

    return { journey, user };
  });
}

// Resume by token — the path a returning buyer's saved link or localStorage
// value takes. Extends expiry and counts the resume (see markResumed).
async function resumeByToken(resumeToken, context = {}) {
  const journey = await journeyRepo.findResumableByToken(resumeToken);
  if (!journey) return null;

  const refreshed = await journeyRepo.markResumed(journey.id);
  await logRepo.recordEvent({
    journeyId: journey.id,
    eventType: EVENT_TYPES.JOURNEY_RESUMED,
    toStep: refreshed.current_step,
    message: `Resumed at ${refreshed.last_completed_step || refreshed.current_step}`,
    metadata: { resumeCount: refreshed.resume_count },
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
  });

  return buildSnapshot(refreshed);
}

// Resume on login — the buyer authenticates with their mobile and gets their
// unfinished journeys back without having kept a token. This is what makes
// "restore on user login" work from a different device or after clearing
// browser storage.
async function findResumableForMobile(mobile) {
  const user = await userRepo.findByMobile(mobile);
  if (!user) return { user: null, journeys: [] };

  const journeys = await journeyRepo.findResumableByUserId(user.id);
  const summaries = await Promise.all(journeys.map((journey) => buildSummary(journey)));
  return { user, journeys: summaries };
}

// ── Snapshot (the restore payload) ──────────────────────────────────────────

// One read of every journey table, assembled into the exact state the SPA needs
// to rebuild its screens. This is what makes resume survive a server restart:
// nothing about a journey lives in process memory, so a fresh process serves
// the same snapshot the old one would have.
async function buildSnapshot(journey) {
  const [quotes, proposal, kyc, payments, policy, events] = await Promise.all([
    quoteRepo.listByJourney(journey.id, { successOnly: false }),
    proposalRepo.findByJourneyId(journey.id),
    kycRepo.findByJourneyId(journey.id),
    paymentRepo.listByJourney(journey.id),
    policyRepo.findByJourneyId(journey.id),
    logRepo.listEvents(journey.id, { limit: 25 }),
  ]);

  const selectedQuote = journey.selected_quote_id
    ? quotes.find((quote) => quote.id === journey.selected_quote_id) || null
    : null;

  // Members are fetched only for the quotes the UI will actually render — the
  // selected one, plus each quote in the comparison list.
  const quotesWithMembers = await Promise.all(
    quotes.map(async (quote) => ({
      ...quote,
      request_payload: db.fromJson(quote.request_payload),
      response_payload: db.fromJson(quote.response_payload),
      members: await quoteRepo.findMembers(quote.id),
    }))
  );

  const proposalWithMembers = proposal
    ? {
      ...proposal,
      uw_request_payload: db.fromJson(proposal.uw_request_payload),
      uw_response_payload: db.fromJson(proposal.uw_response_payload),
      datapush_request_payload: db.fromJson(proposal.datapush_request_payload),
      datapush_response_payload: db.fromJson(proposal.datapush_response_payload),
      members: await proposalRepo.findMembers(proposal.id),
    }
    : null;

  const restoreStep = journey.last_completed_step || journey.current_step;

  return {
    journey: {
      journeyId: journey.uuid,
      resumeToken: journey.resume_token,
      status: journey.status,
      currentStep: journey.current_step,
      lastCompletedStep: journey.last_completed_step,
      // Where the SPA should navigate. Derived from the step machine rather
      // than stored, so adding a step cannot leave a stale route in the DB.
      resumeRoute: resumeRouteFor(restoreStep),
      insurer: { code: journey.insurer_code, name: journey.insurer_name },
      productCode: journey.product_code,
      productVariant: journey.product_variant,
      channel: journey.channel,
      subchannel: journey.subchannel,
      sourcingSystem: journey.sourcing_system,
      agentId: journey.agent_id,
      stepData: db.fromJson(journey.step_data),
      resumeCount: journey.resume_count,
      lastActivityAt: journey.last_activity_at,
      expiresAt: journey.expires_at,
      createdAt: journey.created_at,
    },
    quotes: quotesWithMembers,
    selectedQuote: selectedQuote
      ? { ...selectedQuote, request_payload: db.fromJson(selectedQuote.request_payload) }
      : null,
    proposal: proposalWithMembers,
    kyc: kyc ? { ...kyc, request_payload: db.fromJson(kyc.request_payload), response_payload: db.fromJson(kyc.response_payload) } : null,
    payments: payments.map((payment) => ({
      ...payment,
      raw_callback_body: db.fromJson(payment.raw_callback_body),
      // encparam is a one-shot value for a gateway form POST that has already
      // been consumed; replaying a stale one sends the buyer to a dead session.
      encparam: undefined,
    })),
    policy: policy ? { ...policy, proposal_status_response: db.fromJson(policy.proposal_status_response) } : null,
    recentEvents: events,
  };
}

// Lightweight version for a "continue where you left off" list — no member
// rows, no payloads, one query per journey instead of six.
async function buildSummary(journey) {
  const [proposal, policy, payment] = await Promise.all([
    proposalRepo.findByJourneyId(journey.id),
    policyRepo.findByJourneyId(journey.id),
    paymentRepo.findLatestByJourney(journey.id),
  ]);

  const restoreStep = journey.last_completed_step || journey.current_step;
  return {
    journeyId: journey.uuid,
    resumeToken: journey.resume_token,
    status: journey.status,
    currentStep: journey.current_step,
    lastCompletedStep: journey.last_completed_step,
    resumeRoute: resumeRouteFor(restoreStep),
    productVariant: journey.product_variant,
    insurerName: journey.insurer_name,
    sumInsured: proposal?.sum_insured ?? null,
    totalPremium: proposal?.total_premium ?? null,
    applicationNumber: proposal?.application_number ?? null,
    policyNumber: policy?.policy_number ?? null,
    policyStatus: policy?.status ?? null,
    paymentStatus: payment?.status ?? null,
    lastActivityAt: journey.last_activity_at,
    expiresAt: journey.expires_at,
    createdAt: journey.created_at,
  };
}

async function getSnapshotByUuid(journeyUuid) {
  const journey = await journeyRepo.findByUuid(journeyUuid);
  return journey ? buildSnapshot(journey) : null;
}

// ── Step / form autosave ────────────────────────────────────────────────────

async function saveStep(journeyId, step, { stepData, fields, context } = {}) {
  return safeSave(`saveStep:${step}`, async () => db.transaction(async (connection) => {
    const before = await journeyRepo.findById(journeyId, connection);
    if (fields || stepData !== undefined) {
      await journeyRepo.patch(journeyId, { ...fields, stepData }, connection);
    }
    const after = await journeyRepo.advanceStep(journeyId, step, { connection });

    await logRepo.recordEvent({
      journeyId,
      eventType: EVENT_TYPES.STEP_COMPLETED,
      fromStep: before?.current_step,
      toStep: step,
      ipAddress: context?.ipAddress,
      userAgent: context?.userAgent,
    }, connection);

    return after;
  }));
}

// Marks which quote the buyer chose. Written to journeys.selected_quote_id
// rather than a flag on the quote row so exactly one selection is possible.
async function selectQuote(journeyId, quoteUuid, context = {}) {
  return safeSave('selectQuote', async () => db.transaction(async (connection) => {
    const quote = await quoteRepo.findByUuid(quoteUuid, connection);
    if (!quote || quote.journey_id !== journeyId) {
      throw new Error(`quote ${quoteUuid} does not belong to journey ${journeyId}`);
    }

    await journeyRepo.patch(journeyId, {
      selectedQuoteId: quote.id,
      productVariant: quote.product_variant,
      productCode: quote.product_code,
    }, connection);

    // The proposal is created here, carrying the selected quote's sum insured
    // and premium forward, so the proposer form has somewhere to autosave to
    // before any upstream call happens.
    const proposal = await proposalRepo.findOrCreate(journeyId, quote.id, connection);
    await proposalRepo.saveDetails(proposal.id, {
      sumInsured: quote.sum_insured,
      totalPremium: quote.total_premium,
      policyTerm: quote.policy_term,
      paymentFrequency: quote.payment_frequency,
    }, connection);

    const journey = await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.QUOTE_SELECTED, { connection });
    await logRepo.recordEvent({
      journeyId,
      eventType: EVENT_TYPES.STEP_COMPLETED,
      toStep: JOURNEY_STEPS.QUOTE_SELECTED,
      message: `Selected quote ${quote.uuid}`,
      metadata: { sumInsured: quote.sum_insured, totalPremium: quote.total_premium },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    }, connection);

    return { journey, quote };
  }));
}

async function saveProposalDetails(journeyId, details = {}, step, context = {}) {
  return safeSave('saveProposalDetails', async () => db.transaction(async (connection) => {
    const journey = await journeyRepo.findById(journeyId, connection);
    const proposal = await proposalRepo.findOrCreate(journeyId, journey?.selected_quote_id || null, connection);
    const saved = await proposalRepo.saveDetails(proposal.id, details, connection);

    if (step) {
      await journeyRepo.advanceStep(journeyId, step, { connection });
      await logRepo.recordEvent({
        journeyId,
        eventType: EVENT_TYPES.STEP_COMPLETED,
        toStep: step,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
      }, connection);
    }
    return saved;
  }));
}

async function saveKycStatus(journeyId, details = {}, context = {}) {
  return safeSave('saveKycStatus', async () => db.transaction(async (connection) => {
    const kyc = await kycRepo.saveStatus(journeyId, details, connection);
    const step = details.status === KYC_STATUS.VERIFIED
      ? JOURNEY_STEPS.KYC_COMPLETED
      : JOURNEY_STEPS.KYC_PENDING;

    await journeyRepo.advanceStep(journeyId, step, { connection });
    await logRepo.recordEvent({
      journeyId,
      eventType: EVENT_TYPES.STEP_COMPLETED,
      toStep: step,
      message: `KYC ${details.status || 'updated'}`,
      metadata: { method: details.method, referenceId: details.referenceId },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    }, connection);

    return kyc;
  }));
}

// ── Automatic save after each upstream call ─────────────────────────────────
// Called by the existing NivaBupa controllers. Each one writes the typed row,
// the api_transactions audit row, and advances the step in a single transaction
// so a crash cannot leave the journey pointing at a step whose data is missing.

async function recordPremiumCall({
  journeyId, journeyStep, requestPayload, responsePayload, httpSucceeded,
  httpStatus, durationMs, endpointUrl, errorMessage, context,
}) {
  return safeSave('recordPremiumCall', async () => db.transaction(async (connection) => {
    const apiTransactionId = await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'PREMIUM',
      journeyStep: journeyStep || JOURNEY_STEPS.QUOTE_GENERATED,
      endpointUrl,
      httpStatus,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      requestPayload,
      responsePayload,
      errorMessage,
    }, connection);

    if (!journeyId) return { apiTransactionId, quote: null };

    const quote = await quoteRepo.createFromPremiumCall({
      journeyId,
      requestPayload,
      responsePayload,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      errorMessage,
      apiTransactionId,
    }, connection);

    // Only a priced quote advances the journey — a failed premium call must not
    // move the restore point to QUOTE_GENERATED and resume the buyer onto a
    // comparison screen with nothing on it.
    if (httpSucceeded) {
      await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.QUOTE_GENERATED, { connection });
      await logRepo.recordEvent({
        journeyId,
        eventType: EVENT_TYPES.STEP_COMPLETED,
        toStep: JOURNEY_STEPS.QUOTE_GENERATED,
        message: `Quote ${quote.uuid} priced`,
        metadata: { totalPremium: quote.total_premium, sumInsured: quote.sum_insured },
        ipAddress: context?.ipAddress,
      }, connection);
    } else {
      await logRepo.recordEvent({
        journeyId,
        eventType: EVENT_TYPES.STEP_FAILED,
        toStep: JOURNEY_STEPS.QUOTE_GENERATED,
        errorMessage,
        ipAddress: context?.ipAddress,
      }, connection);
    }

    return { apiTransactionId, quote };
  }));
}

async function recordUwDecision({
  journeyId, requestPayload, responsePayload, httpSucceeded,
  httpStatus, durationMs, endpointUrl, errorMessage, context,
}) {
  return safeSave('recordUwDecision', async () => db.transaction(async (connection) => {
    await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'UW_DECISION',
      journeyStep: JOURNEY_STEPS.UW_DECISION,
      endpointUrl,
      httpStatus,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      requestPayload,
      responsePayload,
      errorMessage,
    }, connection);

    if (!journeyId) return null;

    const journey = await journeyRepo.findById(journeyId, connection);
    const proposal = await proposalRepo.findOrCreate(journeyId, journey?.selected_quote_id || null, connection);
    const saved = await proposalRepo.saveUwResult(proposal.id, {
      requestPayload, responsePayload, httpSucceeded, errorMessage,
    }, connection);

    // A DECLINED underwriting decision is terminal for the journey — there is
    // nothing to resume into, and leaving it IN_PROGRESS would keep offering
    // the buyer a purchase the insurer has refused.
    if (saved.uw_status === UW_STATUS.DECLINED) {
      await journeyRepo.setStatus(journeyId, JOURNEY_STATUS.FAILED, connection);
    } else if (httpSucceeded) {
      await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.UW_DECISION, { connection });
    }

    await logRepo.recordEvent({
      journeyId,
      eventType: httpSucceeded ? EVENT_TYPES.STEP_COMPLETED : EVENT_TYPES.STEP_FAILED,
      toStep: JOURNEY_STEPS.UW_DECISION,
      message: `UW ${saved.uw_status}`,
      errorMessage,
      metadata: { decisionCode: saved.uw_decision_code, referenceNo: saved.uw_reference_no },
      ipAddress: context?.ipAddress,
    }, connection);

    return saved;
  }));
}

async function recordDataPush({
  journeyId, requestPayload, responsePayload, httpSucceeded,
  httpStatus, durationMs, endpointUrl, errorMessage, context,
}) {
  return safeSave('recordDataPush', async () => db.transaction(async (connection) => {
    const result = proposalRepo.extractDataPush(responsePayload);

    await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'DATAPUSH',
      journeyStep: JOURNEY_STEPS.PROPOSAL_SUBMITTED,
      endpointUrl,
      httpStatus,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      requestPayload,
      responsePayload,
      errorMessage,
      correlationId: result.policyCode,
    }, connection);

    if (!journeyId) return null;

    const journey = await journeyRepo.findById(journeyId, connection);
    const proposal = await proposalRepo.findOrCreate(journeyId, journey?.selected_quote_id || null, connection);
    const saved = await proposalRepo.saveDataPushResult(proposal.id, {
      requestPayload, responsePayload, httpSucceeded, errorMessage,
    }, connection);

    if (saved.datapush_status === 'SUCCESS') {
      // The application number arrives here and nowhere else. It is the input
      // to /nivabupa/proposal-status, so a journey that breaks after data push
      // can only check its own status later because this row exists.
      const policy = await policyRepo.findOrCreate(journeyId, { proposalId: proposal.id }, connection);
      await policyRepo.saveIdentifiers(policy.id, {
        applicationNumber: saved.application_number,
        status: POLICY_STATUS.PENDING,
        sumInsured: saved.sum_insured,
        totalPremium: saved.total_premium,
      }, connection);

      await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.PROPOSAL_SUBMITTED, { connection });
    }

    await logRepo.recordEvent({
      journeyId,
      eventType: saved.datapush_status === 'SUCCESS' ? EVENT_TYPES.STEP_COMPLETED : EVENT_TYPES.STEP_FAILED,
      toStep: JOURNEY_STEPS.PROPOSAL_SUBMITTED,
      message: `Data push ${saved.datapush_status}`,
      errorMessage: saved.datapush_status_message || errorMessage,
      metadata: { applicationNumber: saved.application_number },
      ipAddress: context?.ipAddress,
    }, connection);

    return saved;
  }));
}

async function recordPaymentInitiate({
  journeyId, body, querystring, encparam, gatewayUrl,
  httpSucceeded, durationMs, endpointUrl, errorMessage, context,
}) {
  return safeSave('recordPaymentInitiate', async () => db.transaction(async (connection) => {
    await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'PAYMENT_ENCRYPT',
      journeyStep: JOURNEY_STEPS.PAYMENT_INITIATED,
      endpointUrl,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      // The plaintext querystring, not the body: it is what actually went into
      // the SOAP encrypt call, and encryptionKey is stripped by forAudit.
      requestPayload: { querystring },
      responsePayload: httpSucceeded ? { encparam: '[stored on journey_payments]' } : null,
      errorMessage,
      correlationId: body?.unqPolicyNumber,
    }, connection);

    if (!journeyId || !httpSucceeded) return null;

    const proposal = await proposalRepo.findByJourneyId(journeyId, connection);
    const payment = await paymentRepo.createAttempt({
      journeyId,
      proposalId: proposal?.id || null,
      body,
      querystring,
      encparam,
      gatewayUrl,
    }, connection);

    await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.PAYMENT_INITIATED, { connection });
    await logRepo.recordEvent({
      journeyId,
      eventType: EVENT_TYPES.STEP_COMPLETED,
      toStep: JOURNEY_STEPS.PAYMENT_INITIATED,
      message: `Payment attempt ${payment.attempt_no} initiated`,
      metadata: { unqPolicyNumber: payment.unq_policy_number, premiumValue: payment.premium_value },
      ipAddress: context?.ipAddress,
    }, connection);

    return payment;
  }));
}

// The gateway callback. Its request carries no journey identity at all — only
// the encrypted returnMessage — so the journey is recovered by looking up the
// unqPolicyNumber we stored at initiate time (see
// paymentRepo.findByCorrelation). This is the whole reason payment state has to
// be in a database rather than a session.
//
// Returns the journey so the controller can put journeyId + resumeToken in the
// redirect back to the SPA, which is what lets the buyer land in a restored app
// rather than a blank one.
async function recordPaymentCallback({ parsed, decrypted, rawBody, durationMs, context }) {
  return safeSave('recordPaymentCallback', async () => db.transaction(async (connection) => {
    const payment = await paymentRepo.findByCorrelation({
      uniqueReferenceId: parsed.uniqueReferenceId,
      uniqueReferenceNoRepeat: parsed.uniqueReferenceNoRepeat,
    }, connection);

    await logRepo.recordApiTransaction({
      journeyId: payment?.journey_id || null,
      apiName: 'PAYMENT_CALLBACK',
      journeyStep: JOURNEY_STEPS.PAYMENT_COMPLETED,
      direction: 'INBOUND',
      durationMs,
      // Reflects whether WE processed the callback, not what the gateway said.
      // An uncorrelated callback is a failure on our side even when the gateway
      // reported M001 — logging it SUCCESS would hide the one case that needs a
      // human: a payment that may have completed against a journey this backend
      // cannot find.
      status: (payment && parsed.paymentStatusDescription === 'SUCCESS') ? 'SUCCESS' : 'FAILED',
      requestPayload: rawBody,
      responsePayload: parsed,
      correlationId: parsed.uniqueReferenceId,
      errorMessage: payment
        ? (parsed.failedReason || null)
        : `No journey payment row matched callback reference "${parsed.uniqueReferenceId}" — gateway reported ${parsed.paymentStatusDescription}; reconcile manually`,
    }, connection);

    if (!payment) {
      console.error('⚠️  Payment callback could not be correlated to a journey. reference =', parsed.uniqueReferenceId);
      return null;
    }

    const saved = await paymentRepo.saveCallbackResult(payment.id, { parsed, decrypted, rawBody }, connection);
    const succeeded = saved.status === 'SUCCESS';

    if (succeeded) {
      const proposal = await proposalRepo.findByJourneyId(payment.journey_id, connection);
      const policy = await policyRepo.findOrCreate(payment.journey_id, {
        proposalId: proposal?.id || null,
        paymentId: saved.id,
      }, connection);

      await policyRepo.saveIdentifiers(policy.id, {
        policyNumber: parsed.uniqueReferenceId,
        applicationNumber: proposal?.application_number || null,
        status: POLICY_STATUS.PENDING,
        totalPremium: saved.payable_premium,
      }, connection);

      await journeyRepo.advanceStep(payment.journey_id, JOURNEY_STEPS.PAYMENT_COMPLETED, { connection });
    }

    await logRepo.recordEvent({
      journeyId: payment.journey_id,
      eventType: succeeded ? EVENT_TYPES.STEP_COMPLETED : EVENT_TYPES.STEP_FAILED,
      toStep: JOURNEY_STEPS.PAYMENT_COMPLETED,
      message: `Payment ${saved.status}`,
      errorMessage: parsed.failedReason || null,
      metadata: {
        paymentTransactionId: parsed.paymentTransactionId,
        gateway: parsed.paymentGatewayUsed,
      },
      ipAddress: context?.ipAddress,
    }, connection);

    const journey = await journeyRepo.findById(payment.journey_id, connection);
    return { payment: saved, journey };
  }));
}

// Recorded when the callback arrives but cannot be decrypted or parsed. Without
// this the failure exists only in stdout, and a buyer whose money moved would
// have no row anywhere linking the attempt to the outcome.
async function recordPaymentCallbackFailure({ rawBody, errorMessage, errorStack, referenceId }) {
  return safeSave('recordPaymentCallbackFailure', async () => db.transaction(async (connection) => {
    const payment = referenceId
      ? await paymentRepo.findByCorrelation({ uniqueReferenceId: referenceId }, connection)
      : null;

    await logRepo.recordApiTransaction({
      journeyId: payment?.journey_id || null,
      apiName: 'PAYMENT_CALLBACK',
      journeyStep: JOURNEY_STEPS.PAYMENT_COMPLETED,
      direction: 'INBOUND',
      status: 'FAILED',
      requestPayload: rawBody,
      errorMessage,
      correlationId: referenceId || null,
    }, connection);

    if (payment) {
      await paymentRepo.markCallbackError(payment.id, { message: errorMessage, rawBody }, connection);
      await logRepo.recordError({
        journeyId: payment.journey_id,
        toStep: JOURNEY_STEPS.PAYMENT_COMPLETED,
        message: 'Payment callback processing failed',
        errorMessage,
        errorStack,
      }, connection);
    }

    return payment;
  }));
}

async function recordProposalStatus({
  journeyId, requestPayload, responsePayload, httpSucceeded,
  httpStatus, durationMs, endpointUrl, errorMessage,
}) {
  return safeSave('recordProposalStatus', async () => db.transaction(async (connection) => {
    await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'PROPOSAL_STATUS',
      journeyStep: JOURNEY_STEPS.POLICY_ISSUED,
      endpointUrl,
      httpStatus,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      requestPayload,
      responsePayload,
      errorMessage,
      correlationId: requestPayload?.ApplicationNumber,
    }, connection);

    if (!journeyId || !httpSucceeded) return null;

    const proposal = await proposalRepo.findByJourneyId(journeyId, connection);
    const policy = await policyRepo.findOrCreate(journeyId, { proposalId: proposal?.id || null }, connection);
    const saved = await policyRepo.saveProposalStatus(policy.id, { responsePayload }, connection);

    if (saved.status === POLICY_STATUS.ISSUED) {
      await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.POLICY_ISSUED, { connection });
    }

    await logRepo.recordEvent({
      journeyId,
      eventType: EVENT_TYPES.STEP_COMPLETED,
      toStep: JOURNEY_STEPS.POLICY_ISSUED,
      message: `Policy status ${saved.status}`,
      metadata: { preIssuanceStatus: saved.pre_issuance_status, policyNumber: saved.policy_number },
    }, connection);

    return saved;
  }));
}

async function recordPolicyDownload({
  journeyId, policyNumber, responsePayload, httpSucceeded,
  httpStatus, durationMs, endpointUrl, errorMessage,
}) {
  return safeSave('recordPolicyDownload', async () => db.transaction(async (connection) => {
    await logRepo.recordApiTransaction({
      journeyId,
      apiName: 'POLICY_DOWNLOAD',
      journeyStep: JOURNEY_STEPS.POLICY_DOWNLOADED,
      endpointUrl,
      httpStatus,
      durationMs,
      status: httpSucceeded ? 'SUCCESS' : 'FAILED',
      requestPayload: { PolicyNumber: policyNumber },
      // forAudit truncates the base64 blob so the audit row stays small; the
      // document itself is stored once, on journey_policies.
      responsePayload,
      errorMessage,
      correlationId: policyNumber,
    }, connection);

    if (!journeyId || !httpSucceeded) return null;

    const policy = await policyRepo.findOrCreate(journeyId, {}, connection);
    const saved = await policyRepo.saveDocument(policy.id, { responsePayload }, connection);

    if (saved.document_available) {
      await journeyRepo.advanceStep(journeyId, JOURNEY_STEPS.POLICY_DOWNLOADED, { connection });
      await journeyRepo.setStatus(journeyId, JOURNEY_STATUS.COMPLETED, connection);
      // Rotated on completion so a resume link left in browser history or an
      // email cannot be replayed against a finished purchase.
      await journeyRepo.rotateResumeToken(journeyId, connection);
      await logRepo.recordEvent({
        journeyId,
        eventType: EVENT_TYPES.JOURNEY_COMPLETED,
        toStep: JOURNEY_STEPS.POLICY_DOWNLOADED,
        message: `Policy document stored for ${saved.policy_number || policyNumber}`,
      }, connection);
    }

    return saved;
  }));
}

// Audit-only: logs an upstream call made with no journey context (the token
// test endpoint, or a pass-through call from a caller that sends no journey
// header). journey_id is nullable precisely so these are still recorded.
async function recordStandaloneApiCall(entry) {
  return safeSave('recordStandaloneApiCall', async () => logRepo.recordApiTransaction(entry));
}

async function abandonJourney(journeyUuid, context = {}) {
  const journey = await journeyRepo.findByUuid(journeyUuid);
  if (!journey) return null;

  await journeyRepo.setStatus(journey.id, JOURNEY_STATUS.ABANDONED);
  await logRepo.recordEvent({
    journeyId: journey.id,
    eventType: EVENT_TYPES.JOURNEY_ABANDONED,
    fromStep: journey.current_step,
    message: 'Abandoned by caller',
    ipAddress: context.ipAddress,
  });
  return journeyRepo.findById(journey.id);
}

async function sweepStaleJourneys() {
  return safeSave('sweepStaleJourneys', async () => journeyRepo.sweepStale());
}

export {
  safeSave,
  createJourney,
  resumeByToken,
  findResumableForMobile,
  getSnapshotByUuid,
  buildSnapshot,
  buildSummary,
  saveStep,
  selectQuote,
  saveProposalDetails,
  saveKycStatus,
  recordPremiumCall,
  recordUwDecision,
  recordDataPush,
  recordPaymentInitiate,
  recordPaymentCallback,
  recordPaymentCallbackFailure,
  recordProposalStatus,
  recordPolicyDownload,
  recordStandaloneApiCall,
  abandonJourney,
  sweepStaleJourneys,
};
