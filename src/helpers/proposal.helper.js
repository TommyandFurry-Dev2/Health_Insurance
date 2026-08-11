import * as paymentRepo from '../repositories/payment.repository.js';
import {
  PROPOSAL_BUSINESS_DEFAULTS,
  OMIT_WHEN_UNSELECTED_ADJUSTMENTS,
} from '../constants/proposal.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Last hop before Niva Bupa.
//
// The proposal payload is built by the frontend (utils/nivabupaUwPayload.js)
// and these endpoints have always been pass-throughs. That stays true for
// everything a buyer supplies — nothing here invents, overwrites or guesses a
// person's data. What it does assert is the small set of channel constants Niva
// Bupa told us must be on every request, and the payment transaction number,
// which the server can resolve from its own records.
//
// It exists because a Data Push runs after money has moved. A buyer whose
// browser is still holding a pre-fix bundle, or who resumed a journey queued
// before the fix, would otherwise send the old payload and there is no cheap
// retry for that call.
// ─────────────────────────────────────────────────────────────────────────────

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function proposalOf(payload) {
  return payload && typeof payload === 'object' ? payload.Proposal : null;
}

// Reads the application number the payload was built with. It is the same value
// sent to the gateway as unqPolicyNumber and echoed back by the callback as
// uniqueReferenceId, which is what makes it a usable key into the payments
// table (see payment.repository.js's findByCorrelation).
function sourcingAppNoOf(payload) {
  const value = proposalOf(payload)?.POLICY?.CONTRACT_DETAILS?.SOURCING_APPNO;
  return isBlank(value) ? null : String(value).trim();
}

// Resolves the gateway's own transaction id for this proposal, preferring what
// the caller already knows.
//
// 1. Whatever the client stamped on the payload — the return page reads it
//    straight off the callback redirect, so it is first-hand.
// 2. The persisted payments row, matched on SOURCING_APPNO, then on the
//    journey. This is the recovery path: the value was written by
//    handlePaymentReturn when the gateway called back, so it is available even
//    when the browser lost it.
//
// Never fabricated. If neither source has one, the field is omitted and the
// caller logs why — a made-up transaction number is worse than an absent one,
// because it would reconcile against nothing.
async function resolveTransactionNumber(payload, { journeyId } = {}) {
  const onPayload = proposalOf(payload)?.POLICY?.PAYMENT_INFO?.TRANSACTION_NUMBER;
  if (!isBlank(onPayload)) {
    return { transactionNumber: String(onPayload).trim(), source: 'request payload' };
  }

  const sourcingAppNo = sourcingAppNoOf(payload);
  try {
    if (sourcingAppNo) {
      const payment = await paymentRepo.findByCorrelation({ uniqueReferenceId: sourcingAppNo });
      if (payment && !isBlank(payment.payment_transaction_id)) {
        return {
          transactionNumber: String(payment.payment_transaction_id).trim(),
          source: `payments row (SOURCING_APPNO ${sourcingAppNo})`,
          paymentDate: payment.transaction_date_time || null,
        };
      }
    }

    if (journeyId) {
      const payment = await paymentRepo.findSuccessfulByJourney(journeyId);
      if (payment && !isBlank(payment.payment_transaction_id)) {
        return {
          transactionNumber: String(payment.payment_transaction_id).trim(),
          source: `payments row (journey ${journeyId})`,
          paymentDate: payment.transaction_date_time || null,
        };
      }
    }
  } catch (error) {
    // Same rule as journey.service.js's safeSave: persistence must never break
    // the integration. A lookup failure means we fall back to whatever the
    // payload carried, it does not fail the buyer's proposal.
    console.error('⚠️  Could not resolve payment transaction number:', error.message);
  }

  return { transactionNumber: null, source: 'unresolved' };
}

// Applies the business constants and the resolved transaction number in place,
// returning a record of what it changed so the caller can log it.
//
// `enforcePaymentReceived` is false for UW Decision: that call happens before
// the buyer reaches the gateway, so claiming payment was received would be a
// statement about money that has not moved. Data Push — the request Niva Bupa
// actually observed, and the one that creates the policy — passes true.
function applyBusinessDefaults(payload, { transactionNumber, paymentDate, enforcePaymentReceived = true } = {}) {
  const proposal = proposalOf(payload);
  const policy = proposal?.POLICY;
  if (!policy) return { applied: [], skipped: 'no Proposal.POLICY in payload' };

  const applied = [];
  const set = (container, field, value) => {
    if (!container) return;
    const before = container[field];
    if (before === value) return;
    container[field] = value;
    applied.push({ field, from: before === undefined ? '(absent)' : before, to: value });
  };

  // PAYMENT_INFO
  policy.PAYMENT_INFO = policy.PAYMENT_INFO || {};
  const paymentInfo = policy.PAYMENT_INFO;
  set(paymentInfo, 'PAYMENT_COLLECT_MODE', PROPOSAL_BUSINESS_DEFAULTS.paymentCollectMode);
  if (enforcePaymentReceived) {
    set(paymentInfo, 'PAYMENT_RECEIVED_FLAG', PROPOSAL_BUSINESS_DEFAULTS.paymentReceivedFlag);
  }

  if (!isBlank(transactionNumber)) {
    set(paymentInfo, 'TRANSACTION_NUMBER', String(transactionNumber));
  } else if ('TRANSACTION_NUMBER' in paymentInfo) {
    // Never an empty string: Niva Bupa asked for the field to be absent rather
    // than blank when there is no real value to send.
    delete paymentInfo.TRANSACTION_NUMBER;
    applied.push({ field: 'TRANSACTION_NUMBER', from: '(blank)', to: '(omitted — no gateway value)' });
  }

  if (!isBlank(paymentDate)) {
    set(paymentInfo, 'PAYMENT_DATE', String(paymentDate));
  } else if ('PAYMENT_DATE' in paymentInfo && isBlank(paymentInfo.PAYMENT_DATE)) {
    delete paymentInfo.PAYMENT_DATE;
    applied.push({ field: 'PAYMENT_DATE', from: '(blank)', to: '(omitted)' });
  }

  // Branch codes
  policy.POLICY_OTHER_DETAILS = policy.POLICY_OTHER_DETAILS || {};
  set(policy.POLICY_OTHER_DETAILS, 'LOGIN_BRANCH_CODE', PROPOSAL_BUSINESS_DEFAULTS.loginBranchCode);
  set(policy.POLICY_OTHER_DETAILS, 'NOC_BRANCH_CODE', PROPOSAL_BUSINESS_DEFAULTS.nocBranchCode);

  // Agent code
  policy.SOURCING_INFO = policy.SOURCING_INFO || {};
  policy.SOURCING_INFO.AGENT_INFO = policy.SOURCING_INFO.AGENT_INFO || {};
  set(policy.SOURCING_INFO.AGENT_INFO, 'AGENT_CODE', PROPOSAL_BUSINESS_DEFAULTS.agentCode);

  // Unselected riders. Only entries with no real value are dropped — a rider
  // the buyer actually chose keeps whatever value they chose, including one
  // that legitimately reads as zero once a rider UI exists and can say so.
  if (Array.isArray(policy.ADJUSTMENT_DETAILS)) {
    const kept = policy.ADJUSTMENT_DETAILS.filter((adjustment) => {
      if (!OMIT_WHEN_UNSELECTED_ADJUSTMENTS.includes(adjustment?.ADJUSTMENT_CODE)) return true;
      const value = adjustment?.ADJUSTMENT_VALUE;
      const unselected = isBlank(value) || Number(value) === 0;
      if (unselected) {
        applied.push({
          field: `ADJUSTMENT_DETAILS.${adjustment.ADJUSTMENT_CODE}`,
          from: JSON.stringify(value),
          to: '(omitted — rider not selected)',
        });
      }
      return !unselected;
    });
    policy.ADJUSTMENT_DETAILS = kept;
  }

  return { applied };
}

// Prints the exact fields Niva Bupa raised, immediately before the request goes
// upstream, so a live run can be diffed against their observations without
// reading the whole payload. Always on for Data Push (once per policy, not per
// keystroke); genericApi.service.js's own DATAPUSH trace prints the full body
// beside it.
//
// ⚠️ KYC and bank values are masked here even though the full-body trace next
// to it is not — this summary is the line someone pastes into a ticket.
function maskTail(value, visible = 4) {
  if (isBlank(value)) return null;
  const text = String(value);
  return text.length <= visible ? '*'.repeat(text.length) : `${'*'.repeat(text.length - visible)}${text.slice(-visible)}`;
}

function logProposalPayloadAudit(label, payload, { transactionSource } = {}) {
  const proposal = proposalOf(payload);
  const policy = proposal?.POLICY || {};
  const contract = policy.CONTRACT_DETAILS || {};
  const paymentInfo = policy.PAYMENT_INFO || {};
  const otherDetails = policy.POLICY_OTHER_DETAILS || {};
  const kyc = proposal?.PROPOSER?.KYC || {};
  const bank = proposal?.PROPOSER?.BANK_DETAILS || {};
  const adjustments = Array.isArray(policy.ADJUSTMENT_DETAILS) ? policy.ADJUSTMENT_DETAILS : [];
  const copay = adjustments.find((a) => a?.ADJUSTMENT_CODE === 'A_COPAY');
  const present = (container, field) => (field in container ? JSON.stringify(container[field]) : '(absent)');

  console.log(`\n────────── ${label} — Niva Bupa field audit ──────────`);
  // The contract terms Niva Bupa reprice from. These have to equal what the
  // Premium call for this proposal was quoted on, field for field — the
  // frontend copies them off that request (utils/nivabupaUwPayload.js), and
  // printing them here is what makes a divergence visible on a live run rather
  // than only in a premium that comes back different. PRODUCT_VARIANT is first
  // because it was previously hardcoded to "Diamond" for every tier.
  console.log('  PRODUCT_VARIANT      :', present(contract, 'PRODUCT_VARIANT'));
  console.log('  PRODUCT_CODE         :', present(contract, 'PRODUCT_CODE'));
  console.log('  SUM_INSURED          :', present(contract, 'SUM_INSURED'));
  console.log('  POLICY_TERM          :', present(contract, 'POLICY_TERM'));
  console.log('  PAYMENT_FREQUENCY    :', present(contract, 'PAYMENT_FREQUENCY'));
  console.log('  COVERAGE_TYPE        :', present(contract, 'COVERAGE_TYPE'));
  console.log('  ADULTS/CHILD COVERED :', present(contract, 'ADULTS_COVERED'), '/', present(contract, 'CHILD_COVERED'));
  console.log('  PREMIUM_CALC_DATE    :', present(contract, 'PREMIUM_CALCULATION_DATE'));
  console.log('  SOURCING_APPNO       :', sourcingAppNoOf(payload) || '(absent)');
  console.log('  PAYMENT_COLLECT_MODE :', present(paymentInfo, 'PAYMENT_COLLECT_MODE'));
  console.log('  TRANSACTION_NUMBER   :', present(paymentInfo, 'TRANSACTION_NUMBER'), transactionSource ? `← ${transactionSource}` : '');
  console.log('  PAYMENT_RECEIVED_FLAG:', present(paymentInfo, 'PAYMENT_RECEIVED_FLAG'));
  console.log('  PAYMENT_DATE         :', present(paymentInfo, 'PAYMENT_DATE'));
  console.log('  LOGIN_BRANCH_CODE    :', present(otherDetails, 'LOGIN_BRANCH_CODE'));
  console.log('  NOC_BRANCH_CODE      :', present(otherDetails, 'NOC_BRANCH_CODE'));
  console.log('  AGENT_CODE           :', present(policy.SOURCING_INFO?.AGENT_INFO || {}, 'AGENT_CODE'));
  console.log('  Riders sent          :', adjustments.map((a) => `${a?.ADJUSTMENT_CODE}=${a?.ADJUSTMENT_VALUE}`).join(', ') || '(none)');
  console.log('  A_COPAY              :', copay ? `SENT value=${copay.ADJUSTMENT_VALUE}` : 'omitted (rider not selected) ✔');
  console.log('  PROPOSER.KYC         :', {
    PAN_NUMBER: maskTail(kyc.PAN_NUMBER),
    AADHAR_NUMBER: maskTail(kyc.AADHAR_NUMBER),
    ID_PROOF: kyc.ID_PROOF ?? null,
    CKYC_NUMBER: maskTail(kyc.CKYC_NUMBER),
    PASSPORT: maskTail(kyc.PASSPORT),
    GST_NO: kyc.GST_NO ?? null,
    CKYC_CONSENT: kyc.CKYC_CONSENT ?? null,
    CKYC_CONSENT_DATE: kyc.CKYC_CONSENT_DATE ?? null,
  });
  console.log('  PROPOSER.BANK_DETAILS:', {
    BANK_NAME: bank.BANK_NAME ?? null,
    BANK_ACC_TYPE: bank.BANK_ACC_TYPE ?? null,
    BANK_ACCOUNT_NO: maskTail(bank.BANK_ACCOUNT_NO),
    BANK_IFSC_CODE: bank.BANK_IFSC_CODE ?? null,
    BANK_BRANCH: bank.BANK_BRANCH ?? null,
    BANK_CITY: bank.BANK_CITY ?? null,
  });

  // Empty KYC/bank blocks are the exact defect Niva Bupa reported, and they are
  // silent otherwise — the request succeeds and the fields simply are not there.
  if (!kyc.PAN_NUMBER && !kyc.AADHAR_NUMBER) {
    console.warn('  ⚠️  Proposer KYC has neither PAN nor Aadhaar — Niva Bupa will see KYC as missing.');
  }
  if (!bank.BANK_ACCOUNT_NO || !bank.BANK_IFSC_CODE) {
    console.warn('  ⚠️  Proposer bank details incomplete (account number / IFSC missing).');
  }
  console.log('─'.repeat(label.length + 40), '\n');
}

export {
  applyBusinessDefaults,
  resolveTransactionNumber,
  logProposalPayloadAudit,
  sourcingAppNoOf,
};
