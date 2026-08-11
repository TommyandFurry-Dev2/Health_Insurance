import db from '../db/index.js';
import { newUuid, toMysqlDate, toDecimal, clamp } from '../utils/sanitize.js';
import { POLICY_STATUS } from '../constants/journey.constants.js';

// document_base64 is deliberately absent: it is a LONGTEXT holding the policy
// PDF, and pulling it into every restore would move megabytes per request for a
// value the resume screen only needs to know exists (document_available).
// findDocument() fetches it explicitly.
const SELECT_COLUMNS = `
  id, uuid, journey_id, proposal_id, payment_id, status,
  policy_number, application_number, issue_date, start_date, end_date,
  sum_insured, total_premium, pre_issuance_status, pre_issuance_status_message,
  proposal_status_response, proposal_status_checked_at,
  document_available, document_response, document_downloaded_at,
  created_at, updated_at, deleted_at
`;

// One policy row per journey (UNIQUE on journey_id in the schema), created on
// first write rather than up front so a journey that never reaches payment
// carries no empty policy row.
async function findOrCreate(journeyId, { proposalId, paymentId } = {}, connection = null) {
  const run = db.runner(connection);

  const existing = await run.queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE journey_id = ? AND deleted_at IS NULL`,
    [journeyId]
  );

  if (existing) {
    if ((proposalId && !existing.proposal_id) || (paymentId && !existing.payment_id)) {
      await run.query(
        `UPDATE nivabupa_journey_policies SET
           proposal_id = COALESCE(?, proposal_id),
           payment_id  = COALESCE(?, payment_id)
         WHERE id = ?`,
        [proposalId || null, paymentId || null, existing.id]
      );
      return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE id = ?`, [existing.id]);
    }
    return existing;
  }

  const uuid = newUuid();
  const id = await run.insert(
    'INSERT INTO nivabupa_journey_policies (uuid, journey_id, proposal_id, payment_id) VALUES (?, ?, ?, ?)',
    [uuid, journeyId, proposalId || null, paymentId || null]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE id = ?`, [id]);
}

async function findByJourneyId(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE journey_id = ? AND deleted_at IS NULL`,
    [journeyId]
  );
}

async function findByPolicyNumber(policyNumber, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies
     WHERE policy_number = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [policyNumber]
  );
}

async function findByApplicationNumber(applicationNumber, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies
     WHERE application_number = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [applicationNumber]
  );
}

async function saveIdentifiers(policyId, fields = {}, connection = null) {
  const run = db.runner(connection);
  await run.query(
    `UPDATE nivabupa_journey_policies SET
       policy_number      = COALESCE(?, policy_number),
       application_number = COALESCE(?, application_number),
       status             = COALESCE(?, status),
       issue_date         = COALESCE(?, issue_date),
       start_date         = COALESCE(?, start_date),
       end_date           = COALESCE(?, end_date),
       sum_insured        = COALESCE(?, sum_insured),
       total_premium      = COALESCE(?, total_premium)
     WHERE id = ?`,
    [
      clamp(fields.policyNumber, 80) || null,
      clamp(fields.applicationNumber, 80) || null,
      fields.status || null,
      toMysqlDate(fields.issueDate),
      toMysqlDate(fields.startDate),
      toMysqlDate(fields.endDate),
      toDecimal(fields.sumInsured),
      toDecimal(fields.totalPremium),
      policyId,
    ]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE id = ?`, [policyId]);
}

// proposal-status returns { Status, StatusMessage, preIssuanceStatusData: [...] }.
// The array's first entry is the current stage; the whole envelope is retained
// because the kit shows no exhaustive field list and support queries are
// answered from it.
function extractPreIssuanceStatus(response) {
  if (!response || typeof response !== 'object') return {};
  const rows = response.preIssuanceStatusData || response.PreIssuanceStatusData || [];
  const first = Array.isArray(rows) && rows.length > 0 ? rows[0] : {};
  return {
    status: first.Status ?? first.status ?? first.PolicyStatus ?? response.Status ?? null,
    statusMessage: first.StatusMessage ?? first.statusMessage ?? response.StatusMessage ?? null,
    policyNumber: first.PolicyNumber ?? first.policyNumber ?? null,
    applicationNumber: first.ApplicationNumber ?? first.applicationNumber ?? null,
  };
}

// Maps NivaBupa's pre-issuance text onto the policy_status ENUM. Anything
// unrecognised stays PENDING rather than ISSUED — a policy must never be
// reported as issued on the strength of an unparsed status string.
function mapPolicyStatus(statusText) {
  const status = String(statusText || '').trim().toUpperCase();
  if (!status) return null;
  if (['ISSUED', 'POLICY ISSUED', 'ACTIVE', 'COMPLETED', 'SUCCESS'].includes(status)) return POLICY_STATUS.ISSUED;
  if (['REJECTED', 'DECLINED', 'FAILED'].includes(status)) return POLICY_STATUS.REJECTED;
  if (['CANCELLED', 'CANCELED'].includes(status)) return POLICY_STATUS.CANCELLED;
  if (status.includes('REVIEW') || status.includes('UNDERWRIT') || status.includes('PENDING')) {
    return POLICY_STATUS.UNDER_REVIEW;
  }
  return POLICY_STATUS.PENDING;
}

async function saveProposalStatus(policyId, { responsePayload }, connection = null) {
  const run = db.runner(connection);
  const extracted = extractPreIssuanceStatus(responsePayload);
  const mapped = mapPolicyStatus(extracted.status);

  await run.query(
    `UPDATE nivabupa_journey_policies SET
       status                      = COALESCE(?, status),
       policy_number               = COALESCE(?, policy_number),
       application_number          = COALESCE(?, application_number),
       pre_issuance_status         = ?,
       pre_issuance_status_message = ?,
       proposal_status_response    = ?,
       proposal_status_checked_at  = NOW()
     WHERE id = ?`,
    [
      mapped,
      clamp(extracted.policyNumber, 80) || null,
      clamp(extracted.applicationNumber, 80) || null,
      clamp(extracted.status, 80),
      extracted.statusMessage ? String(extracted.statusMessage).slice(0, 65535) : null,
      db.toJson(responsePayload) || 'null',
      policyId,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE id = ?`, [policyId]);
}

// The download response's exact shape is undocumented in the API kit ("Response
// will be in Base 64 format", no sample), so the blob is located by scanning
// for the longest base64-looking string. document_response keeps the envelope
// with that blob stripped, so the audit copy stays small.
const BASE64_MIN_LENGTH = 512;

function extractDocumentBase64(response, depth = 0) {
  if (depth > 4 || response === null || response === undefined) return null;
  if (typeof response === 'string') {
    const trimmed = response.trim();
    return trimmed.length >= BASE64_MIN_LENGTH && /^[A-Za-z0-9+/=\r\n]+$/.test(trimmed) ? trimmed : null;
  }
  if (typeof response !== 'object') return null;

  let best = null;
  for (const value of Object.values(response)) {
    const found = Array.isArray(value)
      ? value.map((item) => extractDocumentBase64(item, depth + 1)).filter(Boolean).sort((a, b) => b.length - a.length)[0]
      : extractDocumentBase64(value, depth + 1);
    if (found && (!best || found.length > best.length)) best = found;
  }
  return best;
}

function stripDocumentBlob(value, blob, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return blob && value.trim() === blob ? `[base64 document, ${blob.length} chars — stored on journey_policies]` : value;
  }
  if (Array.isArray(value)) return value.map((item) => stripDocumentBlob(item, blob, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = stripDocumentBlob(entry, blob, depth + 1);
  }
  return output;
}

async function saveDocument(policyId, { responsePayload }, connection = null) {
  const run = db.runner(connection);
  const blob = extractDocumentBase64(responsePayload);

  await run.query(
    `UPDATE nivabupa_journey_policies SET
       document_available     = ?,
       document_base64        = COALESCE(?, document_base64),
       document_response      = ?,
       document_downloaded_at = NOW()
     WHERE id = ?`,
    [
      blob ? 1 : 0,
      blob || null,
      db.toJson(stripDocumentBlob(responsePayload, blob)) || 'null',
      policyId,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_policies WHERE id = ?`, [policyId]);
}

// Explicit, separate read — the only path that pulls the blob. Lets a resumed
// journey serve the policy PDF from MySQL instead of calling NivaBupa again.
async function findDocument(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT id, policy_number, document_available, document_base64, document_downloaded_at
     FROM nivabupa_journey_policies WHERE journey_id = ? AND deleted_at IS NULL`,
    [journeyId]
  );
}

async function softDelete(policyId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journey_policies SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [policyId]
  );
}

export {
  findOrCreate,
  findByJourneyId,
  findByPolicyNumber,
  findByApplicationNumber,
  saveIdentifiers,
  saveProposalStatus,
  saveDocument,
  findDocument,
  extractPreIssuanceStatus,
  extractDocumentBase64,
  mapPolicyStatus,
  softDelete,
};
