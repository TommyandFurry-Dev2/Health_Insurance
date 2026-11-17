import db from '../db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// health_chola_freecharge_payments (migrations/007) — one row per Freecharge
// checkout for a Chola proposal. See services/cholaFreechargePayment.service.js.
//
// Like chola.repository.js, NOTHING here swallows its own errors: the row is
// written before the buyer is sent to pay, and a checkout whose row cannot be
// written is not started.
//
// The large columns (raw callback, decrypted callback, status and refund
// answers) are selected only by findDetail, so a listing stays small.
// ─────────────────────────────────────────────────────────────────────────────

const COLUMNS = `
  id, merchant_txn_id, return_token, gencon_proposal_number, product, amount, currency,
  status, status_code, status_message, txn_reference_id, paid_amount, txn_mode, txn_sub_mode,
  frontend_return_url, callback_count, last_checked_at, issue_status, gencon_policy_number,
  issue_message, refund_txn_id, refund_status_code, refund_status_message, created_at, updated_at`;

const DETAIL_COLUMNS = `${COLUMNS}, callback_body, callback_decrypted, status_response, refund_response`;

// Rows changed: "did the conditional UPDATE match?" is the answer wanted.
async function update(sql, params = []) {
  const [result] = await db.getPool().execute(sql, params);
  return result.affectedRows;
}

const asText = (value) => (value === undefined || value === null ? null
  : typeof value === 'string' ? value : JSON.stringify(value));

async function insertPayment({
  merchantTxnId, returnToken, genconProposalNumber, product, amount, currency, frontendReturnUrl, status,
}) {
  return db.insert(
    `INSERT INTO health_chola_freecharge_payments
       (merchant_txn_id, return_token, gencon_proposal_number, product, amount, currency,
        frontend_return_url, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [merchantTxnId, returnToken, String(genconProposalNumber), product, amount, currency, frontendReturnUrl ?? null, status]
  );
}

async function findByMerchantTxnId(merchantTxnId) {
  return db.queryOne(
    `SELECT ${COLUMNS} FROM health_chola_freecharge_payments WHERE merchant_txn_id = ? LIMIT 1`,
    [String(merchantTxnId)]
  );
}

async function findByToken(returnToken) {
  return db.queryOne(
    `SELECT ${COLUMNS} FROM health_chola_freecharge_payments WHERE return_token = ? LIMIT 1`,
    [String(returnToken)]
  );
}

async function findDetail(merchantTxnId) {
  return db.queryOne(
    `SELECT ${DETAIL_COLUMNS} FROM health_chola_freecharge_payments WHERE merchant_txn_id = ? LIMIT 1`,
    [String(merchantTxnId)]
  );
}

async function listForProposal(genconProposalNumber) {
  return db.query(
    `SELECT ${COLUMNS} FROM health_chola_freecharge_payments
      WHERE gencon_proposal_number = ? ORDER BY id ASC`,
    [String(genconProposalNumber)]
  );
}

async function listPayments({ limit = 50 } = {}) {
  return db.query(
    `SELECT ${COLUMNS} FROM health_chola_freecharge_payments ORDER BY updated_at DESC, id DESC LIMIT ${clampLimit(limit)}`
  );
}

async function recordCallback(merchantTxnId, { body, decrypted }) {
  return update(
    `UPDATE health_chola_freecharge_payments
        SET callback_count = callback_count + 1, callback_body = ?, callback_decrypted = ?
      WHERE merchant_txn_id = ?`,
    [asText(body), asText(decrypted), String(merchantTxnId)]
  );
}

/** What a status check (or a failed checkout start) concluded. Unset fields keep their value. */
async function recordVerification(merchantTxnId, {
  status, statusCode = null, statusMessage = null, txnReferenceId = null, paidAmount = null,
  txnMode = null, txnSubMode = null, statusResponse = null,
}) {
  return update(
    `UPDATE health_chola_freecharge_payments
        SET status = ?, status_code = ?, status_message = ?,
            txn_reference_id = COALESCE(?, txn_reference_id), paid_amount = COALESCE(?, paid_amount),
            txn_mode = COALESCE(?, txn_mode), txn_sub_mode = COALESCE(?, txn_sub_mode),
            status_response = COALESCE(?, status_response), last_checked_at = CURRENT_TIMESTAMP(3)
      WHERE merchant_txn_id = ?`,
    [
      status, statusCode, statusMessage ? String(statusMessage).slice(0, 1000) : null,
      txnReferenceId, paidAmount, txnMode, txnSubMode, asText(statusResponse), String(merchantTxnId),
    ]
  );
}

/**
 * Take the right to send PolicyGeneration for a paid checkout: only from
 * SUCCESS with nothing tried yet — or, when `retry` (an operator's deliberate
 * re-send), from ISSUE_FAILED. Two concurrent callers cannot both win.
 */
async function claimIssue(merchantTxnId, { retry = false } = {}) {
  const changed = await update(
    `UPDATE health_chola_freecharge_payments
        SET issue_status = 'IN_PROGRESS', issue_message = NULL
      WHERE merchant_txn_id = ? AND status = 'SUCCESS'
        AND (issue_status IS NULL${retry ? " OR issue_status = 'ISSUE_FAILED'" : ''})`,
    [String(merchantTxnId)]
  );
  return changed === 1;
}

async function recordIssue(merchantTxnId, { issueStatus, policyNumber = null, message = null }) {
  return update(
    `UPDATE health_chola_freecharge_payments
        SET issue_status = ?, gencon_policy_number = COALESCE(?, gencon_policy_number), issue_message = ?
      WHERE merchant_txn_id = ?`,
    [issueStatus, policyNumber, message, String(merchantTxnId)]
  );
}

async function recordRefund(merchantTxnId, {
  refundTxnId, statusCode = null, statusMessage = null, response = null,
}) {
  return update(
    `UPDATE health_chola_freecharge_payments
        SET refund_txn_id = ?, refund_status_code = ?, refund_status_message = ?, refund_response = ?
      WHERE merchant_txn_id = ?`,
    [refundTxnId, statusCode, statusMessage ? String(statusMessage).slice(0, 1000) : null, asText(response), String(merchantTxnId)]
  );
}

// Interpolated into LIMIT rather than bound, as chola.repository.js does:
// mysql2's execute() rejects a bound LIMIT on some server versions.
function clampLimit(limit) {
  const n = parseInt(limit, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

export {
  insertPayment,
  findByMerchantTxnId,
  findByToken,
  findDetail,
  listForProposal,
  listPayments,
  recordCallback,
  recordVerification,
  claimIssue,
  recordIssue,
  recordRefund,
};
