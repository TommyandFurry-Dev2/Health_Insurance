import db from '../db/index.js';
import { clamp } from '../utils/sanitize.js';
import { KYC_STATUS } from '../constants/journey.constants.js';

const SELECT_COLUMNS = `
  id, journey_id, status, method, ckyc_number, pan_number, document_type,
  document_number, reference_id, attempt_count, rejection_reason,
  request_payload, response_payload, verified_at,
  created_at, updated_at, deleted_at
`;

// One KYC row per journey (UNIQUE on journey_id). No NivaBupa KYC endpoint
// exists in the current API kit, so nothing here calls a provider — this
// persists the outcome of whichever provider gets wired in, so a buyer who
// breaks after verifying is not sent through KYC a second time.
async function findOrCreate(journeyId, connection = null) {
  const run = db.runner(connection);

  const existing = await run.queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_kyc WHERE journey_id = ? AND deleted_at IS NULL`,
    [journeyId]
  );
  if (existing) return existing;

  const id = await run.insert(
    'INSERT INTO nivabupa_journey_kyc (journey_id, status) VALUES (?, ?)',
    [journeyId, KYC_STATUS.NOT_STARTED]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_kyc WHERE id = ?`, [id]);
}

async function findByJourneyId(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_kyc WHERE journey_id = ? AND deleted_at IS NULL`,
    [journeyId]
  );
}

// attempt_count increments only on a genuine new attempt (a PENDING/IN_PROGRESS
// submission), not on every status write — otherwise a provider webhook that
// reports the same attempt twice would inflate the count and trip a retry cap.
const STARTS_ATTEMPT = [KYC_STATUS.PENDING, KYC_STATUS.IN_PROGRESS];

async function saveStatus(journeyId, details = {}, connection = null) {
  const run = db.runner(connection);
  const row = await findOrCreate(journeyId, connection);
  const incrementAttempt = details.status && STARTS_ATTEMPT.includes(details.status);

  await run.query(
    `UPDATE nivabupa_journey_kyc SET
       status           = COALESCE(?, status),
       method           = COALESCE(?, method),
       ckyc_number      = COALESCE(?, ckyc_number),
       pan_number       = COALESCE(?, pan_number),
       document_type    = COALESCE(?, document_type),
       document_number  = COALESCE(?, document_number),
       reference_id     = COALESCE(?, reference_id),
       rejection_reason = ${details.status === KYC_STATUS.REJECTED ? '?' : 'rejection_reason'},
       request_payload  = COALESCE(?, request_payload),
       response_payload = COALESCE(?, response_payload),
       attempt_count    = attempt_count + ?,
       verified_at      = ${details.status === KYC_STATUS.VERIFIED ? 'NOW()' : 'verified_at'}
     WHERE id = ?`,
    [
      details.status || null,
      details.method || null,
      clamp(details.ckycNumber, 30) || null,
      clamp(details.panNumber, 20) || null,
      clamp(details.documentType, 40) || null,
      clamp(details.documentNumber, 60) || null,
      clamp(details.referenceId, 100) || null,
      ...(details.status === KYC_STATUS.REJECTED
        ? [details.rejectionReason ? String(details.rejectionReason).slice(0, 65535) : null]
        : []),
      db.toJson(details.requestPayload),
      db.toJson(details.responsePayload),
      incrementAttempt ? 1 : 0,
      row.id,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_kyc WHERE id = ?`, [row.id]);
}

async function softDelete(journeyId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journey_kyc SET deleted_at = NOW() WHERE journey_id = ? AND deleted_at IS NULL',
    [journeyId]
  );
}

export {
  findOrCreate,
  findByJourneyId,
  saveStatus,
  softDelete,
};
