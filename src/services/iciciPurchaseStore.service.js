import db from '../db/index.js';
import { currentIciciEnvironment } from '../helpers/iciciEnvironment.helper.js';
import { ICICI_API_NAMES } from '../constants/icici.constants.js';
import * as store from './healthPurchase.service.js';
import * as repo from '../repositories/healthPurchase.repository.js';
import * as icici from '../repositories/healthIcici.repository.js';
import { encrypt, currentKeyVersion } from '../utils/healthCrypto.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard → health purchase store (migrations 008 + 012).
//
// Called by controllers/icici.controller.js after every ICICI call, beside the
// existing audit row, with what went up and what came back. It never changes
// the call or its answer and never throws (store.guarded).
//
//   quote               log only; attached to a purchase if the TransactionId has one
//   CKYC / OVD          a health_icici_kyc attempt; creates the purchase
//   proposal            health_icici_proposals, the proposer (health_customers),
//                       insured members, nominee and appointee, and the payment
//                       attempt (health_payments + health_icici_payments) once
//                       ICICI hand back a PaymentUrl
//   policy/status       ICICI's verdict on the money (Paid → SUCCESS) and the
//                       policy (ACTIVE + PolicyNo → ISSUED). This is the only
//                       way this backend learns the payment outcome: ICICI's
//                       hosted gateway returns the buyer straight to the
//                       website. An unchanged answer is not logged again.
//   policy sync         the policy
//   COI                 the certificate, encrypted, in health_policy_documents
//   EMI / zone          log only
//
// The key: ICICI's TransactionId (bnc_…), the same from quote to status. A
// call carrying X-Purchase-Id is matched by it only when the TransactionId is
// not yet known and that purchase has no other TransactionId.
// ─────────────────────────────────────────────────────────────────────────────

const INSURER = 'ICICI_LOMBARD';
const LOG_TABLE = 'health_icici_api_logs';

// Calls that start or move a purchase: the TransactionId each carries, and
// whether this call may CREATE the purchase when none exists. KYC and proposal
// attempts always may (that is the buyer starting to buy, failed or not); a
// status, sync or certificate call only when it brings something to keep, so a
// failed or empty answer never leaves an empty purchase behind.
const STEPS = {
  [ICICI_API_NAMES.CKYC]: { txn: (i) => i.requestBody?.transactionId, create: () => true },
  [ICICI_API_NAMES.OVD_INITIATE]: { txn: (i) => i.requestBody?.quoteTransactionId, create: () => true },
  [ICICI_API_NAMES.PROPOSAL]: {
    txn: (i) => i.requestBody?.TransactionId ?? i.responseData?.transactionId, create: () => true,
  },
  [ICICI_API_NAMES.POLICY_STATUS]: {
    txn: (i) => i.requestBody?.TransactionId,
    create: (i) => !i.error && Boolean(paymentVerdict(i.responseData?.paymentStatus) || i.responseData?.policyNo),
  },
  [ICICI_API_NAMES.POLICY_SYNC]: {
    txn: (i) => i.requestBody?.TransactionId, create: (i) => !i.error && Boolean(i.responseData?.policyNo),
  },
  [ICICI_API_NAMES.COI]: { txn: (i) => i.correlationId, create: (i) => !i.error && Boolean(i.document?.base64) },
};

// Calls that are only logged, attached to a purchase when one exists.
const LOG_ONLY = {
  [ICICI_API_NAMES.QUOTE]: (i) => i.responseData?.transactionId,
  [ICICI_API_NAMES.EMI_DUE]: (i) => i.requestBody?.TransactionId,
  [ICICI_API_NAMES.EMI_PROCESS]: (i) => i.requestBody?.TransactionId,
  [ICICI_API_NAMES.ZONE]: () => null,
};

/**
 * @param {object} input
 *   req            the Express request (X-Purchase-Id is read from it)
 *   apiName        ICICI_API_NAMES value
 *   httpMethod, httpStatus, endpointUrl, durationMs
 *   requestBody    the body as received (used for the purchase; never stored raw for CKYC/OVD)
 *   requestForLog  what the log may keep of the request (CKYC/OVD/COI: described, no documents or ids)
 *   responseData   result.data on success, error.details on failure
 *   responseForLog what the log may keep of the response (COI: a summary, never the document)
 *   error          { code, message } on failure
 *   correlationId  the reference the existing audit row records
 *   document       { base64, contentType } for a COI
 * @returns {Promise<{purchaseRef: string}|null>}
 */
export function recordIciciCall(input) {
  return store.guarded(`icici ${input.apiName}`, async () => {
    const insurerEnv = currentIciciEnvironment() === 'production' ? 'PROD' : 'UAT';
    const step = STEPS[input.apiName];
    const transactionId = step ? step.txn(input) : (LOG_ONLY[input.apiName]?.(input) ?? null);

    // 1. The evidence, before anything else.
    let log = null;
    try {
      log = await store.writeApiLog(LOG_TABLE, logEntry(input, insurerEnv, transactionId));
    } catch (error) {
      console.error(`⚠️  Purchase store [icici ${input.apiName}] log not saved: ${error.message}`);
    }
    const apiLog = log?.id ? { table: LOG_TABLE, id: log.id } : null;

    // 2. The purchase step.
    let found = null;
    if (step && transactionId) {
      found = await store.withPurchaseLock(`${INSURER}:${transactionId}`, async (connection) => {
        const run = db.runner(connection);
        const resolved = await store.resolvePurchase(run, {
          insurerCode: INSURER,
          insurerEnv,
          findByInsurerRef: (r) => icici.findPurchaseIdByTransaction(r, transactionId),
          headerRef: input.req?.get?.('X-Purchase-Id') || null,
          acceptHeader: async (r, purchase) => !(await icici.transactionOfPurchase(r, purchase.id)),
          create: step.create(input),
        });
        if (!resolved) return null;
        await applyStep(run, resolved.purchase, input, transactionId, apiLog);
        return resolved.purchase;
      });
    } else if (transactionId) {
      const id = await icici.findPurchaseIdByTransaction(db.runner(), transactionId);
      if (id) found = await repo.findPurchaseById(db.runner(), id);
    }

    if (found && apiLog) await store.linkApiLog(LOG_TABLE, apiLog.id, found.id);
    return found?.purchase_ref ? { purchaseRef: found.purchase_ref } : null;
  });
}

// ── The steps ───────────────────────────────────────────────────────────────

async function applyStep(run, purchase, input, transactionId, apiLog) {
  switch (input.apiName) {
    case ICICI_API_NAMES.CKYC: return kycStep(run, purchase, input, transactionId, apiLog, 'CKYC');
    case ICICI_API_NAMES.OVD_INITIATE: return kycStep(run, purchase, input, transactionId, apiLog, 'OVD');
    case ICICI_API_NAMES.PROPOSAL: return proposalStep(run, purchase, input, transactionId, apiLog);
    case ICICI_API_NAMES.POLICY_STATUS: return statusStep(run, purchase, input, transactionId, apiLog, { withPayment: true });
    case ICICI_API_NAMES.POLICY_SYNC: return statusStep(run, purchase, input, transactionId, apiLog, { withPayment: false });
    case ICICI_API_NAMES.COI: return coiStep(run, purchase, input, apiLog);
    default: return null;
  }
}

async function kycStep(run, purchase, input, transactionId, apiLog, method) {
  const d = input.responseData || {};
  const verified = !input.error && d.isKycSuccess === true;
  const status = input.error ? 'FAILED' : (verified ? 'VERIFIED' : 'REJECTED');
  const body = input.requestBody || {};
  const kycId = await icici.insertKyc(run, {
    purchase_id: purchase.id,
    method,
    kyc_transaction_id: String(transactionId).slice(0, 60),
    status,
    ckyc_number_enc: method === 'CKYC' ? encrypt(body.ckycNumber || null) : null,
    // ICICI's KYC reference: KycID on CKYC. (OVD answers carry none.)
    ovd_reference: method === 'CKYC' ? text(d.kycId, 100) : null,
    status_message: text(input.error?.message || d.displayMessage || d.errorMessage, 500),
    verified_at: verified ? new Date() : null,
    enc_key_version: currentKeyVersion(),
  });
  if (method === 'CKYC') {
    // The PAN the buyer verified is the strongest identity we get; Aadhaar is never stored.
    await store.saveCustomer(run, purchase, { pan: body.panNumber || null, dob: body.dateOfBirth || null });
  }
  await store.applyPurchaseChange(run, purchase, {
    statuses: { kyc_status: status, status: verified ? 'KYC_DONE' : 'KYC_PENDING' },
    entity: 'KYC', entityId: kycId, apiLog,
    message: `${method} ${status}`,
  });
}

async function proposalStep(run, purchase, input, transactionId, apiLog) {
  const body = input.requestBody || {};
  const d = input.responseData || {};

  await saveProposerAndMembers(run, purchase, body);

  if (input.error) {
    const existing = await icici.findProposal(run, purchase.id);
    // A failed resubmission does not undo a proposal ICICI already accepted.
    if (!existing || existing.status !== 'SUBMITTED') {
      await icici.saveProposal(run, purchase.id, {
        transaction_id: String(transactionId).slice(0, 60),
        request_id: text(body.RequestId, 60),
        status: 'FAILED',
        status_message: text(`${input.error.code || 'ERROR'}: ${input.error.message}`, 500),
      });
    }
    await store.applyPurchaseChange(run, purchase, {
      statuses: { proposal_status: 'FAILED' }, entity: 'PROPOSAL', apiLog,
      message: text(input.error.code, 500),
    });
    return;
  }

  const proposalRowId = await icici.saveProposal(run, purchase.id, {
    transaction_id: String(transactionId).slice(0, 60),
    proposal_id: text(d.proposalId, 60),
    request_id: text(d.requestId ?? body.RequestId, 60),
    pf_policy_no: text(d.pfPolicyNo, 80),
    base_pf_policy_no: text(d.basePfPolicyNo, 80),
    basic_premium: num(d.basicPremium),
    gst: num(d.gst),
    total_premium: num(d.totalPremium),
    emi_amount: num(d.emiAmount),
    policy_start_date: toSqlDate(d.policyStartDate),
    policy_end_date: toSqlDate(d.policyEndDate),
    payment_url_enc: encrypt(d.paymentUrl || null),
    status: 'SUBMITTED',
    status_message: d.status ? text(`ICICI status ${d.status}`, 500) : null,
    enc_key_version: currentKeyVersion(),
  });

  const insured = Array.isArray(body.Insured) ? body.Insured : [];
  const statuses = { proposal_status: 'SUBMITTED', status: d.paymentUrl ? 'PAYMENT_PENDING' : 'PROPOSAL_SUBMITTED' };
  if (d.paymentUrl) {
    const { payment } = await store.ensurePayment(run, purchase, {
      insurerCode: INSURER, paymentRef: transactionId, gateway: 'ICICI_PG',
      amount: num(d.totalPremium) ?? 0, frontendReturnUrl: body.SuccessUrl || null,
    });
    if (!(await icici.findIciciPayment(run, transactionId, { forUpdate: true }))) {
      await icici.insertIciciPayment(run, {
        purchase_id: purchase.id, health_payment_id: payment.id, transaction_id: String(transactionId).slice(0, 60),
      });
    }
    statuses.payment_status = 'INITIATED';
  }

  await store.applyPurchaseChange(run, purchase, {
    statuses,
    fields: {
      productCode: text(body.ProductCode, 50),
      sumInsured: num(body.SumInsured),
      tenureYears: int(body.Tenure),
      adults: insured.filter((m) => /adult/i.test(m?.InsuredType ?? '')).length || null,
      children: insured.filter((m) => /child|kid/i.test(m?.InsuredType ?? '')).length || null,
      finalPremium: num(d.totalPremium),
      gstAmount: num(d.gst),
      proposalNumber: text(d.proposalId, 80),
      policyStartDate: toSqlDate(d.policyStartDate),
      policyEndDate: toSqlDate(d.policyEndDate),
    },
    entity: 'PROPOSAL', entityId: proposalRowId, apiLog,
    message: d.status ? `ICICI status ${d.status}` : null,
  });
}

async function statusStep(run, purchase, input, transactionId, apiLog, { withPayment }) {
  if (input.error) return; // a failed status call says nothing about the purchase
  const d = input.responseData || {};
  const statuses = {};
  const fields = {};

  if (withPayment) {
    const verdict = paymentVerdict(d.paymentStatus);
    let row = await icici.findIciciPayment(run, transactionId, { forUpdate: true });
    if (!row && verdict) {
      // ICICI know of a payment this store never saw start (the purchase began
      // before this release, or the proposal was not recorded).
      const proposal = await icici.findProposal(run, purchase.id);
      const amount = num(proposal?.total_premium);
      const { payment } = await store.ensurePayment(run, purchase, {
        insurerCode: INSURER, paymentRef: transactionId, gateway: 'ICICI_PG', amount: amount ?? 0,
      });
      await icici.insertIciciPayment(run, {
        purchase_id: purchase.id, health_payment_id: payment.id, transaction_id: String(transactionId).slice(0, 60),
      });
      if (amount === null) {
        await repo.insertEvent(run, {
          purchase_id: purchase.id, entity: 'PAYMENT', event_type: 'NOTE', source: 'STATUS_POLL',
          api_log_table: apiLog?.table ?? null, api_log_id: apiLog?.id ?? null,
          message: 'Payment first seen on policy/status; amount unknown (no proposal recorded)',
        });
        await repo.flagPurchaseForReview(run, purchase.id, 'payment amount unknown: no proposal recorded');
      }
      row = await icici.findIciciPayment(run, transactionId, { forUpdate: true });
    }
    if (row) {
      await icici.recordPoll(run, row.id, text(d.paymentStatus, 40));
      if (verdict) {
        const payment = await repo.findPaymentByRef(run, INSURER, transactionId, { forUpdate: true });
        await store.applyPaymentResult(run, purchase, payment, {
          status: verdict, verifiedVia: 'STATUS_API', source: 'STATUS_POLL', apiLog,
          failureReason: verdict === 'FAILED' ? `ICICI PaymentStatus ${d.paymentStatus}` : null,
        });
        statuses.payment_status = verdict;
        if (verdict === 'SUCCESS') statuses.status = 'PAID';
        if (verdict === 'FAILED') statuses.status = 'PAYMENT_FAILED';
        if (verdict === 'PENDING') statuses.status = 'PAYMENT_PENDING';
      }
    }
  }

  const issued = Boolean(d.policyNo) && (withPayment ? String(d.policyStatus || '').toUpperCase() === 'ACTIVE' : true);
  if (d.policyNo || d.policyStatus) {
    const existing = await icici.findPolicy(run, purchase.id);
    const policyStatus = issued ? 'ISSUED' : (existing?.status === 'ISSUED' ? undefined : 'PENDING');
    await icici.savePolicy(run, purchase.id, {
      policy_no: text(d.policyNo, 80),
      policy_status: text(d.policyStatus ?? d.status, 40),
      policy_sub_status: text(d.policySubStatus, 60),
      status: policyStatus,
      start_date: toSqlDate(d.startDate),
      end_date: toSqlDate(d.endDate),
    });
    if (issued) {
      statuses.policy_status = 'ISSUED';
      statuses.status = 'ISSUED';
      fields.completedAt = new Date();
    } else if (statuses.payment_status === 'SUCCESS') {
      statuses.policy_status = 'PENDING';
    }
    fields.policyNumber = text(d.policyNo, 80);
    fields.policyStartDate = toSqlDate(d.startDate);
    fields.policyEndDate = toSqlDate(d.endDate);
  } else if (statuses.payment_status === 'SUCCESS') {
    statuses.policy_status = 'PENDING';
  }

  await store.applyPurchaseChange(run, purchase, {
    statuses, fields, entity: issued ? 'POLICY' : 'PAYMENT', apiLog,
    source: withPayment ? 'STATUS_POLL' : 'API_RESPONSE',
    message: [d.paymentStatus && `PaymentStatus ${d.paymentStatus}`, d.policyStatus && `PolicyStatus ${d.policyStatus}`]
      .filter(Boolean).join(', ') || null,
  });
}

async function coiStep(run, purchase, input, apiLog) {
  const base64 = input.document?.base64;
  if (input.error || !base64) return;
  const bytes = Buffer.from(base64, 'base64');
  if (!bytes.length) return;
  const policy = await icici.findPolicy(run, purchase.id);
  const { id } = await store.storeDocument(run, purchase, {
    documentType: 'COI', bytes, mimeType: input.document.contentType || 'application/pdf',
    policyNumber: policy?.policy_no ?? purchase.policy_number ?? null,
  });
  await icici.savePolicy(run, purchase.id, { document_id: id });
  await store.applyPurchaseChange(run, purchase, { entity: 'DOCUMENT', entityId: id, apiLog });
}

// ── Proposer, members, nominee ──────────────────────────────────────────────

async function saveProposerAndMembers(run, purchase, body) {
  const p = body.Proposer && typeof body.Proposer === 'object' ? body.Proposer : null;
  if (p) {
    await store.saveCustomer(run, purchase, {
      pan: p.PanNumber ?? p.PANNumber ?? p.PanNo ?? p.PAN ?? null,
      mobile: p.MobileNo ?? p.MobileNumber ?? null,
      email: p.EmailId ?? p.Email ?? null,
      fullName: p.Name ?? ([p.FirstName, p.LastName].filter(Boolean).join(' ') || null),
      dob: p.DateOfBirth ?? p.DOB ?? null,
      address: pick(p, ['AddressLine1', 'AddressLine2', 'AddressLine3', 'Address', 'City', 'State', 'PinCode', 'Pincode']),
      gender: genderCode(p.Gender),
      pincode: p.PinCode ?? p.Pincode ?? null,
      city: p.City ?? null,
      state: p.State ?? null,
    });
  }

  if (Array.isArray(body.Insured)) {
    const identity = new Set(['Name', 'FirstName', 'LastName', 'DateOfBirth', 'DOB', 'Gender', 'InsuredType',
      'RelationshipWithProposer', 'RelationshipWithApplicant', 'Occupation']);
    await store.saveMembers(run, purchase, 'INSURED', body.Insured.filter((m) => m && typeof m === 'object').map((m) => {
      const relation = m.RelationshipWithProposer ?? m.RelationshipWithApplicant ?? null;
      const medical = Object.fromEntries(Object.entries(m).filter(([k]) => !identity.has(k)));
      return {
        fullName: m.Name ?? ([m.FirstName, m.LastName].filter(Boolean).join(' ') || null),
        dob: m.DateOfBirth ?? m.DOB ?? null,
        ageAtPurchase: ageFrom(m.DateOfBirth ?? m.DOB),
        gender: genderCode(m.Gender),
        relation: relation ? String(relation).toUpperCase() : null,
        insurerRelation: relation,
        occupation: m.Occupation ?? null,
        medical, // height, weight, PED answers… encrypted
      };
    }));
  }

  if (body.NomineeName || body.NomineeDOB) {
    await store.saveMembers(run, purchase, 'NOMINEE', [{
      fullName: body.NomineeName ?? null,
      dob: body.NomineeDOB ?? null,
      ageAtPurchase: ageFrom(body.NomineeDOB),
      relation: body.RelationshipWithInsured ? String(body.RelationshipWithInsured).toUpperCase() : null,
      insurerRelation: body.RelationshipWithInsured ?? null,
      nomineeShare: 100,
    }]);
  }
  await store.saveMembers(run, purchase, 'APPOINTEE', body.AppointeeName ? [{
    fullName: body.AppointeeName,
    dob: body.AppointeeDOB ?? null,
    ageAtPurchase: ageFrom(body.AppointeeDOB),
    relation: body.AppointeeRelationship ? String(body.AppointeeRelationship).toUpperCase() : null,
    insurerRelation: body.AppointeeRelationship ?? null,
  }] : []);
}

// ── The log row ─────────────────────────────────────────────────────────────

function logEntry(input, insurerEnv, transactionId) {
  const d = input.responseData || {};
  let insurerStatus = null;
  if (!input.error) {
    if (input.apiName === ICICI_API_NAMES.POLICY_STATUS) insurerStatus = [d.paymentStatus, d.policyStatus].filter(Boolean).join('/') || null;
    else if (input.apiName === ICICI_API_NAMES.CKYC || input.apiName === ICICI_API_NAMES.OVD_INITIATE) {
      insurerStatus = d.isKycSuccess ? 'VERIFIED' : 'NOT_VERIFIED';
    } else insurerStatus = d.status ?? null;
  }
  const kycCall = input.apiName === ICICI_API_NAMES.CKYC || input.apiName === ICICI_API_NAMES.OVD_INITIATE;
  return {
    apiName: input.apiName,
    direction: 'OUTBOUND',
    insurerEnv,
    httpMethod: input.httpMethod || 'POST',
    endpointUrl: input.endpointUrl,
    httpStatus: input.httpStatus,
    outcome: input.error ? (input.error.code === 'TIMEOUT_ERROR' ? 'TIMEOUT' : 'FAILED') : 'SUCCESS',
    insurerStatus,
    correlationType: transactionId ? 'TRANSACTION_ID' : null,
    correlationId: transactionId ?? input.correlationId ?? null,
    durationMs: input.durationMs,
    request: input.requestForLog ?? input.requestBody ?? null,
    // CKYC/OVD bodies carry a PAN or Aadhaar number, or document scans: only
    // the described request is kept, even encrypted.
    requestExact: kycCall ? (input.requestForLog ?? null) : (input.requestBody ?? null),
    response: input.responseForLog ?? input.responseData ?? null,
    errorCode: input.error?.code ?? null,
    errorMessage: input.error?.message ?? null,
    dedupeUnchanged: input.apiName === ICICI_API_NAMES.POLICY_STATUS,
  };
}

// ── Small helpers ───────────────────────────────────────────────────────────

function paymentVerdict(paymentStatus) {
  if (paymentStatus === null || paymentStatus === undefined || paymentStatus === '') return null;
  const s = String(paymentStatus).trim().toLowerCase();
  if (['paid', 'success', 'successful', 'captured'].includes(s)) return 'SUCCESS';
  if (['failed', 'failure', 'declined', 'cancelled', 'canceled'].includes(s)) return 'FAILED';
  return 'PENDING';
}

function text(value, n) {
  return value === null || value === undefined || value === '' ? null : String(value).slice(0, n);
}

function num(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function int(value) {
  const n = num(value);
  return n === null ? null : Math.round(n);
}

function genderCode(value) {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s.startsWith('M')) return 'M';
  if (s.startsWith('F')) return 'F';
  return 'O';
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') out[k] = obj[k];
  return Object.keys(out).length ? out : null;
}

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** ICICI dates (30-Aug-1989, 2026-11-26T00:00:00, 26/11/2026) → 'YYYY-MM-DD', or null. */
export function toSqlDate(value) {
  if (!value) return null;
  const s = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}

function ageFrom(dob, now = new Date()) {
  const iso = toSqlDate(dob);
  if (!iso) return null;
  const [y, mo, d] = iso.split('-').map(Number);
  let age = now.getFullYear() - y;
  if (now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)) age -= 1;
  return age >= 0 && age < 130 ? age : null;
}
