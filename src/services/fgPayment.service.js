import crypto from 'node:crypto';

import config from '../config/env.js';
import { PAYMENT_RESULT, FG_API_NAMES } from '../constants/fg.constants.js';
import {
  buildPaymentRequest,
  parsePaymentReturn,
  issuanceBlockers,
  receiptStamp,
  gatewayUrl,
  assertPaymentConfigured,
} from '../helpers/fgPayment.helper.js';
import { validationError, upstreamError } from '../helpers/fg.helper.js';
import * as fgApi from './fgApi.service.js';
import * as fgReconcile from './fgReconcile.service.js';
import * as journeyService from './journey.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Everything between "the buyer presses Pay" and "the policy is issued".
//
// Future Generali collect premium by taking over the BROWSER, so this is not one
// API call but a round trip that has to be survived: build a form, hand the
// browser away, receive an encrypted POST back, and only then issue.
//
// The two references that make issuance possible exist ONLY inside that POST,
// and the kit maps them explicitly:
//
//   WS_P_ID → <UniqueTranKey>
//   PGID    → <TranRefNo>
//
// so they are carried into the receipt here rather than left for a caller to
// remember.
//
// ── On persistence ──────────────────────────────────────────────────────────
// The token → result mapping is IN MEMORY, matching the working implementation.
// A restart loses it, and a callback arriving afterwards is answered as an
// unknown token.
//
// That is survivable here in a way it was not in the standalone service,
// because this one has a database: every callback is written to
// nivabupa_api_transactions before the browser is redirected, carrying WS_P_ID,
// PGID and TID. So a lost token costs the buyer their automatic issuance, not
// the payment — the row holds exactly the references FG's own reconciliation
// asks for.
//
// It is deliberately NOT given typed journey tables: those columns are shaped
// around NivaBupa's envelopes, and mapping FG's into them would mean either
// changing that schema — which the ITGI integration explicitly declined to do,
// for the same reason — or storing something misleading.
// ─────────────────────────────────────────────────────────────────────────────

const byToken = new Map();
const tokenByPaymentRef = new Map();

/**
 * The proposal payload FG validated, kept against the TransactionID we send
 * them and which they echo back as TID.
 *
 * Issuance has to replay the SAME payload FG approved, and without this the only
 * copy lives in the buyer's browser — which makes a paid policy depend on
 * localStorage surviving a trip to an external payment page. Incognito, a
 * cleared store, a flat battery, a different device: each one collects the
 * premium and then leaves nobody able to issue. Observed on UAT 2026-08-21, on
 * a real ₹13,886 payment: status success, canIssue true, issuanceState
 * not_started, and no way to move it from the UI.
 */
const proposalByTransactionId = new Map();

function ttlMs() {
  return config.fg.payment.resultTtlMs;
}

/** Drop expired records. Called on every write; the maps stay small. */
function sweep(now = Date.now()) {
  for (const [token, record] of byToken) {
    if (now - record.createdAt > ttlMs()) {
      byToken.delete(token);
      if (record.paymentRef) tokenByPaymentRef.delete(record.paymentRef);
    }
  }
  for (const [transactionId, record] of proposalByTransactionId) {
    // Held four times longer than a payment result: the buyer is away on FG's
    // gateway for an unbounded time, and a proposal that expires mid-payment
    // strands exactly the customer this exists to protect.
    if (now - record.storedAt > ttlMs() * 4) proposalByTransactionId.delete(transactionId);
  }
}

function saveProposal(transactionId, proposal) {
  if (!transactionId || !proposal || typeof proposal !== 'object') return false;
  sweep();
  proposalByTransactionId.set(String(transactionId), { proposal, storedAt: Date.now() });
  return true;
}

function getProposal(transactionId) {
  if (!transactionId) return null;
  const record = proposalByTransactionId.get(String(transactionId));
  return record ? record.proposal : null;
}

/**
 * Store a parsed callback.
 *
 * A REPEAT of the same payment returns the ORIGINAL token, so both callbacks
 * resolve to one record and one issuance claim. Keyed on WS_P_ID — FG's own
 * payment id — rather than on the token, so a repeated callback (which would
 * otherwise mint a new token) still collapses onto the first claim.
 */
function saveResult(result) {
  sweep();
  const paymentRef = result?.wsPId ? String(result.wsPId) : null;

  if (paymentRef && tokenByPaymentRef.has(paymentRef)) {
    const token = tokenByPaymentRef.get(paymentRef);
    const record = byToken.get(token);
    if (record) {
      record.callbackCount += 1;
      return { token, duplicate: true, record };
    }
  }

  const token = crypto.randomBytes(24).toString('hex');
  const record = {
    token,
    paymentRef,
    result,
    createdAt: Date.now(),
    callbackCount: 1,
    // null until someone claims it; then { claimedAt, outcome }
    issuance: null,
  };
  byToken.set(token, record);
  if (paymentRef) tokenByPaymentRef.set(paymentRef, token);
  return { token, duplicate: false, record };
}

function getByToken(token) {
  sweep();
  return byToken.get(String(token || '')) || null;
}

/**
 * Take the exclusive right to issue for this payment.
 *
 * @returns {{claimed:true, record:object} | {claimed:false, reason:string}}
 */
function claimIssuance(token, { force = false } = {}) {
  const record = getByToken(token);
  if (!record) return { claimed: false, reason: 'unknown or expired payment token' };

  if (record.issuance) {
    // An unresolved attempt may be forced past, but only DELIBERATELY: FG may
    // already hold a policy for this payment, so it is a human's call.
    if (record.issuance.unresolved && force) {
      record.issuance = { claimedAt: Date.now(), outcome: null, forcedAfterUnresolved: true };
      return { claimed: true, record, forced: true };
    }
    let reason = 'issuance is already in progress';
    if (record.issuance.outcome) reason = 'already issued';
    else if (record.issuance.unresolved) reason = 'a previous attempt got no answer from Future Generali';
    return { claimed: false, reason, issuance: record.issuance };
  }

  record.issuance = { claimedAt: Date.now(), outcome: null };
  return { claimed: true, record };
}

/**
 * Record how a claimed issuance ended.
 *
 * THREE outcomes, not two, because "it failed" and "we do not know" carry
 * opposite risks:
 *
 *   ok         — final. Nothing may issue against this payment again.
 *   refused    — FG answered, and said no. The request created nothing, so the
 *                claim is RELEASED and a retry is safe.
 *   unresolved — FG did not answer (timeout, dropped connection). They may
 *                ALREADY have created the policy. The claim is KEPT, so nothing
 *                retries by itself, and only a deliberate force can proceed.
 *
 * Collapsing the third into the second is how one premium becomes two policies.
 */
function recordIssuance(token, outcome) {
  const record = getByToken(token);
  if (!record) return null;

  if (outcome?.ok) {
    record.issuance = { ...(record.issuance || {}), outcome, completedAt: Date.now() };
    return record;
  }

  if (outcome?.unresolved) {
    record.issuance = {
      ...(record.issuance || {}),
      outcome: null,
      unresolved: true,
      error: outcome.error || 'no response from Future Generali',
      unresolvedAt: Date.now(),
    };
    return record;
  }

  // FG answered and refused. Safe to try again.
  record.issuance = null;
  record.lastIssuanceError = outcome || null;
  return record;
}

/**
 * One durable row per issuance attempt made off the back of a callback.
 *
 * Written here rather than in the controller because this attempt is started by
 * the CALLBACK and deliberately not awaited — the controller has already
 * redirected the browser by the time it finishes, so there is nobody left to
 * audit it. Never throws: safeSave swallows its own failures, and a failed
 * audit write must never turn an issued policy into an error.
 */
function auditIssuance({ journeyId = null, result, outcome, errorMessage = null, startedAt }) {
  return journeyService.recordStandaloneApiCall({
    journeyId,
    apiName: FG_API_NAMES.PAYMENT_ISSUE,
    httpMethod: 'POST',
    endpointUrl: safeEndpoint(),
    status: errorMessage ? 'FAILED' : 'SUCCESS',
    durationMs: Date.now() - startedAt,
    // The references FG's own reconciliation asks for, kept whatever happens.
    requestPayload: {
      wsPId: result?.wsPId || null,
      pgid: result?.pgid || null,
      transactionId: result?.transactionId || null,
      premium: result?.premium || null,
    },
    responsePayload: outcome || null,
    errorMessage,
    correlationId: result?.wsPId || result?.transactionId || null,
  });
}

function safeEndpoint() {
  try {
    return fgApi.endpoint();
  } catch {
    return null;
  }
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Build the form the browser submits. Nothing is sent from here — the buyer has
 * to land on FG's page themselves.
 *
 * `input.proposal` is the payload FG validated. Passing it is what makes
 * issuance independent of the buyer's browser: it is kept against the
 * TransactionID, and the callback issues from it. Optional, so an existing
 * caller keeps working — it just keeps the old failure mode, where a browser
 * that loses its state after paying leaves a premium collected and no policy.
 */
function createSession(input = {}) {
  const request = buildPaymentRequest(input);
  const proposalHeldForIssuance = saveProposal(input.transactionId, input.proposal);

  console.log(
    // Deliberately narrow: no customer name, contact, checksum or amount.
    `[fg] payment session prepared — proposal=${input.proposalNumber} `
    + `option=${input.paymentOption} proposalHeldForIssuance=${proposalHeldForIssuance}`
  );

  if (!proposalHeldForIssuance) {
    console.warn(
      '⚠️  FG payment session has NO proposal held — issuance will depend on the buyer\'s '
      + 'browser still holding it when they return. Pass `proposal` to make it independent.'
    );
  }

  return { ...request, proposalHeldForIssuance };
}

/**
 * Handle FG's callback. Parses (decrypting when needed), stores, and returns an
 * opaque token — never the payment detail itself, because the caller's next move
 * is to put this in a redirect URL.
 *
 * Issuance is STARTED here and deliberately NOT awaited: the premium is
 * collected the moment this callback arrives, and leaving issuance to the
 * returning page means a buyer who closes the tab, loses their connection or
 * comes back with empty storage has paid for nothing. Issuance can take two
 * minutes; the browser has to be redirected at once.
 *
 * Racing the returning page is safe — the store claims the payment before
 * issuing, so whichever arrives second is refused the claim and reads the
 * first's outcome instead.
 */
function handleReturn(body, { journeyId = null } = {}) {
  const result = parsePaymentReturn(body);
  const { token, duplicate, record } = saveResult(result);

  console.log(
    `[fg] payment callback received — status=${result.status} encrypted=${result.encrypted} `
    + `duplicate=${duplicate} callbacks=${record.callbackCount} `
    + `hasWsPId=${Boolean(result.wsPId)} hasPgid=${Boolean(result.pgid)}`
    + (result.error ? ` decryptError=${result.error}` : '')
  );

  if (result.status === PAYMENT_RESULT.SUCCESS && !duplicate) {
    const proposal = getProposal(result.transactionId);
    if (proposal) {
      issueAfterPayment({ token, proposal, journeyId }).catch((error) => {
        // Already recorded against the payment by issueAfterPayment; logged
        // here only so an automatic attempt is never silent.
        console.warn(
          `⚠️  FG automatic issuance did not complete — code=${error.code} `
          + `message=${error.message} wsPId=${result.wsPId}`
        );
      });
    } else {
      console.warn(
        '⚠️  FG payment succeeded but no proposal is held for it — issuance now depends on the '
        + `returning browser. transactionId=${result.transactionId} wsPId=${result.wsPId}`
      );
    }
  }

  return { token, duplicate, result };
}

/** What the frontend reads once it lands on the return page. */
function getResult(token) {
  const record = getByToken(token);
  if (!record) return null;
  const issuance = record.issuance;

  // One word the UI can switch on, so a spinner can never outlive the truth.
  let issuanceState = 'not_started';
  if (issuance?.outcome?.ok) issuanceState = 'issued';
  else if (issuance?.unresolved) issuanceState = 'unresolved';
  else if (issuance) issuanceState = 'in_progress';

  return {
    ...record.result,
    duplicateCallbacks: record.callbackCount > 1,
    issuance: issuance ? issuance.outcome : null,
    issuanceState,
    // Set only when FG never answered — the caller must NOT retry on its own.
    issuanceUnresolvedReason: issuance?.unresolved ? issuance.error : null,
    policyNo: issuance?.outcome?.data?.policyNo || null,
    // Present so a stalled issuance can be reconciled rather than re-paid.
    canIssue: issuanceBlockers(record.result).length === 0,
    issuanceBlockers: issuanceBlockers(record.result),
  };
}

/**
 * Issue the policy for a paid proposal.
 *
 * Refuses on anything short of a verified success, and issues AT MOST ONCE per
 * payment: a repeated callback or a refreshed browser gets the first outcome
 * back rather than a second policy.
 *
 * @param {object} p
 * @param {string} p.token      from the callback redirect
 * @param {object} [p.proposal] the same payload createProposal was given
 * @param {boolean} [p.force]   push past a previous attempt that got NO answer
 *   from FG. Never set automatically — FG may already hold a policy for this
 *   payment, and forcing is how one premium becomes two policies.
 */
async function issueAfterPayment({ token, proposal: supplied, force = false, journeyId = null }) {
  const startedAt = Date.now();
  const record = getByToken(token);

  if (!record) {
    throw validationError(
      'Unknown or expired payment reference. The payment is NOT lost — reconcile it with '
      + 'Future Generali using their transaction id before charging anything again.',
      'token'
    );
  }

  const result = record.result;
  const blockers = issuanceBlockers(result);
  if (blockers.length) {
    throw validationError(
      `This policy cannot be issued: ${blockers.join('; ')}.`,
      null,
      {
        paymentStatus: result.status,
        // Kept so nothing is lost even on the refusal path.
        wsPId: result.wsPId, pgid: result.pgid, transactionId: result.transactionId,
      }
    );
  }

  // The caller's payload wins when it sends one — it is the freshest. When it
  // does not, the copy kept at payment time stands in, so a browser that has
  // lost its state cannot strand a premium that has already been taken.
  const proposal = (supplied && typeof supplied === 'object')
    ? supplied
    : getProposal(result.transactionId);

  if (!proposal || typeof proposal !== 'object') {
    throw validationError(
      'No proposal payload is available for this payment — neither supplied by the caller nor '
      + 'held from the payment session. The payment is safe and its references are kept; issue '
      + 'it by re-sending the proposal Future Generali validated.',
      'proposal',
      { transactionId: result.transactionId, wsPId: result.wsPId, pgid: result.pgid }
    );
  }

  // ── revalidate with FG before anything is issued ──────────────────────────
  //
  // ⚠️ SECURITY, not bookkeeping. The callback arrived at a PUBLIC route, and
  // the DES key that encrypted it is published in FG's integration PDF and is
  // the same for every partner — so the ciphertext proves nothing about who
  // sent it. Up to this line the only thing distinguishing a real payment from
  // a forged `Response=Success` is that a proposal is held for the
  // TransactionID, which a buyer who started a payment and walked away has.
  //
  // FG's own v1.39 says to close this: "you validate each transaction response
  // via an API call. Transaction revalidation protects from request/response
  // tampering possible in browser calls."
  //
  // Runs BEFORE the claim so a refusal leaves the payment claimable — a genuine
  // buyer whose revalidation failed transiently is not locked out of issuance
  // for the life of the record.
  const expectedAmount = Number(result.premium) > 0
    ? result.premium
    : proposal.receipt?.amount;
  const check = fgReconcile.isConfigured()
    ? await fgReconcile.verifyPayment({ result, expectedAmount })
    : { outcome: 'unconfigured', reason: null, details: null };

  if (check.outcome === 'rejected') {
    recordIssuance(token, { ok: false, error: `revalidation refused: ${check.reason}` });
    const error = validationError(
      `Future Generali did not confirm this payment, so no policy has been issued. ${check.reason}`,
      null,
      {
        revalidation: check.details,
        wsPId: result.wsPId, pgid: result.pgid, transactionId: result.transactionId,
      }
    );
    error.code = 'FG_PAYMENT_UNVERIFIED';
    console.error(
      `❌ FG REFUSED ISSUANCE — revalidation says this payment is not good. `
      + `transactionId=${result.transactionId} reason=${check.reason}`
    );
    await auditIssuance({
      journeyId, result, outcome: check.details, errorMessage: error.message, startedAt,
    });
    throw error;
  }

  if (check.outcome === 'unknown') {
    // NOT a refusal. FG could not be asked, and the money may well have moved.
    // Issuance proceeds — refusing here would strand a paying customer over an
    // outage on a service that is only advisory — but the gap is recorded so it
    // can be reconciled, and it is never silent.
    console.warn(
      `⚠️  FG issuance proceeding WITHOUT revalidation — ${check.reason} `
      + `transactionId=${result.transactionId}`
    );
  }

  if (check.outcome === 'unconfigured') {
    console.warn(
      '⚠️  FG_RECONCILE_URL is not set, so this payment is being issued against the browser\'s '
      + 'callback alone. Future Generali recommend server-to-server revalidation precisely '
      + 'because that callback can be tampered with — set it.'
    );
  }

  // ── at most once ──────────────────────────────────────────────────────────
  const claim = claimIssuance(token, { force });
  if (!claim.claimed) {
    const prior = record.issuance?.outcome;
    console.log(
      `[fg] issuance already claimed for this payment — not issuing again (${claim.reason})`
    );
    if (prior) return { ...prior, alreadyIssued: true };
    // The reason matters to whoever reads this: "in progress" is worth waiting
    // out, whereas "no answer" means a policy may already exist and only a
    // deliberate re-check should go near it.
    throw upstreamError(
      `Issuance for this payment is not repeatable right now — ${claim.reason}. Do not retry `
      + 'automatically; confirm the policy status with Future Generali first.',
      {
        reason: claim.reason,
        unresolved: Boolean(record.issuance?.unresolved),
        wsPId: result.wsPId, pgid: result.pgid, transactionId: result.transactionId,
      }
    );
  }

  // FG's own mapping, applied here so no caller has to remember it.
  //
  // `expectedAmount` was derived above and, when revalidation is configured, has
  // already been checked against the amount FG themselves report collecting —
  // so the figure written onto the receipt is one both sides agree on rather
  // than whatever the browser's callback happened to carry.
  const paidAmount = expectedAmount;

  // Both dates are the day the payment transaction happened, which is the day
  // this callback arrived. Not invented — FG's own Health Absolute documentation
  // marks TransactionDate ("Transaction Date for Policy Creation (dd/MM/yyyy)")
  // and TranRefNoDate mandatory on the Receipt, and this is the only date that
  // describes the transaction. A caller that knows better may override either.
  const paidOn = receiptStamp(record.createdAt);

  const withReceipt = {
    ...proposal,
    receipt: {
      ...(proposal.receipt || {}),
      amount: paidAmount,
      uniqueTranKey: result.wsPId,   // WS_P_ID → <UniqueTranKey>
      tranRefNo: result.pgid,        // PGID    → <TranRefNo>
      transactionDate: proposal.receipt?.transactionDate || paidOn,
      tranRefNoDate: proposal.receipt?.tranRefNoDate || paidOn,
      receiptType: proposal.receipt?.receiptType || 'IVR',
    },
  };

  // Every element FG's document marks Mandatory on <Receipt>. Checked before the
  // call so a PAID customer meets a named error rather than FG's unnamed one.
  const receiptMissing = [
    'uniqueTranKey', 'transactionDate', 'receiptType', 'amount', 'tranRefNo', 'tranRefNoDate',
  ].filter((key) => withReceipt.receipt[key] == null || withReceipt.receipt[key] === '');

  if (receiptMissing.length) {
    recordIssuance(token, { ok: false, error: `receipt missing ${receiptMissing.join(', ')}` });
    const error = validationError(
      `The issuance receipt is incomplete: ${receiptMissing.join(', ')}. The payment is safe — `
      + 'these references are held and the policy can be issued once they are supplied.',
      null,
      { missing: receiptMissing, wsPId: result.wsPId, pgid: result.pgid }
    );
    await auditIssuance({
      journeyId, result, outcome: null, errorMessage: error.message, startedAt,
    });
    throw error;
  }

  console.log(
    `[fg] issuing a policy against a verified payment — product=${proposal.product} `
    + `hasUniqueTranKey=${Boolean(withReceipt.receipt.uniqueTranKey)} `
    + `hasTranRefNo=${Boolean(withReceipt.receipt.tranRefNo)}`
  );

  try {
    const issued = await fgApi.issuePolicy(withReceipt);
    const outcome = {
      ok: issued.data.ok !== false,
      provider: 'future-generali',
      operation: 'issuePolicy',
      data: issued.data,
      meta: { httpStatus: issued.httpStatus, clientId: issued.clientId },
    };

    recordIssuance(token, outcome);
    console.log(
      `[fg] policy issued against a verified payment — status=${issued.data.status} `
      + `policyNo=${issued.data.policyNo} wsPId=${result.wsPId} pgid=${result.pgid}`
    );

    await auditIssuance({
      journeyId,
      result,
      outcome: issued.data,
      errorMessage: issued.data.ok === false
        ? `Future Generali refused issuance: ${issued.data.errorMessage || issued.data.status}`
        : null,
      startedAt,
    });

    return outcome;
  } catch (error) {
    // A TIMEOUT is NOT a refusal. FG may already have created the policy and
    // simply not answered, so it is recorded as UNRESOLVED: the claim is kept,
    // nothing retries by itself, and only a deliberate force gets past it.
    // Anything FG actually answered is a refusal, and safe to retry.
    const unresolved = error.timedOut === true
      || error.code === 'FG_TIMEOUT_ERROR'
      || error.code === 'ECONNABORTED'
      || error.code === 'ECONNRESET';

    recordIssuance(token, { ok: false, error: error.message, unresolved });

    console.error(
      unresolved
        ? '❌ FG issuance got NO ANSWER after a successful payment — the outcome is UNKNOWN and a '
          + 'policy may exist at Future Generali. Not retrying automatically.'
        : '⚠️  FG refused issuance after a successful payment — the references are preserved.',
      {
        message: error.message,
        code: error.code,
        wsPId: result.wsPId,
        pgid: result.pgid,
        transactionId: result.transactionId,
      }
    );

    await auditIssuance({
      journeyId,
      result,
      outcome: { unresolved },
      errorMessage: `${unresolved ? 'UNRESOLVED' : 'REFUSED'}: ${error.message}`,
      startedAt,
    });

    throw error;
  }
}

/** The gateway the browser will be POSTed to, for the config probe. */
function gateway() {
  return { url: gatewayUrl() };
}

/** Test seam. Not used by the service itself. */
function _reset() {
  byToken.clear();
  tokenByPaymentRef.clear();
  proposalByTransactionId.clear();
}

export {
  createSession,
  handleReturn,
  getResult,
  issueAfterPayment,
  gateway,
  assertPaymentConfigured,
  // Store internals, exported for the smoke script and for reconciliation.
  saveProposal,
  getProposal,
  getByToken,
  _reset,
};
