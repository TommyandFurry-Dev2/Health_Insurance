import db from '../db/index.js';
import config from '../config/env.js';
import { newUuid, newResumeToken, clamp } from '../utils/sanitize.js';
import {
  JOURNEY_STEPS,
  JOURNEY_STATUS,
  RESUMABLE_STATUSES,
  isStepAfter,
} from '../constants/journey.constants.js';

const SELECT_COLUMNS = `
  id, uuid, user_id, resume_token, current_step, last_completed_step, status,
  insurer_code, insurer_name, product_code, product_variant, selected_quote_id,
  channel, subchannel, sourcing_system, agent_id, step_data, resume_count,
  last_activity_at, expires_at, completed_at, abandoned_at,
  created_at, updated_at, deleted_at
`;

async function create(userId, details = {}, connection = null) {
  const run = db.runner(connection);
  const uuid = newUuid();
  const resumeToken = newResumeToken();

  await run.insert(
    `INSERT INTO nivabupa_journeys (
       uuid, user_id, resume_token, current_step, status,
       insurer_code, insurer_name, product_code, product_variant,
       channel, subchannel, sourcing_system, agent_id, step_data,
       last_activity_at, expires_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), DATE_ADD(NOW(), INTERVAL ? DAY))`,
    [
      uuid,
      userId,
      resumeToken,
      JOURNEY_STEPS.JOURNEY_STARTED,
      JOURNEY_STATUS.IN_PROGRESS,
      clamp(details.insurerCode, 50) || 'NIVA_BUPA',
      clamp(details.insurerName, 100) || 'Niva Bupa Health Insurance',
      clamp(details.productCode, 50) || 'REASSURE30',
      clamp(details.productVariant, 50) || null,
      clamp(details.channel, 50) || null,
      clamp(details.subchannel, 50) || null,
      clamp(details.sourcingSystem, 50) || null,
      clamp(details.agentId, 50) || null,
      db.toJson(details.stepData),
      config.journey.ttlDays,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE uuid = ?`, [uuid]);
}

async function findByUuid(uuid, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE uuid = ? AND deleted_at IS NULL LIMIT 1`,
    [uuid]
  );
}

async function findById(id, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    [id]
  );
}

// Resume by token. The status/expiry filters live in SQL rather than in the
// caller so there is exactly one definition of "resumable" and no code path can
// hand back an expired journey by forgetting a check.
async function findResumableByToken(resumeToken, connection = null) {
  const placeholders = RESUMABLE_STATUSES.map(() => '?').join(', ');
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys
     WHERE resume_token = ?
       AND deleted_at IS NULL
       AND status IN (${placeholders})
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [resumeToken, ...RESUMABLE_STATUSES]
  );
}

// Used on login: the buyer authenticates with their mobile and gets their
// unfinished journeys back without needing to have kept the resume token.
// Ordered by activity so the SPA can offer "continue where you left off"
// against the most recent one.
async function findResumableByUserId(userId, { limit = 10, connection = null } = {}) {
  const placeholders = RESUMABLE_STATUSES.map(() => '?').join(', ');
  return db.runner(connection).query(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys
     WHERE user_id = ?
       AND deleted_at IS NULL
       AND status IN (${placeholders})
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY last_activity_at DESC
     LIMIT ?`,
    [userId, ...RESUMABLE_STATUSES, Number(limit)]
  );
}

async function findAllByUserId(userId, { limit = 50, connection = null } = {}) {
  return db.runner(connection).query(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys
     WHERE user_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT ?`,
    [userId, Number(limit)]
  );
}

// Advances the journey pointer. current_step always moves to wherever the
// buyer now is; last_completed_step only ever moves forward, guarded by
// isStepAfter — otherwise a buyer who navigates back to the quote screen after
// submitting a proposal would have their restore point dragged backwards and
// lose the proposal on the next resume.
async function advanceStep(journeyId, step, { connection = null, force = false } = {}) {
  const run = db.runner(connection);
  const journey = await run.queryOne(
    'SELECT id, current_step, last_completed_step FROM nivabupa_journeys WHERE id = ? AND deleted_at IS NULL',
    [journeyId]
  );
  if (!journey) return null;

  const advance = force || isStepAfter(step, journey.last_completed_step);

  await run.query(
    `UPDATE nivabupa_journeys SET
       current_step        = ?,
       last_completed_step = ${advance ? '?' : 'last_completed_step'},
       last_activity_at    = NOW()
     WHERE id = ?`,
    advance ? [step, step, journeyId] : [step, journeyId]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ?`, [journeyId]);
}

// Only the columns the journey row itself owns. Quote/proposal/payment data
// goes through its own repository — this deliberately cannot write them, so
// there is no path by which the spine and the detail tables disagree.
const PATCHABLE = {
  productVariant: 'product_variant',
  productCode: 'product_code',
  insurerCode: 'insurer_code',
  insurerName: 'insurer_name',
  selectedQuoteId: 'selected_quote_id',
  channel: 'channel',
  subchannel: 'subchannel',
  sourcingSystem: 'sourcing_system',
  agentId: 'agent_id',
};

async function patch(journeyId, fields = {}, connection = null) {
  const run = db.runner(connection);
  const assignments = [];
  const params = [];

  for (const [key, column] of Object.entries(PATCHABLE)) {
    if (fields[key] !== undefined) {
      assignments.push(`${column} = ?`);
      params.push(fields[key] === '' ? null : fields[key]);
    }
  }

  // step_data is merged, not replaced: the SPA saves one screen at a time and
  // a whole-object PUT from the members form would wipe the proposer draft.
  // JSON_MERGE_PATCH also deletes a key when the incoming value is null, which
  // is how the frontend clears a field.
  if (fields.stepData !== undefined) {
    assignments.push('step_data = JSON_MERGE_PATCH(COALESCE(step_data, JSON_OBJECT()), ?)');
    params.push(db.toJson(fields.stepData) || '{}');
  }

  if (assignments.length === 0) {
    return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ?`, [journeyId]);
  }

  assignments.push('last_activity_at = NOW()');
  params.push(journeyId);

  await run.query(
    `UPDATE nivabupa_journeys SET ${assignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
    params
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ?`, [journeyId]);
}

async function touch(journeyId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journeys SET last_activity_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [journeyId]
  );
}

// Extends expiry on resume as well as counting it: a buyer who comes back on
// day 6 should get a fresh window, not be cut off on day 7 mid-payment.
async function markResumed(journeyId, connection = null) {
  const run = db.runner(connection);
  await run.query(
    `UPDATE nivabupa_journeys SET
       resume_count     = resume_count + 1,
       status           = IF(status = ?, ?, status),
       abandoned_at     = IF(status = ?, NULL, abandoned_at),
       last_activity_at = NOW(),
       expires_at       = DATE_ADD(NOW(), INTERVAL ? DAY)
     WHERE id = ? AND deleted_at IS NULL`,
    [
      JOURNEY_STATUS.ABANDONED, JOURNEY_STATUS.IN_PROGRESS,
      JOURNEY_STATUS.ABANDONED,
      config.journey.ttlDays,
      journeyId,
    ]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ?`, [journeyId]);
}

async function setStatus(journeyId, status, connection = null) {
  const run = db.runner(connection);
  await run.query(
    `UPDATE nivabupa_journeys SET
       status       = ?,
       completed_at = IF(? = ?, NOW(), completed_at),
       abandoned_at = IF(? = ?, NOW(), abandoned_at)
     WHERE id = ? AND deleted_at IS NULL`,
    [
      status,
      status, JOURNEY_STATUS.COMPLETED,
      status, JOURNEY_STATUS.ABANDONED,
      journeyId,
    ]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journeys WHERE id = ?`, [journeyId]);
}

// Rotates the resume token. Called after a journey completes so a token left
// in a browser history or an emailed resume link cannot be replayed against a
// finished purchase.
async function rotateResumeToken(journeyId, connection = null) {
  const token = newResumeToken();
  await db.runner(connection).query(
    'UPDATE nivabupa_journeys SET resume_token = ? WHERE id = ?',
    [token, journeyId]
  );
  return token;
}

// Two-stage sweeper, run on an interval from startNivabupa() in src/index.js. Idle
// journeys become ABANDONED (still resumable — this is the journey-break
// population, and marking them is what makes the funnel measurable); journeys
// past expires_at become EXPIRED and terminal.
async function sweepStale(connection = null) {
  const run = db.runner(connection);

  const abandoned = await run.query(
    `UPDATE nivabupa_journeys SET status = ?, abandoned_at = NOW()
     WHERE status = ?
       AND deleted_at IS NULL
       AND last_activity_at < DATE_SUB(NOW(), INTERVAL ? HOUR)`,
    [JOURNEY_STATUS.ABANDONED, JOURNEY_STATUS.IN_PROGRESS, config.journey.abandonAfterHours]
  );

  const expired = await run.query(
    `UPDATE nivabupa_journeys SET status = ?
     WHERE status IN (?, ?)
       AND deleted_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`,
    [JOURNEY_STATUS.EXPIRED, JOURNEY_STATUS.IN_PROGRESS, JOURNEY_STATUS.ABANDONED]
  );

  return {
    abandoned: abandoned.affectedRows || 0,
    expired: expired.affectedRows || 0,
  };
}

async function softDelete(journeyId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journeys SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [journeyId]
  );
}

export {
  create,
  findById,
  findByUuid,
  findResumableByToken,
  findResumableByUserId,
  findAllByUserId,
  advanceStep,
  patch,
  touch,
  markResumed,
  setStatus,
  rotateResumeToken,
  sweepStale,
  softDelete,
};
