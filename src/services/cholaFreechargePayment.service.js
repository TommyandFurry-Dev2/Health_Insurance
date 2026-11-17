import config from '../config/env.js';
import * as freechargeRepository from '../repositories/cholaFreecharge.repository.js';
import * as freecharge from './cholaFreecharge.service.js';
import { assertConfigured, resolveProduct } from './cholaApi.service.js';
import { issue as issuePolicy, cholaStore } from './cholaPolicyIssuer.service.js';
import { resolveFrontendReturnUrl } from '../helpers/payment.helper.js';
import {
  CHOLA_PROVIDER, CHOLA_RETURN_PAGE, CHOLA_PROPOSAL_STATUS,
  CHOLA_FREECHARGE_STATUS, CHOLA_FREECHARGE_ISSUE_STATUS,
} from '../constants/chola.constants.js';
import { validationError, notFoundError } from '../helpers/chola.helper.js';
import {
  newMerchantTxnId, newReturnToken, buildCheckoutRequest, withReference, readEncrypted, readResult,
  verdictOf, decidePayment, sameAmount,
} from '../helpers/cholaFreecharge.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS premium collected through Freecharge (FCPG), then the policy issued
// against it.
//
//   1 checkout   POST /chola-ms/freecharge/initiate
//                  the proposal's earlier checkouts are settled first (a
//                  proposal is paid once); a payment row is written; Chola's
//                  crypto/encrypt seals the checkout request; the browser gets
//                  { url, fields: { clientId, encData } } to form-POST to FCPG.
//   2 callback   ALL /chola-ms/freecharge/return?ref=…
//                  FCPG send the buyer back with { clientId, encData }. Chola's
//                  crypto/decrypt opens it, and checkout/txn/status — never the
//                  callback alone — decides the payment. The buyer is sent on
//                  to their /chola-return page with the opaque ref.
//   3 issue      on a verified SUCCESS, PolicyGeneration in PG_DIRECT, PGID =
//                  FCPG's txnReferenceId, through the existing send-once path
//                  (cholaPolicyIssuer.issue: health_chola_proposals claim,
//                  evidence log, schedule). Started in the background so the
//                  buyer is not held on a blank page for Chola's ~24 s.
//   4 result     GET /chola-ms/freecharge/result/:ref, POST …/status { ref }
//                  the return page reads the row; "check again" re-asks FCPG
//                  for a payment still pending and starts issuance once paid.
//
// What this never does: issue on the callback's word alone; issue when the
// amount FCPG collected is not the premium; take a second payment for a
// proposal while an earlier one is paid, or not yet known to have failed.
// ─────────────────────────────────────────────────────────────────────────────

const {
  INITIATED, PENDING, SUCCESS, FAILED, NEEDS_REVIEW,
} = CHOLA_FREECHARGE_STATUS;
const ISSUE = CHOLA_FREECHARGE_ISSUE_STATUS;

// The store, swappable for tests the way the issuer's is.
const deps = {
  store: freechargeRepository,
};

/** Replace the store. Returns a function that restores the previous one. For tests only. */
function setCholaFreechargeDependencies(overrides = {}) {
  const previous = { ...deps };
  Object.assign(deps, overrides);
  return () => Object.assign(deps, previous);
}

// Issuance started in the background, so a test (or a graceful shutdown) can
// wait for it.
const inflight = new Set();

/** Resolves once every background issuance started so far has finished. */
function whenIssuanceSettled() {
  return Promise.allSettled([...inflight]);
}

async function quietly(what, write) {
  try {
    await write();
  } catch (error) {
    console.error(`❌ [chola] Freecharge: could not record ${what}: ${error.message}`);
  }
}

// ── 1 checkout ──────────────────────────────────────────────────────────────

function alreadyPaid(row) {
  return validationError(
    `Proposal ${row.gencon_proposal_number} has already been paid through Freecharge `
    + `(${row.merchant_txn_id}, ${row.status}). It is not paid twice.`,
    {
      field: 'GenconProposalNumber',
      paymentStatus: row.status,
      merchantTxnId: row.merchant_txn_id,
      issueStatus: row.issue_status ?? null,
    }
  );
}

/**
 * Before a new checkout: every earlier one for the proposal must be known to
 * have failed. A paid one refuses (and gets its issuance started, in case the
 * callback that would have started it never came); one still pending or never
 * answered is asked about first, and refuses unless FCPG now say it failed —
 * an abandoned checkout answers SPG-0025, "Transaction does not exist".
 */
async function settleEarlierCheckouts(proposalNo) {
  const earlier = await deps.store.listForProposal(proposalNo);
  for (const row of earlier) {
    if (row.status === SUCCESS || row.status === NEEDS_REVIEW) throw alreadyPaid(row);
    if (row.status !== INITIATED && row.status !== PENDING) continue;
    const settled = await verify(row);
    if (settled.status === SUCCESS) await startIssuance(settled);
    if (settled.status === SUCCESS || settled.status === NEEDS_REVIEW) throw alreadyPaid(settled);
    if (settled.status !== FAILED) {
      throw validationError(
        `An earlier payment for proposal ${proposalNo} (${row.merchant_txn_id}) is not confirmed yet`
        + `${settled.status_message ? ` — ${settled.status_message}` : ''}. A second payment is not taken until `
        + 'Freecharge confirm the first one failed; check again in a few minutes.',
        { field: 'GenconProposalNumber', paymentStatus: settled.status, merchantTxnId: row.merchant_txn_id }
      );
    }
  }
}

/**
 * Start a Freecharge checkout for a saved proposal.
 *
 * @param {{product?: string, GenconProposalNumber: string, Amount: number|string,
 *          frontendReturnUrl: string}} input
 *   `Amount` is Chola's re-priced ProposalSave premium; `frontendReturnUrl` the
 *   buyer's /chola-return page, on an allowed origin.
 */
async function initiate(input = {}) {
  freecharge.assertFreechargeConfigured();
  // The policy is issued through the product APIs after payment: money is not
  // taken for a proposal this service could not then tag.
  assertConfigured();
  const productKey = resolveProduct(input);
  const proposalNo = String(input.GenconProposalNumber ?? '').trim();
  if (!proposalNo) throw validationError('GenconProposalNumber is required', { field: 'GenconProposalNumber' });
  const amount = Number(input.Amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw validationError(`Amount must be the premium payable incl. GST, got "${input.Amount}"`, { field: 'Amount' });
  }
  const fc = config.chola.freecharge;
  // Refused here rather than defaulted: after paying, the buyer must land on
  // the frontend that can read the result.
  const target = resolveFrontendReturnUrl(input.frontendReturnUrl, fc.frontendReturnOrigins, CHOLA_RETURN_PAGE);
  if (!target.url) {
    throw validationError(
      `frontendReturnUrl must be a ${CHOLA_RETURN_PAGE} page on an allowed origin${target.reason ? ` (${target.reason})` : ''}`,
      { field: 'frontendReturnUrl' }
    );
  }

  await settleEarlierCheckouts(proposalNo);

  const merchantTxnId = newMerchantTxnId(proposalNo);
  const ref = newReturnToken();
  const request = buildCheckoutRequest({
    merchantId: fc.merchantId,
    merchantTxnId,
    amount,
    proposalNo,
    callbackUrl: withReference(fc.callbackUrl, ref),
    currency: fc.currency,
  });

  // Written before the buyer can pay, so every callback finds its row. Fails
  // closed: no row, no checkout.
  await deps.store.insertPayment({
    merchantTxnId,
    returnToken: ref,
    genconProposalNumber: proposalNo,
    product: productKey,
    amount,
    currency: fc.currency,
    frontendReturnUrl: target.url,
    status: INITIATED,
  });

  let sealed;
  let encrypted;
  try {
    sealed = await freecharge.encrypt(request);
    encrypted = readEncrypted(sealed.body);
  } catch (error) {
    // Nothing reached FCPG; the row must not block the next attempt.
    await quietly('a checkout that did not start', () => deps.store.recordVerification(merchantTxnId, {
      status: FAILED, statusMessage: `Checkout not started: ${error.message}`,
    }));
    throw error;
  }

  console.log(`[chola] Freecharge checkout ready — proposal=${proposalNo} merchantTxnId=${merchantTxnId} amount=${request.merchantTxnAmount}`);
  return {
    result: {
      ok: true,
      provider: CHOLA_PROVIDER,
      operation: 'freechargeCheckout',
      product: productKey,
      data: {
        succeeded: true,
        ref,
        merchantTxnId,
        genconProposalNumber: proposalNo,
        amount,
        currency: fc.currency,
        // What the browser form-POSTs (application/x-www-form-urlencoded) to
        // FCPG's hosted checkout.
        checkout: {
          url: fc.checkoutUrl,
          method: 'POST',
          fields: { clientId: encrypted.clientId || fc.merchantId, encData: encrypted.encData },
        },
      },
      meta: { httpStatus: sealed.status, correlationId: sealed.correlationId },
    },
    exchange: sealed.exchange,
  };
}

// ── verification ────────────────────────────────────────────────────────────

/**
 * Ask FCPG (checkout/txn/status) what became of a checkout, and record it.
 * SUCCESS is never undone by a later check: the money has moved. NEEDS_REVIEW
 * stays until a person re-checks it (`reconsider`).
 *
 * @returns the row as it now stands
 */
async function verify(row, { callback = null, reconsider = false } = {}) {
  let res = null;
  let error = null;
  try {
    res = await freecharge.txnStatus({
      merchantTxnId: row.merchant_txn_id,
      txnReferenceId: callback?.txnReferenceId || row.txn_reference_id || null,
    });
  } catch (e) {
    error = e;
    console.warn(`⚠️  [chola] Freecharge txn/status for ${row.merchant_txn_id} failed: [${e.code || 'ERROR'}] ${e.message}`);
  }

  const status = res ? readResult(res.body) : null;
  let decision = decidePayment({ row, status, callback, error });
  if (row.status === SUCCESS || (row.status === NEEDS_REVIEW && !reconsider)) {
    decision = { status: row.status, statusCode: row.status_code, statusMessage: row.status_message };
  }
  const statusResponse = res ? res.body : { error: { code: error?.code || null, message: error?.message || null } };
  await deps.store.recordVerification(row.merchant_txn_id, { ...decision, statusResponse });
  console.log(
    `[chola] Freecharge verified — merchantTxnId=${row.merchant_txn_id} status=${decision.status} `
    + `code=${decision.statusCode ?? '—'}`
  );
  return (await deps.store.findByMerchantTxnId(row.merchant_txn_id)) || { ...row, ...decision };
}

// ── 3 issue ─────────────────────────────────────────────────────────────────

/** The issuer's verdict, in this table's words. */
function issueOutcomeOf(data) {
  if (data.status === CHOLA_PROPOSAL_STATUS.POLICY_ISSUED) {
    return { issueStatus: ISSUE.POLICY_ISSUED, policyNumber: data.genconPolicyNumber, message: null };
  }
  if (data.status === CHOLA_PROPOSAL_STATUS.PAYMENT_FAILED) {
    return { issueStatus: ISSUE.ISSUE_FAILED, message: data.message || 'Chola MS refused PolicyGeneration.' };
  }
  return { issueStatus: ISSUE.NEEDS_REVIEW, message: data.message || `PolicyGeneration outcome ${data.status}.` };
}

/**
 * issue() refused before sending. Already claimed means PolicyGeneration went
 * out once for this proposal: mirror what came of it, never send again.
 */
async function issueOutcomeOfError(error, proposalNo) {
  if (error.code === 'VALIDATION_ERROR' && error.details?.status) {
    const existing = await cholaStore().findProposal(proposalNo).catch(() => null);
    if (existing?.status === CHOLA_PROPOSAL_STATUS.POLICY_ISSUED) {
      return { issueStatus: ISSUE.POLICY_ISSUED, policyNumber: existing.gencon_policy_number || null, message: null };
    }
    return { issueStatus: ISSUE.NEEDS_REVIEW, message: error.message };
  }
  return { issueStatus: ISSUE.ISSUE_FAILED, message: `Not sent to Chola MS: ${error.message}` };
}

async function issueClaimed(row) {
  let outcome;
  try {
    const { result } = await issuePolicy({
      product: row.product,
      GenconProposalNumber: row.gencon_proposal_number,
      Amount: row.amount,
      paymentReference: row.txn_reference_id,
    }, { source: 'freecharge', mode: 'PG_DIRECT' });
    outcome = issueOutcomeOf(result.data);
  } catch (error) {
    outcome = await issueOutcomeOfError(error, row.gencon_proposal_number);
  }
  await quietly(`the issuance outcome for ${row.merchant_txn_id}`, () => deps.store.recordIssue(row.merchant_txn_id, outcome));
  console.log(
    `[chola] Freecharge issuance — merchantTxnId=${row.merchant_txn_id} proposal=${row.gencon_proposal_number} `
    + `outcome=${outcome.issueStatus} policy=${outcome.policyNumber ?? '—'}`
  );
  return outcome;
}

/**
 * Claim issuance for a paid checkout and run it in the background. The claim
 * is awaited, so a result read straight after already says IN_PROGRESS.
 * Resolves false when there was nothing to start (already tried, or not paid).
 */
async function startIssuance(row) {
  if (row.status !== SUCCESS) return false;
  if (!await deps.store.claimIssue(row.merchant_txn_id)) return false;
  const job = issueClaimed(row)
    .catch((error) => console.error(`❌ [chola] Freecharge issuance for ${row.merchant_txn_id} crashed: ${error.message}`))
    .finally(() => inflight.delete(job));
  inflight.add(job);
  return true;
}

// ── 2 callback ──────────────────────────────────────────────────────────────

/**
 * FCPG's return. `source` is the query string and the body together (the
 * callback is a form POST of { clientId, encData }; `ref` is ours, on the
 * callback URL).
 *
 * Never throws for anything FCPG sent: an unreadable callback is still matched
 * by `ref` and verified by txn/status.
 *
 * @returns {Promise<{ matched: boolean, row?: object, callback: object|null, decryptError: Error|null }>}
 */
async function handleReturn(source = {}) {
  const ref = typeof source.ref === 'string' && source.ref ? source.ref : null;
  const encData = typeof source.encData === 'string' && source.encData ? source.encData : null;
  const clientId = typeof source.clientId === 'string' && source.clientId ? source.clientId : null;

  let row = ref ? await deps.store.findByToken(ref) : null;
  let callback = null;
  let decrypted = null;
  let decryptError = null;
  if (encData) {
    try {
      const res = await freecharge.decrypt({ clientId, encData });
      decrypted = res.body;
      callback = readResult(res.body);
    } catch (error) {
      decryptError = error;
      console.warn(`⚠️  [chola] Freecharge callback could not be decrypted: [${error.code || 'ERROR'}] ${error.message}`);
    }
  }
  if (!row && callback?.merchantTxnId) row = await deps.store.findByMerchantTxnId(callback.merchantTxnId);
  if (!row) return { matched: false, callback, decryptError };

  await quietly(`the callback for ${row.merchant_txn_id}`, () => deps.store.recordCallback(row.merchant_txn_id, {
    body: { clientId, encData }, decrypted,
  }));

  if (callback?.merchantTxnId && callback.merchantTxnId !== row.merchant_txn_id) {
    // A callback naming another transaction on this payment's reference.
    // Recorded, not acted on.
    await deps.store.recordVerification(row.merchant_txn_id, {
      status: row.status === SUCCESS ? SUCCESS : NEEDS_REVIEW,
      statusCode: callback.statusCode,
      statusMessage: `The callback for ${row.merchant_txn_id} names ${callback.merchantTxnId}.`,
    });
    return { matched: true, row: await deps.store.findByToken(row.return_token), callback, decryptError };
  }
  if (clientId && clientId !== config.chola.freecharge.merchantId) {
    console.warn(`⚠️  [chola] Freecharge callback for ${row.merchant_txn_id} carries clientId ${clientId}, not the configured merchant`);
  }

  const current = row.status === SUCCESS || row.status === NEEDS_REVIEW ? row : await verify(row, { callback });
  await startIssuance(current);
  return { matched: true, row: await deps.store.findByToken(current.return_token) || current, callback, decryptError };
}

// ── 4 result ────────────────────────────────────────────────────────────────

/** What the return page is shown. No callback bodies, no FCPG answers. */
function view(row) {
  const paid = row.status === SUCCESS;
  return {
    succeeded: paid,
    ref: row.return_token,
    merchantTxnId: row.merchant_txn_id,
    genconProposalNumber: row.gencon_proposal_number,
    product: row.product,
    amount: Number(row.amount),
    currency: row.currency,
    paymentStatus: row.status,
    statusCode: row.status_code ?? null,
    statusMessage: row.status_message ?? null,
    txnReferenceId: row.txn_reference_id ?? null,
    issueStatus: row.issue_status ?? null,
    genconPolicyNumber: row.gencon_policy_number ?? null,
    issueMessage: row.issue_message ?? null,
    checkedAt: row.last_checked_at ?? null,
  };
}

function resultEnvelope(operation, row) {
  return { ok: true, provider: CHOLA_PROVIDER, operation, product: row.product, data: view(row) };
}

async function rowByRef(ref) {
  const row = typeof ref === 'string' && ref ? await deps.store.findByToken(ref) : null;
  if (!row) {
    throw notFoundError(
      'This payment reference is unknown. If money has left the account, do NOT pay again — '
      + 'the payment can be reconciled with Chola MS from the Freecharge transaction.',
      { code: 'PAYMENT_REF_UNKNOWN' }
    );
  }
  return row;
}

/** GET …/result/:ref — read only. */
async function result(ref) {
  return resultEnvelope('freechargeResult', await rowByRef(ref));
}

/**
 * POST …/status { ref } — "check again": asks FCPG about a payment not yet
 * settled (the callback may never have arrived), and starts issuance for a
 * paid one that has not been tried. Safe to repeat.
 */
async function recheck(ref) {
  let row = await rowByRef(ref);
  if (row.status === INITIATED || row.status === PENDING) row = await verify(row);
  await startIssuance(row);
  return resultEnvelope('freechargeStatus', await deps.store.findByToken(ref) || row);
}

// ── ops ─────────────────────────────────────────────────────────────────────

async function rowByMerchantTxnId(merchantTxnId) {
  const row = merchantTxnId ? await deps.store.findByMerchantTxnId(merchantTxnId) : null;
  if (!row) throw notFoundError(`No Freecharge payment ${merchantTxnId}.`);
  return row;
}

async function listPayments({ limit } = {}) {
  return { ok: true, provider: CHOLA_PROVIDER, data: await deps.store.listPayments({ limit }) };
}

async function paymentDetail(merchantTxnId) {
  await rowByMerchantTxnId(merchantTxnId);
  return { ok: true, provider: CHOLA_PROVIDER, data: await deps.store.findDetail(merchantTxnId) };
}

/** Re-ask FCPG — NEEDS_REVIEW included — and start issuance if it is now paid. */
async function opsVerify(merchantTxnId) {
  const row = await verify(await rowByMerchantTxnId(merchantTxnId), { reconsider: true });
  await startIssuance(row);
  return resultEnvelope('freechargeStatus', await deps.store.findByMerchantTxnId(merchantTxnId) || row);
}

/**
 * Re-send PolicyGeneration for a paid checkout whose issuance Chola refused or
 * that never left (ISSUE_FAILED), or start one never tried. Awaited: an
 * operator waits for the answer. The health_chola_proposals claim still
 * refuses a proposal whose PolicyGeneration outcome is unknown.
 */
async function opsIssue(merchantTxnId) {
  const row = await rowByMerchantTxnId(merchantTxnId);
  if (row.status !== SUCCESS) {
    throw validationError(`Payment ${merchantTxnId} is ${row.status}, not SUCCESS: nothing to issue against.`, { field: 'merchantTxnId' });
  }
  if (!await deps.store.claimIssue(merchantTxnId, { retry: true })) {
    throw validationError(
      `Issuance for ${merchantTxnId} is ${row.issue_status}; it is re-sent only from ${ISSUE.ISSUE_FAILED}.`,
      { field: 'merchantTxnId', issueStatus: row.issue_status }
    );
  }
  await issueClaimed(row);
  return resultEnvelope('freechargeIssue', await deps.store.findByMerchantTxnId(merchantTxnId));
}

const REFUND_TYPES = ['OFFLINE', 'ONLINE'];

/**
 * Refund a collected premium (the collection's refund request). Only for a
 * payment FCPG confirmed, whose policy was NOT issued — an issued policy is
 * cancelled with Chola first — and only once.
 */
async function opsRefund(merchantTxnId, { refundAmount, refundType = 'OFFLINE' } = {}) {
  freecharge.assertFreechargeConfigured();
  const row = await rowByMerchantTxnId(merchantTxnId);
  if (row.status !== SUCCESS && row.status !== NEEDS_REVIEW) {
    throw validationError(`Payment ${merchantTxnId} is ${row.status}: FCPG hold no collected money for it.`, { field: 'merchantTxnId' });
  }
  if (!row.txn_reference_id) {
    throw validationError(`Payment ${merchantTxnId} has no txnReferenceId to refund against.`, { field: 'merchantTxnId' });
  }
  if (row.issue_status === ISSUE.POLICY_ISSUED || row.issue_status === ISSUE.IN_PROGRESS) {
    throw validationError(
      `Payment ${merchantTxnId} has a policy ${row.issue_status === ISSUE.IN_PROGRESS ? 'being issued' : 'issued'} against it. `
      + 'Cancel it with Chola MS before refunding.',
      { field: 'merchantTxnId', issueStatus: row.issue_status }
    );
  }
  if (row.refund_txn_id && verdictOf(row.refund_status_code) !== FAILED) {
    throw validationError(
      `A refund (${row.refund_txn_id}, ${row.refund_status_code || 'no status'}) is already recorded for ${merchantTxnId}.`,
      { field: 'merchantTxnId' }
    );
  }
  const type = String(refundType).toUpperCase();
  if (!REFUND_TYPES.includes(type)) throw validationError(`refundType must be one of ${REFUND_TYPES.join(', ')}`, { field: 'refundType' });
  const collected = Number(row.paid_amount ?? row.amount);
  const amount = refundAmount === undefined || refundAmount === null || refundAmount === '' ? collected : Number(refundAmount);
  if (!Number.isFinite(amount) || amount <= 0 || (amount > collected && !sameAmount(amount, collected))) {
    throw validationError(`refundAmount must be more than 0 and at most ${collected}`, { field: 'refundAmount' });
  }

  const refundTxnId = newMerchantTxnId(row.gencon_proposal_number, 'RF');
  const res = await freecharge.refund({
    merchantRefundTxnId: refundTxnId, txnReferenceId: row.txn_reference_id, refundAmount: amount, refundType: type,
  });
  const answer = readResult(res.body);
  await deps.store.recordRefund(merchantTxnId, {
    refundTxnId, statusCode: answer.statusCode, statusMessage: answer.statusMessage, response: res.body,
  });
  console.log(`[chola] Freecharge refund — merchantTxnId=${merchantTxnId} refund=${refundTxnId} code=${answer.statusCode ?? '—'}`);
  return {
    result: {
      ok: true,
      provider: CHOLA_PROVIDER,
      operation: 'freechargeRefund',
      product: row.product,
      data: {
        succeeded: verdictOf(answer.statusCode) !== FAILED,
        refundStatus: verdictOf(answer.statusCode),
        merchantTxnId,
        merchantRefundTxnId: refundTxnId,
        refundAmount: amount,
        statusCode: answer.statusCode,
        statusMessage: answer.statusMessage,
        raw: res.body,
      },
      meta: { httpStatus: res.status, correlationId: res.correlationId },
    },
    exchange: res.exchange,
  };
}

/**
 * paylinkqr/create, as the collection sends it (merchant, timestamp and
 * currency filled in). For ops and assisted sales: a pay link is not tied to
 * a proposal's issuance, because neither its callback nor the link status
 * answer is documented yet.
 */
async function opsCreatePayLink(fields = {}) {
  if (!fields.entityTxnId) throw validationError('entityTxnId is required', { field: 'entityTxnId' });
  const res = await freecharge.createPayLink(fields);
  const answer = readResult(res.body);
  return {
    result: {
      ok: true,
      provider: CHOLA_PROVIDER,
      operation: 'freechargePayLink',
      data: {
        succeeded: verdictOf(answer.statusCode) === SUCCESS,
        statusCode: answer.statusCode,
        statusMessage: answer.statusMessage,
        payLinkUrl: res.body?.data?.payLinkUrl ?? null,
        expireTime: res.body?.data?.expireTime ?? null,
        raw: res.body,
      },
      meta: { httpStatus: res.status, correlationId: res.correlationId },
    },
    exchange: res.exchange,
  };
}

/** payment/link/status by entityTxnId, passed through. */
async function opsPayLinkStatus({ entityTxnId } = {}) {
  if (!entityTxnId) throw validationError('entityTxnId is required', { field: 'entityTxnId' });
  const res = await freecharge.payLinkStatus({ entityTxnId });
  const answer = readResult(res.body);
  return {
    result: {
      ok: true,
      provider: CHOLA_PROVIDER,
      operation: 'freechargePayLinkStatus',
      data: { statusCode: answer.statusCode, statusMessage: answer.statusMessage, raw: res.body },
      meta: { httpStatus: res.status, correlationId: res.correlationId },
    },
    exchange: res.exchange,
  };
}

export {
  initiate,
  handleReturn,
  result,
  recheck,
  verify,
  startIssuance,
  whenIssuanceSettled,
  listPayments,
  paymentDetail,
  opsVerify,
  opsIssue,
  opsRefund,
  opsCreatePayLink,
  opsPayLinkStatus,
  setCholaFreechargeDependencies,
};
