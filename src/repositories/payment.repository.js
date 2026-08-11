import db from '../db/index.js';
import { newUuid, toDecimal, clamp } from '../utils/sanitize.js';
import { PAYMENT_STATUS } from '../constants/journey.constants.js';

const SELECT_COLUMNS = `
  id, uuid, journey_id, proposal_id, attempt_no, unq_policy_number, status,
  premium_value, payment_type, is_juspay, channel, subchannel, sourcing_system,
  product_name, policy_number_if_renewal, mobile, email, agent_id, sum_insured,
  tenure, zone, other_param, additional_comment, return_path,
  plaintext_querystring, encparam, gateway_url,
  payment_status_code, payment_status_description, payment_transaction_id,
  unique_reference_id, unique_reference_no_repeat, payable_premium,
  transaction_date_time, failed_reason, standing_instruction_taken,
  standing_instruction_no, payment_gateway_used, decrypted_return_message,
  raw_callback_body, initiated_at, callback_received_at,
  created_at, updated_at, deleted_at
`;

// attempt_no is unique per journey, so a retried payment gets the next number
// and a double-submitted initiate cannot produce two rows claiming the same
// attempt (the unique key rejects the second).
async function nextAttemptNo(journeyId, connection = null) {
  const row = await db.runner(connection).queryOne(
    'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM nivabupa_journey_payments WHERE journey_id = ?',
    [journeyId]
  );
  return row ? Number(row.next) : 1;
}

async function createAttempt(
  { journeyId, proposalId, body, querystring, encparam, gatewayUrl },
  connection = null
) {
  const run = db.runner(connection);
  const uuid = newUuid();
  const attemptNo = await nextAttemptNo(journeyId, connection);

  const id = await run.insert(
    `INSERT INTO nivabupa_journey_payments (
       uuid, journey_id, proposal_id, attempt_no, unq_policy_number, status,
       premium_value, payment_type, is_juspay, channel, subchannel, sourcing_system,
       product_name, policy_number_if_renewal, mobile, email, agent_id, sum_insured,
       tenure, zone, other_param, additional_comment, return_path,
       plaintext_querystring, encparam, gateway_url, initiated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      uuid,
      journeyId,
      proposalId || null,
      attemptNo,
      clamp(body.unqPolicyNumber, 80),
      PAYMENT_STATUS.INITIATED,
      toDecimal(body.premiumValue) ?? 0,
      clamp(body.paymentType, 60) || null,
      clamp(body.isjuspay, 10) || null,
      clamp(body.channel, 50) || null,
      clamp(body.subchannel, 50) || null,
      clamp(body.sourcingsystem, 50) || null,
      clamp(body.productname, 100) || null,
      clamp(body.policynumber, 80) || null,
      clamp(body.mobile, 15) || null,
      clamp(body.email, 255) || null,
      clamp(body.agentid, 50) || null,
      toDecimal(body.suminsured),
      clamp(body.tenure, 10) || null,
      clamp(body.zone, 20) || null,
      clamp(body.otherParam, 255) || null,
      clamp(body.additionalComment, 255) || null,
      clamp(body.returnPath, 500) || null,
      querystring || null,
      encparam || null,
      clamp(gatewayUrl, 500) || null,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments WHERE id = ?`, [id]);
}

// THE resume linchpin.
//
// NivaBupa's gateway POSTs /nivabupa/payment/return from its own servers with
// nothing but an encrypted returnMessage — no cookie, no session, no journey
// id. The decrypted message echoes back the unqPolicyNumber we generated at
// initiate time as uniqueReferenceId, so that value is the only link from a
// payment outcome to a journey. Without this row the buyer's journey is
// unrecoverable after a break at payment, which is exactly the case that
// matters most (money has moved).
//
// unique_reference_no_repeat is tried as a fallback because the pipe format
// carries the reference twice and a gateway that blanks field[1] on some
// failure paths still populates field[4].
async function findByCorrelation({ uniqueReferenceId, uniqueReferenceNoRepeat }, connection = null) {
  const run = db.runner(connection);

  if (uniqueReferenceId) {
    const byPrimary = await run.queryOne(
      `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments
       WHERE unq_policy_number = ? AND deleted_at IS NULL
       ORDER BY id DESC LIMIT 1`,
      [uniqueReferenceId]
    );
    if (byPrimary) return byPrimary;
  }

  if (uniqueReferenceNoRepeat) {
    return run.queryOne(
      `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments
       WHERE unq_policy_number = ? OR unique_reference_no_repeat = ?
       ORDER BY id DESC LIMIT 1`,
      [uniqueReferenceNoRepeat, uniqueReferenceNoRepeat]
    );
  }

  return null;
}

// Maps the parsed returnMessage onto the payments row. parseReturnMessage()
// already derives paymentStatusDescription from the M001 success code, so the
// ENUM follows that rather than re-deriving it here.
async function saveCallbackResult(
  paymentId,
  { parsed, decrypted, rawBody },
  connection = null
) {
  const run = db.runner(connection);
  const status = parsed.paymentStatusDescription === 'SUCCESS'
    ? PAYMENT_STATUS.SUCCESS
    : PAYMENT_STATUS.FAILED;

  await run.query(
    `UPDATE nivabupa_journey_payments SET
       status                     = ?,
       payment_status_code        = ?,
       payment_status_description = ?,
       payment_transaction_id     = ?,
       unique_reference_id        = ?,
       unique_reference_no_repeat = ?,
       payable_premium            = ?,
       transaction_date_time      = ?,
       failed_reason              = ?,
       standing_instruction_taken = ?,
       standing_instruction_no    = ?,
       payment_gateway_used       = ?,
       decrypted_return_message   = ?,
       raw_callback_body          = ?,
       callback_received_at       = NOW()
     WHERE id = ?`,
    [
      status,
      clamp(parsed.paymentStatus, 20),
      clamp(parsed.paymentStatusDescription, 40),
      clamp(parsed.paymentTransactionId, 100),
      clamp(parsed.uniqueReferenceId, 80),
      clamp(parsed.uniqueReferenceNoRepeat, 80),
      toDecimal(parsed.payablePremium),
      clamp(parsed.transactionDateTime, 50),
      parsed.failedReason ? String(parsed.failedReason).slice(0, 65535) : null,
      clamp(parsed.standingInstructionTaken, 10),
      clamp(parsed.standingInstructionNo, 60),
      clamp(parsed.paymentGatewayUsed, 60),
      decrypted || null,
      db.toJson(rawBody) || 'null',
      paymentId,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments WHERE id = ?`, [paymentId]);
}

// Recorded even when the callback cannot be decrypted or matched. A payment
// stuck at INITIATED with no callback row is indistinguishable from one whose
// callback arrived and failed to process — and only the second case means money
// may have moved without the journey knowing.
async function markCallbackError(paymentId, { message, rawBody }, connection = null) {
  await db.runner(connection).query(
    `UPDATE nivabupa_journey_payments SET
       status               = ?,
       failed_reason        = ?,
       raw_callback_body    = ?,
       callback_received_at = NOW()
     WHERE id = ?`,
    [
      PAYMENT_STATUS.ERROR,
      message ? String(message).slice(0, 65535) : null,
      db.toJson(rawBody) || 'null',
      paymentId,
    ]
  );
}

async function findById(paymentId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments WHERE id = ? AND deleted_at IS NULL`,
    [paymentId]
  );
}

async function findLatestByJourney(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments
     WHERE journey_id = ? AND deleted_at IS NULL
     ORDER BY attempt_no DESC LIMIT 1`,
    [journeyId]
  );
}

async function findSuccessfulByJourney(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments
     WHERE journey_id = ? AND status = ? AND deleted_at IS NULL
     ORDER BY attempt_no DESC LIMIT 1`,
    [journeyId, PAYMENT_STATUS.SUCCESS]
  );
}

async function listByJourney(journeyId, connection = null) {
  return db.runner(connection).query(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_payments
     WHERE journey_id = ? AND deleted_at IS NULL ORDER BY attempt_no ASC`,
    [journeyId]
  );
}

async function softDelete(paymentId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journey_payments SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [paymentId]
  );
}

export {
  nextAttemptNo,
  createAttempt,
  findByCorrelation,
  saveCallbackResult,
  markCallbackError,
  findById,
  findLatestByJourney,
  findSuccessfulByJourney,
  listByJourney,
  softDelete,
};
