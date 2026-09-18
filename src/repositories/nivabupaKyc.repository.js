import db from '../db/index.js';
import { clamp } from '../utils/sanitize.js';

// nivabupa_kyc_requests — one row per NivaBupa CKYC OTP attempt (migration 003).

const SELECT_COLUMNS = `
  id, kyc_reference_id, application_no, journey_id, pan, mobile, ckyc_request_id,
  ckyc_transaction_id, status, ckyc_status, status_message, ckyc_number,
  verify_attempts, verified_response, verified_at, created_at, updated_at
`;

async function findByReferenceId(kycReferenceId) {
  return db.queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_kyc_requests WHERE kyc_reference_id = ?`,
    [kycReferenceId]
  );
}

// Written BEFORE the OTP is requested, so a database that cannot record the
// attempt stops it before an OTP reaches the buyer's phone.
async function createPending({ kycReferenceId, applicationNo, journeyId, pan, mobile }) {
  await db.query(
    `INSERT INTO nivabupa_kyc_requests (kyc_reference_id, application_no, journey_id, pan, mobile, status)
     VALUES (?, ?, ?, ?, ?, 'PENDING')`,
    [clamp(kycReferenceId, 40), clamp(applicationNo, 40), journeyId || null, clamp(pan, 10), clamp(mobile, 15)]
  );
}

async function markOtpSent(kycReferenceId, { requestId, transactionId, ckycStatus, message }) {
  await db.query(
    `UPDATE nivabupa_kyc_requests
        SET status = 'OTP_SENT', ckyc_request_id = ?, ckyc_transaction_id = ?, ckyc_status = ?, status_message = ?
      WHERE kyc_reference_id = ?`,
    [clamp(requestId, 40), clamp(transactionId, 40), clamp(ckycStatus, 60), clamp(message, 255), kycReferenceId]
  );
}

async function markFailed(kycReferenceId, { ckycStatus, message }) {
  await db.query(
    `UPDATE nivabupa_kyc_requests SET status = 'FAILED', ckyc_status = ?, status_message = ? WHERE kyc_reference_id = ?`,
    [clamp(ckycStatus, 60), clamp(message, 255), kycReferenceId]
  );
}

// Resend and a rejected OTP only update the message; the attempt stays open.
async function saveMessage(kycReferenceId, { ckycStatus, message, countAttempt = false }) {
  await db.query(
    `UPDATE nivabupa_kyc_requests
        SET ckyc_status = COALESCE(?, ckyc_status), status_message = ?,
            verify_attempts = verify_attempts + ?
      WHERE kyc_reference_id = ?`,
    [clamp(ckycStatus, 60), clamp(message, 255), countAttempt ? 1 : 0, kycReferenceId]
  );
}

async function markVerified(kycReferenceId, { ckycNumber, ckycStatus, message, response }) {
  await db.query(
    `UPDATE nivabupa_kyc_requests
        SET status = 'VERIFIED', ckyc_number = ?, ckyc_status = ?, status_message = ?,
            verified_response = ?, verified_at = NOW(), verify_attempts = verify_attempts + 1
      WHERE kyc_reference_id = ?`,
    [clamp(ckycNumber, 30), clamp(ckycStatus, 60), clamp(message, 255), db.toJson(response), kycReferenceId]
  );
  return findByReferenceId(kycReferenceId);
}

export { findByReferenceId, createPending, markOtpSent, markFailed, saveMessage, markVerified };
