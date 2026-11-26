import config from '../config/env.js';
import db from '../db/index.js';
import * as repo from '../repositories/healthPurchase.repository.js';
import {
  healthCryptoStatus, encrypt, encryptJson, lookupHash, mask, sha256Hex, newUlid, isUlid, currentKeyVersion,
} from '../utils/healthCrypto.js';
import { maskForStore } from '../helpers/healthMask.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The health purchase store: the one write path every insurer adapter uses
// (services/iciciPurchaseStore.service.js is the first). Tables: migrations
// 008–014.
//
// ── It must never break a sale ──────────────────────────────────────────────
// Every public entry point goes through guarded(): a failure is logged with
// its context and the insurer call carries on exactly as it would have. The
// store is OFF (every call a no-op, no database touched) until
// HEALTH_DATA_ENC_KEYS and HEALTH_DATA_HASH_KEY are set, MySQL is connected and
// the tables exist; index.js prints which at boot.
//
// ── One purchase step, one transaction ──────────────────────────────────────
// A step (KYC, proposal, payment result, policy, document) runs inside
// withPurchaseLock(): a MySQL named lock on the insurer's reference, then one
// transaction that writes the insurer row, the common rows and the event. The
// lock stops two first calls for one reference creating two purchases; the
// transaction means common and insurer rows can never disagree.
//
// ── Status only moves forward ───────────────────────────────────────────────
// decideTransition() compares the stored status with the proposed one. A move
// forward is applied; a stale one (an older answer arriving late) is ignored;
// a contradiction (FAILED after SUCCESS) is never applied: it is recorded as a
// CONFLICT event and the purchase is flagged needs_review.
// ─────────────────────────────────────────────────────────────────────────────

let schemaReady = null; // null: not checked (assumed present), false: missing

/** { enabled, reason } — why the store is off, in words an operator can act on. */
export function purchaseStoreStatus() {
  const crypto = healthCryptoStatus();
  if (!crypto.configured) return { enabled: false, reason: crypto.problem };
  if (db.isDisabled()) return { enabled: false, reason: 'MySQL is not connected' };
  if (schemaReady === false) {
    return { enabled: false, reason: 'the health purchase tables are missing; run npm run migrate (008–014)' };
  }
  return { enabled: true, reason: null, keyVersion: crypto.keyVersion };
}

export function isPurchaseStoreEnabled() {
  return purchaseStoreStatus().enabled;
}

/** Boot check: are migrations 008–014 applied here? Turns the store off if not. */
export async function checkPurchaseStoreSchema() {
  if (!healthCryptoStatus().configured || db.isDisabled()) return purchaseStoreStatus();
  try {
    const row = await db.queryOne(
      `SELECT COUNT(*) AS n FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_COMMENT LIKE '%[health-hybrid]%'`
    );
    schemaReady = Number(row?.n) >= 35;
  } catch {
    schemaReady = false;
  }
  return purchaseStoreStatus();
}

/** For tests. */
export function setPurchaseStoreSchemaReadyForTests(value) {
  schemaReady = value;
}

/**
 * Runs fn when the store is on; otherwise returns null without touching the
 * database. Never throws.
 */
export async function guarded(label, fn) {
  if (!isPurchaseStoreEnabled()) return null;
  try {
    return await fn();
  } catch (error) {
    console.error(`⚠️  Purchase store [${label}] not saved: ${error.message}`);
    if (config.env !== 'production' && error.stack) console.error(error.stack);
    return null;
  }
}

/**
 * Resolves with the store's answer if it arrives within `ms`, else with null,
 * while the write carries on in the background. Bounds what a slow database
 * can add to a buyer's response.
 */
export function waitBriefly(promise, ms = config.healthStore?.waitMs ?? 1500) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]);
}

/**
 * fn(connection) inside a MySQL named lock on `lockKey` and one transaction on
 * the same connection. Commits on success, rolls back on any error, always
 * releases the lock and the connection.
 */
export async function withPurchaseLock(lockKey, fn) {
  const connection = await db.getPool().getConnection();
  const name = `hp:${sha256Hex(lockKey).slice(0, 40)}`;
  try {
    const [rows] = await connection.query('SELECT GET_LOCK(?, 5) AS got', [name]);
    if (Number(rows[0]?.got) !== 1) throw new Error('could not take the purchase lock within 5 seconds');
    try {
      await connection.beginTransaction();
      const result = await fn(connection);
      await connection.commit();
      return result;
    } catch (error) {
      try { await connection.rollback(); } catch { /* the original error matters more */ }
      throw error;
    } finally {
      try { await connection.query('DO RELEASE_LOCK(?)', [name]); } catch { /* released with the session anyway */ }
    }
  } finally {
    connection.release();
  }
}

// ── Finding or creating the purchase ────────────────────────────────────────

/**
 * The purchase a call belongs to, locked FOR UPDATE for the rest of the
 * transaction:
 *   1. the insurer's own reference (findByInsurerRef), the authoritative key;
 *   2. else the caller's X-Purchase-Id, if it names a purchase of this insurer
 *      and environment that acceptHeader() agrees has no other reference;
 *   3. else, when `create`, a new purchase.
 * Returns { purchase, created } or null.
 */
export async function resolvePurchase(run, {
  insurerCode, insurerEnv, findByInsurerRef, headerRef = null, acceptHeader = null, create = false,
}) {
  let id = await findByInsurerRef(run);
  if (!id && isUlid(headerRef)) {
    const named = await repo.findPurchaseByRef(run, headerRef);
    if (named && named.insurer_code === insurerCode && named.insurer_env === insurerEnv
        && (!acceptHeader || await acceptHeader(run, named))) {
      id = named.id;
    }
  }
  let created = false;
  if (!id && create) {
    id = await repo.insertPurchase(run, {
      purchase_ref: newUlid(),
      insurer_code: insurerCode,
      insurer_env: insurerEnv,
    });
    created = true;
  }
  if (!id) return null;
  const purchase = await repo.findPurchaseById(run, id, { forUpdate: true });
  if (created) {
    await repo.insertEvent(run, {
      purchase_id: id, entity: 'PURCHASE', event_type: 'PURCHASE_CREATED',
      to_status: purchase.status, source: 'SYSTEM', message: 'First proposal-stage call',
    });
  }
  return { purchase, created };
}

// ── Status rules ────────────────────────────────────────────────────────────

const RANK = {
  status: {
    STARTED: 0, KYC_PENDING: 1, KYC_DONE: 2, PROPOSAL_SUBMITTED: 3, UW_REFERRED: 4,
    PAYMENT_PENDING: 5, PAYMENT_FAILED: 5, PAID: 6, ISSUANCE_FAILED: 6, ISSUED: 7,
    DECLINED: 9, ABANDONED: 9, CANCELLED: 9,
  },
  kyc_status: { NOT_STARTED: 0, PENDING: 1, REJECTED: 1, FAILED: 1, VERIFIED: 2 },
  proposal_status: { NOT_STARTED: 0, FAILED: 1, SUBMITTED: 2, REFERRED: 3, ACCEPTED: 3, DECLINED: 4 },
  payment_status: { NOT_STARTED: 0, INITIATED: 1, PENDING: 2, FAILED: 2, SUCCESS: 3, REFUNDED: 4 },
  policy_status: { NOT_ISSUED: 0, PENDING: 1, REJECTED: 2, ISSUED: 3, CANCELLED: 4 },
  // One health_payments row (one attempt).
  payment_row: {
    INITIATED: 1, PENDING: 2, FAILED: 3, CANCELLED: 3, SUCCESS: 4, NEEDS_REVIEW: 4, REFUND_PENDING: 5, REFUNDED: 6,
  },
};

// Moves sideways within a rank that are legitimate.
const SIDEWAYS = {
  status: new Set(['PAYMENT_PENDING>PAYMENT_FAILED', 'PAYMENT_FAILED>PAYMENT_PENDING', 'PAID>ISSUANCE_FAILED']),
  kyc_status: new Set(['PENDING>REJECTED', 'PENDING>FAILED', 'REJECTED>PENDING', 'FAILED>PENDING', 'REJECTED>FAILED', 'FAILED>REJECTED']),
  payment_status: new Set(['PENDING>FAILED']),
  payment_row: new Set(['FAILED>CANCELLED', 'CANCELLED>FAILED']),
};

// Backward moves that are a real retry, not a stale answer.
const RETRIES = {
  status: new Set(['PAYMENT_FAILED>PAYMENT_PENDING']),
  payment_status: new Set(['FAILED>INITIATED', 'FAILED>PENDING']),
};

// Backward moves that contradict what is stored: never applied, always flagged.
const CONFLICTS = {
  status: new Set(['PAID>PAYMENT_FAILED', 'ISSUED>PAYMENT_FAILED', 'ISSUED>DECLINED', 'PAID>DECLINED']),
  payment_status: new Set(['SUCCESS>FAILED']),
  policy_status: new Set(['ISSUED>REJECTED']),
  payment_row: new Set(['SUCCESS>FAILED', 'SUCCESS>CANCELLED']),
};

/**
 * 'apply' | 'same' | 'stale' | 'conflict' for moving `column` from → to.
 * Exported for the tests.
 */
export function decideTransition(column, from, to) {
  if (to === undefined || to === null) return 'same';
  if (from === to) return 'same';
  const ranks = RANK[column];
  if (!ranks || !(to in ranks)) throw new Error(`unknown ${column} value ${to}`);
  const key = `${from}>${to}`;
  if (CONFLICTS[column]?.has(key)) return 'conflict';
  if (from === null || from === undefined) return 'apply';
  const a = ranks[from] ?? -1;
  const b = ranks[to];
  if (RETRIES[column]?.has(key)) return 'apply';
  if (b > a) return a >= 9 ? 'stale' : 'apply';
  if (b === a) return SIDEWAYS[column]?.has(key) ? 'apply' : 'stale';
  return 'stale';
}

/**
 * Applies plan fields, status moves and the events they produce to a purchase
 * locked in this transaction. Returns { applied: {column: [from, to]}, conflicts: [...] }.
 */
export async function applyPurchaseChange(run, purchase, {
  statuses = {}, fields = {}, entity = 'PURCHASE', entityId = null, source = 'API_RESPONSE',
  apiLog = null, idempotencyKey = null, message = null,
}) {
  const fieldColumns = {
    customer_id: fields.customerId,
    product_code: fields.productCode,
    product_name: fields.productName,
    plan_variant: fields.planVariant,
    cover_type: fields.coverType,
    sum_insured: fields.sumInsured,
    tenure_years: fields.tenureYears,
    payment_frequency: fields.paymentFrequency,
    adults: fields.adults,
    children: fields.children,
    quoted_premium: fields.quotedPremium,
    final_premium: fields.finalPremium,
    gst_amount: fields.gstAmount,
    proposal_number: fields.proposalNumber,
    application_number: fields.applicationNumber,
    policy_number: fields.policyNumber,
    policy_issue_date: fields.policyIssueDate,
    policy_start_date: fields.policyStartDate,
    policy_end_date: fields.policyEndDate,
    agent_code: fields.agentCode,
    frontend_app: fields.frontendApp,
    completed_at: fields.completedAt,
  };
  for (const [column, value] of Object.entries(fieldColumns)) {
    if (value === null || value === undefined || value === '') delete fieldColumns[column];
  }
  await repo.patchPurchase(run, purchase.id, fieldColumns);

  const applied = {};
  const conflicts = [];
  for (const [column, to] of Object.entries(statuses)) {
    const from = purchase[column];
    const decision = decideTransition(column, from, to);
    if (decision === 'apply') applied[column] = [from, to];
    if (decision === 'conflict') conflicts.push({ column, from, to });
  }
  if (Object.keys(applied).length) {
    await repo.setPurchaseStatuses(run, purchase.id, Object.fromEntries(Object.entries(applied).map(([c, [, to]]) => [c, to])));
    const [mainColumn, [from, to]] = applied.status ? ['status', applied.status] : Object.entries(applied)[0];
    await repo.insertEvent(run, {
      purchase_id: purchase.id, entity, entity_id: entityId, event_type: 'STATUS_CHANGED',
      from_status: from, to_status: to, source,
      api_log_table: apiLog?.table ?? null, api_log_id: apiLog?.id ?? null,
      idempotency_key: idempotencyKey, message,
      details: db.toJson({ changes: applied, main: mainColumn }),
    });
    for (const [column, [, value]] of Object.entries(applied)) purchase[column] = value;
  }
  for (const conflict of conflicts) {
    await repo.insertEvent(run, {
      purchase_id: purchase.id, entity, entity_id: entityId, event_type: 'CONFLICT',
      from_status: conflict.from, to_status: conflict.to, source,
      api_log_table: apiLog?.table ?? null, api_log_id: apiLog?.id ?? null,
      message: `${conflict.column} is ${conflict.from}; refused to move it to ${conflict.to}`,
    });
    await repo.flagPurchaseForReview(run, purchase.id, `${conflict.column}: ${conflict.from} then ${conflict.to}`);
  }
  return { applied, conflicts };
}

// ── Customers and members ───────────────────────────────────────────────────

const clamp = (value, n) => (value === null || value === undefined || value === '' ? null : String(value).slice(0, n));

/**
 * Saves the proposer as the purchase's customer (encrypted, hashed, masked)
 * and links it. Skipped when nothing identifying was given.
 */
export async function saveCustomer(run, purchase, input = {}) {
  const { pan, mobile, email, fullName, dob, address, gender, pincode, city, state } = input;
  if (![pan, mobile, email, fullName, dob].some((v) => v !== null && v !== undefined && v !== '')) return null;
  const columns = {
    pan_hash: lookupHash('pan', pan),
    mobile_hash: lookupHash('mobile', mobile),
    email_hash: lookupHash('email', email),
    pan_enc: encrypt(pan ? String(pan).trim().toUpperCase() : null),
    mobile_enc: encrypt(mobile ? String(mobile).trim() : null),
    email_enc: encrypt(email ? String(email).trim() : null),
    full_name_enc: encrypt(fullName ? String(fullName).trim() : null),
    dob_enc: encrypt(dob ? String(dob).trim() : null),
    address_enc: address ? encryptJson(address) : null,
    pan_masked: mask.pan(pan),
    mobile_masked: mask.mobile(mobile),
    name_masked: mask.name(fullName),
    gender: clamp(gender, 1)?.toUpperCase() ?? null,
    pincode: clamp(pincode, 10),
    city: clamp(city, 100),
    state: clamp(state, 100),
    enc_key_version: currentKeyVersion(),
  };
  const customerId = await repo.upsertCustomer(run, {
    existingId: purchase.customer_id, customerRef: newUlid(), columns,
  });
  if (customerId !== purchase.customer_id) {
    await repo.patchPurchase(run, purchase.id, { customer_id: customerId });
    purchase.customer_id = customerId;
  }
  return customerId;
}

/**
 * Members of one role (INSURED, NOMINEE, APPOINTEE), each
 * { fullName, dob, ageAtPurchase, gender, relation, insurerRelation,
 *   occupation, nomineeShare, medical, uwLoadingPct }.
 */
export async function saveMembers(run, purchase, role, members) {
  const rows = members.map((m, index) => ({
    member_seq: index + 1,
    relation: clamp(m.relation, 30),
    insurer_relation: clamp(m.insurerRelation, 30),
    full_name_enc: encrypt(m.fullName ? String(m.fullName).trim() : null),
    name_masked: mask.name(m.fullName),
    dob_enc: encrypt(m.dob ? String(m.dob).trim() : null),
    age_at_purchase: Number.isFinite(m.ageAtPurchase) ? m.ageAtPurchase : null,
    gender: clamp(m.gender, 1)?.toUpperCase() ?? null,
    occupation: clamp(m.occupation, 100),
    nominee_share: m.nomineeShare ?? null,
    medical_enc: m.medical && Object.keys(m.medical).length ? encryptJson(m.medical) : null,
    uw_loading_pct: m.uwLoadingPct ?? null,
    enc_key_version: currentKeyVersion(),
  }));
  await repo.replaceMembers(run, purchase.id, role, rows);
}

// ── Payments ────────────────────────────────────────────────────────────────

/**
 * The health_payments row for this insurer reference, created as attempt n+1
 * if it does not exist. While it is still INITIATED, a new amount replaces the
 * old one (a re-priced resubmission).
 */
export async function ensurePayment(run, purchase, {
  insurerCode, paymentRef, gateway, amount, frontendReturnUrl = null,
}) {
  const existing = await repo.findPaymentByRef(run, insurerCode, paymentRef, { forUpdate: true });
  if (existing) {
    if (existing.status === 'INITIATED' && amount !== null && amount !== undefined && Number(existing.amount) !== Number(amount)) {
      await repo.updatePayment(run, existing.id, { amount });
      existing.amount = amount;
    }
    return { payment: existing, created: false };
  }
  const id = await repo.insertPayment(run, {
    purchase_id: purchase.id,
    insurer_code: insurerCode,
    payment_ref: String(paymentRef).slice(0, 40),
    attempt_no: await repo.nextPaymentAttempt(run, purchase.id),
    gateway,
    amount: amount ?? 0,
    frontend_return_url: clamp(frontendReturnUrl, 500),
  });
  return { payment: await repo.findPaymentByRef(run, insurerCode, paymentRef, { forUpdate: true }), created: true, id };
}

/**
 * Applies a payment verdict to one attempt. SUCCESS → FAILED is a conflict:
 * never applied, recorded and flagged. Returns 'apply' | 'same' | 'stale' | 'conflict'.
 */
export async function applyPaymentResult(run, purchase, payment, {
  status, verifiedVia, gatewayTxnId = null, paidAmount = null, failureReason = null,
  source = 'API_RESPONSE', apiLog = null,
}) {
  const decision = decideTransition('payment_row', payment.status, status);
  if (decision === 'apply') {
    const now = new Date();
    await repo.updatePayment(run, payment.id, {
      status,
      gateway_txn_id: gatewayTxnId ?? payment.gateway_txn_id ?? null,
      paid_amount: paidAmount ?? payment.paid_amount ?? null,
      failure_reason: failureReason ? String(failureReason).slice(0, 500) : payment.failure_reason ?? null,
      verified_via: verifiedVia ?? payment.verified_via ?? null,
      verified_at: ['SUCCESS', 'FAILED'].includes(status) ? now : payment.verified_at ?? null,
      completed_at: ['SUCCESS', 'FAILED', 'CANCELLED'].includes(status) ? now : payment.completed_at ?? null,
    });
    await repo.insertEvent(run, {
      purchase_id: purchase.id, entity: 'PAYMENT', entity_id: payment.id, event_type: 'STATUS_CHANGED',
      from_status: payment.status, to_status: status, source,
      api_log_table: apiLog?.table ?? null, api_log_id: apiLog?.id ?? null,
      idempotency_key: `${payment.insurer_code}:${payment.payment_ref}:${status}`.slice(0, 150),
      message: verifiedVia ? `verified via ${verifiedVia}` : null,
    });
    payment.status = status;
  } else if (decision === 'conflict') {
    await repo.insertEvent(run, {
      purchase_id: purchase.id, entity: 'PAYMENT', entity_id: payment.id, event_type: 'CONFLICT',
      from_status: payment.status, to_status: status, source,
      api_log_table: apiLog?.table ?? null, api_log_id: apiLog?.id ?? null,
      message: `payment ${payment.payment_ref} is ${payment.status}; refused to move it to ${status}`,
    });
    await repo.flagPurchaseForReview(run, purchase.id, `payment ${payment.status} then ${status}`);
  }
  return decision;
}

// ── Documents ───────────────────────────────────────────────────────────────

export async function storeDocument(run, purchase, { documentType, bytes, mimeType = 'application/pdf', policyNumber = null }) {
  const result = await repo.insertDocument(run, {
    purchase_id: purchase.id,
    insurer_code: purchase.insurer_code,
    document_type: documentType,
    policy_number: clamp(policyNumber, 80),
    status: 'STORED',
    content_enc: encrypt(bytes),
    mime_type: clamp(mimeType, 60),
    size_bytes: bytes.length,
    sha256: sha256Hex(bytes),
    fetch_attempts: 1,
    fetched_at: new Date(),
    enc_key_version: currentKeyVersion(),
  });
  if (result.inserted) {
    await repo.insertEvent(run, {
      purchase_id: purchase.id, entity: 'DOCUMENT', entity_id: result.id, event_type: 'DOCUMENT_STORED',
      to_status: 'STORED', source: 'API_RESPONSE', message: `${documentType}, ${bytes.length} bytes`,
    });
  }
  return result;
}

// ── Insurer API logs ────────────────────────────────────────────────────────

const TEST_HOST = /(^|\.)invalid$|^localhost$|^127\.0\.0\.1$|^undefined$/i;

function endpointParts(url) {
  if (!url) return { endpoint: null, isTest: false };
  const text = String(url);
  try {
    const u = new URL(text);
    return { endpoint: `${u.protocol}//${u.host}${u.pathname}`.slice(0, 300), isTest: TEST_HOST.test(u.hostname) };
  } catch {
    return { endpoint: text.split('?')[0].slice(0, 300), isTest: /^undefined/i.test(text) };
  }
}

/**
 * One row in health_<insurer>_api_logs, outside any purchase transaction so it
 * survives a failed step. `request` / `response` are what the masked copy is
 * made from; `requestExact` / `responseExact` (default: the same) are what is
 * encrypted. With dedupeUnchanged, a call whose answer is identical to the last
 * one logged for the same reference (a status poll) is not logged again.
 * Returns { id } or { skipped: true }.
 */
export async function writeApiLog(table, entry) {
  const run = db.runner();
  const responseExact = entry.responseExact === undefined ? entry.response : entry.responseExact;
  const requestExact = entry.requestExact === undefined ? entry.request : entry.requestExact;
  const payloadHash = sha256Hex(`${entry.outcome}|${JSON.stringify(responseExact ?? null)}`);
  if (entry.dedupeUnchanged && entry.correlationId) {
    const last = await repo.lastLoggedPayloadHash(run, table, entry.apiName, entry.correlationId);
    if (last === payloadHash) return { skipped: true };
  }
  const { endpoint, isTest } = endpointParts(entry.endpointUrl);
  const id = await repo.insertApiLog(run, table, {
    purchase_id: entry.purchaseId ?? null,
    api_name: String(entry.apiName).slice(0, 60),
    direction: entry.direction || 'OUTBOUND',
    insurer_env: entry.insurerEnv,
    http_method: clamp(entry.httpMethod, 10),
    endpoint,
    http_status: entry.httpStatus || null,
    outcome: entry.outcome,
    insurer_status: clamp(entry.insurerStatus, 80),
    correlation_type: clamp(entry.correlationType, 30),
    correlation_id: clamp(entry.correlationId, 100),
    duration_ms: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : null,
    request_masked: db.toJson(maskForStore(entry.request ?? null)),
    response_masked: db.toJson(maskForStore(entry.response ?? null)),
    request_enc: requestExact === null || requestExact === undefined ? null : encryptJson(requestExact),
    response_enc: responseExact === null || responseExact === undefined ? null : encryptJson(responseExact),
    payload_sha256: payloadHash,
    error_code: clamp(entry.errorCode, 60),
    error_message: entry.errorMessage ? String(entry.errorMessage).slice(0, 65535) : null,
    is_test: isTest ? 1 : 0,
    enc_key_version: currentKeyVersion(),
  });
  return { id };
}

/** Links an already-written log row to its purchase (when the step resolved one). */
export async function linkApiLog(table, logId, purchaseId) {
  if (!logId || !purchaseId) return;
  if (!/^health_[a-z]+_api_logs$/.test(table)) throw new Error(`not an insurer log table: ${table}`);
  await db.query(`UPDATE \`${table}\` SET purchase_id = ? WHERE id = ? AND purchase_id IS NULL`, [purchaseId, logId]);
}
