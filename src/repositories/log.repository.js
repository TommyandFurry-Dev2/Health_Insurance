import db from '../db/index.js';
import { newUuid, forAudit, clamp } from '../utils/sanitize.js';
import { EVENT_TYPES } from '../constants/journey.constants.js';

// api_transactions + journey_events. Both are append-only, and both are written
// on paths that must not fail the caller: an audit write that throws would turn
// a successful NivaBupa premium call into a 500 for the buyer. Every function
// here swallows its own errors to the console and returns null.

async function recordApiTransaction(entry = {}, connection = null) {
  try {
    const uuid = newUuid();
    const id = await db.runner(connection).insert(
      `INSERT INTO nivabupa_api_transactions (
         uuid, journey_id, api_name, journey_step, direction, http_method,
         endpoint_url, status, http_status, duration_ms,
         request_payload, response_payload, error_code, error_message, correlation_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        uuid,
        entry.journeyId || null,
        clamp(entry.apiName, 60),
        clamp(entry.journeyStep, 40) || null,
        entry.direction || 'OUTBOUND',
        clamp(entry.httpMethod, 10) || 'POST',
        clamp(entry.endpointUrl, 500) || null,
        entry.status || 'SUCCESS',
        entry.httpStatus || null,
        entry.durationMs || null,
        // forAudit strips credentials and truncates base64 blobs — see
        // utils/sanitize.js. Partner secrets and policy PDFs must not land in
        // an append-only table that reporting jobs read.
        db.toJson(forAudit(entry.requestPayload)),
        db.toJson(forAudit(entry.responsePayload)),
        clamp(entry.errorCode, 60) || null,
        entry.errorMessage ? String(entry.errorMessage).slice(0, 65535) : null,
        clamp(entry.correlationId, 80) || null,
      ]
    );
    return id;
  } catch (error) {
    console.error('⚠️  api_transactions write failed (call itself unaffected):', error.message);
    return null;
  }
}

async function recordEvent(entry = {}, connection = null) {
  if (!entry.journeyId) return null;
  try {
    return await db.runner(connection).insert(
      `INSERT INTO nivabupa_journey_events (
         journey_id, event_type, from_step, to_step, message,
         error_code, error_message, error_stack, metadata, ip_address, user_agent
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.journeyId,
        entry.eventType || EVENT_TYPES.STEP_COMPLETED,
        clamp(entry.fromStep, 40) || null,
        clamp(entry.toStep, 40) || null,
        clamp(entry.message, 500) || null,
        clamp(entry.errorCode, 60) || null,
        entry.errorMessage ? String(entry.errorMessage).slice(0, 65535) : null,
        entry.errorStack ? String(entry.errorStack).slice(0, 65535) : null,
        db.toJson(forAudit(entry.metadata)),
        clamp(entry.ipAddress, 45) || null,
        clamp(entry.userAgent, 255) || null,
      ]
    );
  } catch (error) {
    console.error('⚠️  journey_events write failed (call itself unaffected):', error.message);
    return null;
  }
}

// Non-API failures (validation, a missing returnMessage, a decrypt parse
// failure) land here as event_type='ERROR'. That is why this schema has no
// separate error_logs table — API failures already carry full detail on
// api_transactions, and these are the remainder.
async function recordError(entry = {}, connection = null) {
  return recordEvent({ ...entry, eventType: EVENT_TYPES.ERROR }, connection);
}

async function listEvents(journeyId, { limit = 100, connection = null } = {}) {
  return db.runner(connection).query(
    `SELECT id, event_type, from_step, to_step, message, error_code, error_message,
            metadata, created_at
     FROM nivabupa_journey_events WHERE journey_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [journeyId, Number(limit)]
  );
}

// Response payloads omitted: this feeds a resume/debug timeline, and the full
// bodies are already reachable through the typed tables (journey_quotes,
// journey_proposals) for the calls that matter.
async function listApiTransactions(journeyId, { limit = 100, connection = null } = {}) {
  return db.runner(connection).query(
    `SELECT id, uuid, api_name, journey_step, direction, status, http_status,
            duration_ms, error_code, error_message, correlation_id, created_at
     FROM nivabupa_api_transactions WHERE journey_id = ?
     ORDER BY created_at DESC, id DESC LIMIT ?`,
    [journeyId, Number(limit)]
  );
}

export {
  recordApiTransaction,
  recordEvent,
  recordError,
  listEvents,
  listApiTransactions,
};
