import db from '../db/index.js';
import { newUuid, toMysqlDate, toDecimal, toInt, clamp } from '../utils/sanitize.js';
import { UW_STATUS } from '../constants/journey.constants.js';

const SELECT_COLUMNS = `
  id, uuid, journey_id, quote_id,
  proposer_first_name, proposer_last_name, proposer_date_of_birth, proposer_gender,
  proposer_mobile, proposer_email, proposer_pan, proposer_marital_status,
  proposer_occupation, proposer_address_line1, proposer_address_line2,
  proposer_city, proposer_state, proposer_pincode,
  policy_start_date, policy_end_date, policy_term, payment_frequency,
  sum_insured, total_premium,
  nominee_name, nominee_date_of_birth, nominee_gender, nominee_relation,
  uw_status, uw_decision_code, uw_decision_message, uw_reference_no,
  uw_request_payload, uw_response_payload, uw_submitted_at,
  datapush_status, application_number, datapush_status_code, datapush_status_message,
  datapush_request_payload, datapush_response_payload, datapush_submitted_at,
  created_at, updated_at, deleted_at
`;

// One proposal per journey. Returns the existing row if there is one so the
// proposer form can be saved repeatedly (autosave) without creating duplicates,
// and so uwDecision and datapush — two calls, minutes apart — land on the same
// row.
async function findOrCreate(journeyId, quoteId = null, connection = null) {
  const run = db.runner(connection);

  const existing = await run.queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals
     WHERE journey_id = ? AND deleted_at IS NULL
     ORDER BY id DESC LIMIT 1`,
    [journeyId]
  );
  if (existing) {
    if (quoteId && existing.quote_id !== quoteId) {
      await run.query('UPDATE nivabupa_journey_proposals SET quote_id = ? WHERE id = ?', [quoteId, existing.id]);
      return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals WHERE id = ?`, [existing.id]);
    }
    return existing;
  }

  const uuid = newUuid();
  const id = await run.insert(
    'INSERT INTO nivabupa_journey_proposals (uuid, journey_id, quote_id) VALUES (?, ?, ?)',
    [uuid, journeyId, quoteId || null]
  );
  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals WHERE id = ?`, [id]);
}

async function findByJourneyId(journeyId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals
     WHERE journey_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [journeyId]
  );
}

async function findByApplicationNumber(applicationNumber, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals
     WHERE application_number = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [applicationNumber]
  );
}

// Column map for the proposer / policy / nominee form blocks. COALESCE on
// update so a partial save from one screen never nulls a field another screen
// already filled — the frontend autosaves per-section, not per-form.
const DETAIL_COLUMNS = {
  proposerFirstName: ['proposer_first_name', (v) => clamp(v, 100)],
  proposerLastName: ['proposer_last_name', (v) => clamp(v, 100)],
  proposerDateOfBirth: ['proposer_date_of_birth', toMysqlDate],
  proposerGender: ['proposer_gender', (v) => clamp(v, 1)],
  proposerMobile: ['proposer_mobile', (v) => clamp(v, 15)],
  proposerEmail: ['proposer_email', (v) => clamp(v, 255)],
  proposerPan: ['proposer_pan', (v) => clamp(v, 20)],
  proposerMaritalStatus: ['proposer_marital_status', (v) => clamp(v, 20)],
  proposerOccupation: ['proposer_occupation', (v) => clamp(v, 100)],
  proposerAddressLine1: ['proposer_address_line1', (v) => clamp(v, 255)],
  proposerAddressLine2: ['proposer_address_line2', (v) => clamp(v, 255)],
  proposerCity: ['proposer_city', (v) => clamp(v, 100)],
  proposerState: ['proposer_state', (v) => clamp(v, 100)],
  proposerPincode: ['proposer_pincode', (v) => clamp(v, 10)],
  policyStartDate: ['policy_start_date', toMysqlDate],
  policyEndDate: ['policy_end_date', toMysqlDate],
  policyTerm: ['policy_term', (v) => clamp(v, 10)],
  paymentFrequency: ['payment_frequency', (v) => clamp(v, 10)],
  sumInsured: ['sum_insured', toDecimal],
  totalPremium: ['total_premium', toDecimal],
  nomineeName: ['nominee_name', (v) => clamp(v, 150)],
  nomineeDateOfBirth: ['nominee_date_of_birth', toMysqlDate],
  nomineeGender: ['nominee_gender', (v) => clamp(v, 1)],
  nomineeRelation: ['nominee_relation', (v) => clamp(v, 50)],
};

async function saveDetails(proposalId, details = {}, connection = null) {
  const run = db.runner(connection);
  const assignments = [];
  const params = [];

  for (const [key, [column, cast]] of Object.entries(DETAIL_COLUMNS)) {
    if (details[key] !== undefined) {
      assignments.push(`${column} = COALESCE(?, ${column})`);
      params.push(cast(details[key]));
    }
  }

  if (assignments.length > 0) {
    params.push(proposalId);
    await run.query(
      `UPDATE nivabupa_journey_proposals SET ${assignments.join(', ')} WHERE id = ? AND deleted_at IS NULL`,
      params
    );
  }

  if (Array.isArray(details.members)) {
    await replaceMembers(proposalId, details.members, connection);
  }

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals WHERE id = ?`, [proposalId]);
}

// Same delete-then-insert reasoning as journey_quote_members: the member set is
// replaced as a unit so removing a member cannot leave a stale high sequence
// number behind.
async function replaceMembers(proposalId, members, connection = null) {
  const run = db.runner(connection);
  await run.query('DELETE FROM nivabupa_journey_proposal_members WHERE proposal_id = ?', [proposalId]);

  for (let index = 0; index < members.length; index += 1) {
    const member = members[index] || {};
    await run.insert(
      `INSERT INTO nivabupa_journey_proposal_members (
         proposal_id, member_seq_no, insured_type, relation_to_proposer,
         first_name, last_name, date_of_birth_raw, date_of_birth, gender,
         height_cm, weight_kg, occupation, marital_status,
         has_pre_existing_disease, medical_details, uw_loading_percent, uw_remarks
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        proposalId,
        toInt(member.memberSeqNo ?? member.mbrShpNo) ?? index + 1,
        clamp(member.insuredType, 1) || null,
        clamp(member.relationToProposer ?? member.relation, 50) || null,
        clamp(member.firstName, 100) || null,
        clamp(member.lastName, 100) || null,
        clamp(member.dateOfBirth, 20) || null,
        toMysqlDate(member.dateOfBirth),
        clamp(member.gender, 1) || null,
        toDecimal(member.heightCm ?? member.height),
        toDecimal(member.weightKg ?? member.weight),
        clamp(member.occupation, 100) || null,
        clamp(member.maritalStatus, 20) || null,
        member.hasPreExistingDisease ? 1 : 0,
        db.toJson(member.medicalDetails),
        toDecimal(member.uwLoadingPercent),
        member.uwRemarks ? String(member.uwRemarks).slice(0, 65535) : null,
      ]
    );
  }
}

async function findMembers(proposalId, connection = null) {
  return db.runner(connection).query(
    `SELECT id, member_seq_no, insured_type, relation_to_proposer, first_name, last_name,
            date_of_birth_raw, date_of_birth, gender, height_cm, weight_kg, occupation,
            marital_status, has_pre_existing_disease, medical_details,
            uw_loading_percent, uw_remarks
     FROM nivabupa_journey_proposal_members WHERE proposal_id = ? ORDER BY member_seq_no ASC`,
    [proposalId]
  );
}

// NivaBupa's uwDecision response shape is documented only by example, so the
// decision code is looked for under several key names. uw_response_payload
// always holds the verbatim response, so a miss here is cosmetic.
function extractUwDecision(response) {
  if (!response || typeof response !== 'object') return {};
  const root = response.RESPONSE || response.Response || response.response || response;
  return {
    code: root.uwDecision ?? root.UW_DECISION ?? root.decision ?? root.STATUS ?? root.status ?? null,
    message: root.uwDecisionMessage ?? root.STATUS_MESSAGE ?? root.statusMessage ?? root.message ?? null,
    referenceNo: root.uwReferenceNo ?? root.referenceNo ?? root.REFERENCE_NO ?? root.applicationNumber ?? null,
  };
}

// Maps NivaBupa's free-text decision onto the uw_status ENUM. Unrecognised
// values become PENDING, never silently APPROVED — an unreadable UW response
// must not let a journey proceed to payment as though it had been accepted.
function mapUwStatus(decisionCode, httpSucceeded) {
  if (!httpSucceeded) return UW_STATUS.FAILED;
  const code = String(decisionCode || '').trim().toUpperCase();
  if (['APPROVED', 'ACCEPT', 'ACCEPTED', 'A', 'STP', 'SUCCESS', 'CLEAN'].includes(code)) return UW_STATUS.APPROVED;
  if (['REFER', 'REFERRED', 'R', 'MANUAL', 'PENDING_UW'].includes(code)) return UW_STATUS.REFERRED;
  if (['DECLINE', 'DECLINED', 'REJECT', 'REJECTED', 'D'].includes(code)) return UW_STATUS.DECLINED;
  return UW_STATUS.PENDING;
}

async function saveUwResult(
  proposalId,
  { requestPayload, responsePayload, httpSucceeded, errorMessage },
  connection = null
) {
  const run = db.runner(connection);
  const decision = extractUwDecision(responsePayload);
  const status = mapUwStatus(decision.code, httpSucceeded);

  await run.query(
    `UPDATE nivabupa_journey_proposals SET
       uw_status           = ?,
       uw_decision_code    = ?,
       uw_decision_message = ?,
       uw_reference_no     = ?,
       uw_request_payload  = ?,
       uw_response_payload = ?,
       uw_submitted_at     = NOW()
     WHERE id = ?`,
    [
      status,
      clamp(decision.code, 40),
      decision.message ? String(decision.message).slice(0, 65535) : (errorMessage || null),
      clamp(decision.referenceNo, 80),
      db.toJson(requestPayload) || 'null',
      db.toJson(responsePayload) || 'null',
      proposalId,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals WHERE id = ?`, [proposalId]);
}

// Data push returns { RESPONSE: { STATUS, POLICY_CODE, STATUS_MESSAGE } } per
// the data-push dictionary. POLICY_CODE becomes application_number — the key
// /nivabupa/proposal-status is later queried by, which is why it must be
// persisted rather than only returned to the caller.
function extractDataPush(response) {
  if (!response || typeof response !== 'object') return {};
  const root = response.RESPONSE || response.Response || response.response || response;
  return {
    status: root.STATUS ?? root.status ?? null,
    policyCode: root.POLICY_CODE ?? root.policyCode ?? root.PolicyCode ?? root.applicationNumber ?? null,
    statusMessage: root.STATUS_MESSAGE ?? root.statusMessage ?? root.message ?? null,
  };
}

function isDataPushSuccess(statusValue) {
  const status = String(statusValue || '').trim().toUpperCase();
  return ['SUCCESS', 'S', 'TRUE', '1', 'OK', 'COMPLETED'].includes(status);
}

async function saveDataPushResult(
  proposalId,
  { requestPayload, responsePayload, httpSucceeded, errorMessage },
  connection = null
) {
  const run = db.runner(connection);
  const result = extractDataPush(responsePayload);
  const succeeded = httpSucceeded && isDataPushSuccess(result.status);

  await run.query(
    `UPDATE nivabupa_journey_proposals SET
       datapush_status           = ?,
       application_number        = COALESCE(?, application_number),
       datapush_status_code      = ?,
       datapush_status_message   = ?,
       datapush_request_payload  = ?,
       datapush_response_payload = ?,
       datapush_submitted_at     = NOW()
     WHERE id = ?`,
    [
      succeeded ? 'SUCCESS' : 'FAILED',
      clamp(result.policyCode, 80),
      clamp(result.status, 40),
      (result.statusMessage || errorMessage)
        ? String(result.statusMessage || errorMessage).slice(0, 65535)
        : null,
      db.toJson(requestPayload) || 'null',
      db.toJson(responsePayload) || 'null',
      proposalId,
    ]
  );

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_proposals WHERE id = ?`, [proposalId]);
}

async function softDelete(proposalId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journey_proposals SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [proposalId]
  );
}

export {
  findOrCreate,
  findByJourneyId,
  findByApplicationNumber,
  saveDetails,
  replaceMembers,
  findMembers,
  saveUwResult,
  saveDataPushResult,
  extractUwDecision,
  extractDataPush,
  mapUwStatus,
  isDataPushSuccess,
  softDelete,
};
