import { setClause, insertSql } from './healthPurchase.repository.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard tables of the health purchase store (migration 012):
// health_icici_proposals, _kyc, _payments, _policies. (_api_logs goes through
// healthPurchase.repository.js insertApiLog, shared by every insurer.)
//
// ICICI's TransactionId (bnc_…) is the same from quote to policy/status, so it
// is the key a call is matched to its purchase by. Plain SQL; every function
// takes `run` (db.runner(connection)); nothing here swallows errors.
// ─────────────────────────────────────────────────────────────────────────────

/** The purchase an ICICI TransactionId already belongs to, or null. */
export async function findPurchaseIdByTransaction(run, transactionId) {
  if (!transactionId) return null;
  const row = await run.queryOne(
    `SELECT purchase_id FROM (
       SELECT purchase_id, 1 AS rank_ FROM health_icici_proposals WHERE transaction_id = ?
       UNION ALL
       SELECT purchase_id, 2 AS rank_ FROM health_icici_payments WHERE transaction_id = ?
       UNION ALL
       SELECT purchase_id, 3 AS rank_ FROM health_icici_kyc WHERE kyc_transaction_id = ?
     ) found ORDER BY rank_ LIMIT 1`,
    [transactionId, transactionId, transactionId]
  );
  return row?.purchase_id ?? null;
}

/** The TransactionId a purchase is already tied to, if any (to refuse a mismatched X-Purchase-Id). */
export async function transactionOfPurchase(run, purchaseId) {
  const row = await run.queryOne(
    `SELECT transaction_id FROM (
       SELECT transaction_id, 1 AS rank_ FROM health_icici_proposals WHERE purchase_id = ?
       UNION ALL
       SELECT kyc_transaction_id AS transaction_id, 2 AS rank_ FROM health_icici_kyc
        WHERE purchase_id = ? AND kyc_transaction_id IS NOT NULL
     ) found ORDER BY rank_ LIMIT 1`,
    [purchaseId, purchaseId]
  );
  return row?.transaction_id ?? null;
}

// ── health_icici_proposals ──────────────────────────────────────────────────

export async function findProposal(run, purchaseId) {
  return run.queryOne(
    `SELECT id, purchase_id, transaction_id, proposal_id, total_premium, gst, policy_start_date, policy_end_date, status
     FROM health_icici_proposals WHERE purchase_id = ?`,
    [purchaseId]
  );
}

/** One proposal row per purchase: created on the first proposal, updated by a resubmission. */
export async function saveProposal(run, purchaseId, columns) {
  const existing = await findProposal(run, purchaseId);
  if (existing) {
    const { sql, params } = setClause(columns, { keepExisting: true });
    if (sql) await run.query(`UPDATE health_icici_proposals SET ${sql} WHERE id = ?`, [...params, existing.id]);
    return existing.id;
  }
  const { sql, params } = insertSql('health_icici_proposals', { purchase_id: purchaseId, ...columns });
  return run.insert(sql, params);
}

// ── health_icici_kyc ────────────────────────────────────────────────────────

export async function insertKyc(run, columns) {
  const { sql, params } = insertSql('health_icici_kyc', columns);
  return run.insert(sql, params);
}

// ── health_icici_payments ───────────────────────────────────────────────────

export async function findIciciPayment(run, transactionId, { forUpdate = false } = {}) {
  return run.queryOne(
    `SELECT id, purchase_id, health_payment_id, transaction_id, icici_payment_status, poll_count
     FROM health_icici_payments WHERE transaction_id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [transactionId]
  );
}

export async function insertIciciPayment(run, columns) {
  const { sql, params } = insertSql('health_icici_payments', columns);
  return run.insert(sql, params);
}

export async function recordPoll(run, id, paymentStatus) {
  await run.query(
    `UPDATE health_icici_payments
        SET icici_payment_status = COALESCE(?, icici_payment_status),
            poll_count = poll_count + 1,
            last_polled_at = CURRENT_TIMESTAMP(3)
      WHERE id = ?`,
    [paymentStatus ?? null, id]
  );
}

// ── health_icici_policies ───────────────────────────────────────────────────

export async function findPolicy(run, purchaseId) {
  return run.queryOne(
    `SELECT id, purchase_id, policy_no, policy_status, status, document_id
     FROM health_icici_policies WHERE purchase_id = ?`,
    [purchaseId]
  );
}

/** One policy row per purchase. Values given replace; NULLs keep. */
export async function savePolicy(run, purchaseId, columns) {
  const existing = await findPolicy(run, purchaseId);
  if (existing) {
    const { sql, params } = setClause(columns, { keepExisting: true });
    if (sql) await run.query(`UPDATE health_icici_policies SET ${sql} WHERE id = ?`, [...params, existing.id]);
    return existing.id;
  }
  const { sql, params } = insertSql('health_icici_policies', { purchase_id: purchaseId, ...columns });
  return run.insert(sql, params);
}
