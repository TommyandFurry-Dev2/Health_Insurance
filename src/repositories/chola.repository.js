import db from '../db/index.js';

// ─────────────────────────────────────────────────────────────────────────────
// The two Chola MS tables (migrations/005) — the working implementation's
// chola.repository.js, with its SQL unchanged.
//
//   health_chola_policy_generation_logs  one row per PolicyGeneration request
//                                        actually sent, website and ops alike,
//                                        request and response exactly as they
//                                        crossed the wire. The evidence shared
//                                        with Chola MS.
//   health_chola_proposals               one row per proposal the BACKEND has
//                                        tagged payment for, and what came of it.
//                                        Its UNIQUE key is what refuses a second
//                                        PolicyGeneration for one proposal.
//
// The table names are the working implementation's, on purpose: when this
// service shares its schema with that one, a proposal it already claimed stays
// claimed here, and PolicyGeneration is still never sent twice.
//
// The PDF column is never selected by a listing — only findPolicyPdf reads it —
// so a page of proposals stays a page of text however many documents are held.
//
// Unlike log.repository.js, NOTHING here swallows its own errors. The claim
// in particular must fail closed: if it cannot be written, PolicyGeneration is
// not sent (see services/cholaPolicyIssuer.service.js).
// ─────────────────────────────────────────────────────────────────────────────

const PROPOSAL_COLUMNS = `
  id, gencon_proposal_number, product, payment_mode, amount, status,
  gencon_policy_number, payment_url, error_message, schedule_url, cis_url,
  policy_pdf IS NOT NULL AS has_policy_pdf, policy_pdf_error, created_at, updated_at`;

const LOG_COLUMNS = `
  id, created_at, source, product, payment_mode, tagging_mode, pay_mode,
  gencon_proposal_number, request_url, request_headers, request_body,
  http_status, response_body, error_code, error_message, correlation_id, duration_ms`;

// Rows changed, for an UPDATE where "did anything match?" is the answer wanted.
// affectedRows (not changedRows): writing the same values back is still a
// successful update of an existing row. src/db's runner has no such helper, and
// this is the only caller that needs one.
async function update(sql, params = []) {
  const [result] = await db.getPool().execute(sql, params);
  return result.affectedRows;
}

// ── health_chola_policy_generation_logs ────────────────────────────────────

async function insertPolicyGenerationLog(entry) {
  return db.insert(
    `INSERT INTO health_chola_policy_generation_logs
       (created_at, source, product, payment_mode, tagging_mode, pay_mode,
        gencon_proposal_number, request_url, request_headers, request_body,
        http_status, response_body, error_code, error_message, correlation_id, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.at, entry.source, entry.product, entry.paymentMode ?? null,
      entry.taggingMode ?? null, entry.payMode ?? null, entry.genconProposalNumber ?? null,
      entry.url, JSON.stringify(entry.requestHeaders), entry.requestBody,
      entry.httpStatus ?? null, entry.responseBody ?? null,
      entry.error?.code ?? null, entry.error?.message ?? null,
      entry.correlationId ?? null, entry.durationMs ?? null,
    ]
  );
}

async function listPolicyGenerationLogs({ genconProposalNumber, limit = 50 } = {}) {
  const n = clampLimit(limit);
  if (genconProposalNumber) {
    return db.query(
      `SELECT ${LOG_COLUMNS} FROM health_chola_policy_generation_logs
        WHERE gencon_proposal_number = ? ORDER BY id DESC LIMIT ${n}`,
      [String(genconProposalNumber)]
    );
  }
  return db.query(
    `SELECT ${LOG_COLUMNS} FROM health_chola_policy_generation_logs ORDER BY id DESC LIMIT ${n}`
  );
}

// ── health_chola_proposals ─────────────────────────────────────────────────

/**
 * Take the right to send PolicyGeneration for a proposal. Called BEFORE the
 * request goes out.
 *
 * A proposal never seen before is inserted as POLICY_GENERATION_SENT. One that
 * exists may be re-attempted only from PAYMENT_FAILED, and the conditional
 * UPDATE means two concurrent attempts cannot both win. Anything else — sent,
 * issued, pending, or of unknown outcome — is refused and returned.
 *
 * @returns {Promise<{claimed: true, reattempt: boolean} | {claimed: false, existing: object}>}
 */
async function claimForPolicyGeneration({
  genconProposalNumber, product, paymentMode, amount,
}) {
  const no = String(genconProposalNumber);
  try {
    await db.insert(
      `INSERT INTO health_chola_proposals
         (gencon_proposal_number, product, payment_mode, amount, status)
       VALUES (?, ?, ?, ?, 'POLICY_GENERATION_SENT')`,
      [no, product, paymentMode, amount]
    );
    return { claimed: true, reattempt: false };
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
  }
  const changed = await update(
    `UPDATE health_chola_proposals
        SET status = 'POLICY_GENERATION_SENT', product = ?, payment_mode = ?, amount = ?,
            error_message = NULL
      WHERE gencon_proposal_number = ? AND status = 'PAYMENT_FAILED'`,
    [product, paymentMode, amount, no]
  );
  if (changed === 1) return { claimed: true, reattempt: true };
  return { claimed: false, existing: await findProposal(no) };
}

async function recordOutcome(genconProposalNumber, {
  status, genconPolicyNumber = null, paymentUrl = null, errorMessage = null,
}) {
  return update(
    `UPDATE health_chola_proposals
        SET status = ?, gencon_policy_number = ?, payment_url = ?, error_message = ?
      WHERE gencon_proposal_number = ?`,
    [status, genconPolicyNumber, paymentUrl, errorMessage, String(genconProposalNumber)]
  );
}

async function recordSchedule(genconProposalNumber, {
  scheduleUrl = null, cisUrl = null, pdf = null, pdfError = null,
}) {
  return update(
    `UPDATE health_chola_proposals
        SET schedule_url = ?, cis_url = ?, policy_pdf = ?, policy_pdf_error = ?
      WHERE gencon_proposal_number = ?`,
    [scheduleUrl, cisUrl, pdf, pdfError, String(genconProposalNumber)]
  );
}

async function findProposal(genconProposalNumber) {
  return db.queryOne(
    `SELECT ${PROPOSAL_COLUMNS} FROM health_chola_proposals WHERE gencon_proposal_number = ? LIMIT 1`,
    [String(genconProposalNumber)]
  );
}

async function listProposals({ limit = 50 } = {}) {
  return db.query(
    `SELECT ${PROPOSAL_COLUMNS} FROM health_chola_proposals ORDER BY updated_at DESC, id DESC LIMIT ${clampLimit(limit)}`
  );
}

async function findPolicyPdf(genconProposalNumber) {
  const row = await db.queryOne(
    `SELECT gencon_policy_number, policy_pdf FROM health_chola_proposals
      WHERE gencon_proposal_number = ? LIMIT 1`,
    [String(genconProposalNumber)]
  );
  return row && row.policy_pdf ? row : null;
}

// Interpolated into LIMIT rather than bound: mysql2's execute() rejects a bound
// LIMIT on some server versions. Safe because it is always an integer here.
function clampLimit(limit) {
  const n = parseInt(limit, 10);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 500) : 50;
}

export {
  insertPolicyGenerationLog,
  listPolicyGenerationLogs,
  claimForPolicyGeneration,
  recordOutcome,
  recordSchedule,
  findProposal,
  listProposals,
  findPolicyPdf,
};
