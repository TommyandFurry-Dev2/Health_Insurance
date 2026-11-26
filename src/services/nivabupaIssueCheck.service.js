// ─────────────────────────────────────────────────────────────────────────────
// Niva Bupa: ask again whether paid policies have been issued.
//
// The website calls proposal-status once, on the Covered page straight after
// payment, and Niva Bupa have usually not issued yet at that moment. Nothing
// asked again, so My Policies kept showing "Being issued" for a policy Niva
// Bupa had long since issued. This asks on a timer instead.
//
// Which policies: datapush succeeded (so there is a POLICY_CODE to ask by)
// within issueCheckMaxAgeDays, and the journey's policy row is not yet ISSUED,
// REJECTED or CANCELLED, and was not asked about in the last interval. At most
// issueCheckBatch per run, one at a time, newest first.
//
// Each answer goes through the same path as the website's own call:
// journeyService.recordProposalStatus (audit row + nivabupa_journey_policies)
// and reportIssuedToMyPolicies (the 'issued' call to insuranceapi). Never
// throws. Logs only the policy code and the outcome: no mobile, no name.
// ─────────────────────────────────────────────────────────────────────────────
import db from '../db/index.js';
import config from '../config/env.js';
import * as caseApi from './caseApi.service.js';
import * as journeyService from './journey.service.js';
import * as myPolicies from './myPolicies.service.js';
import { reportIssuedToMyPolicies } from '../controllers/case.controller.js';

const FINAL = ['ISSUED', 'REJECTED', 'CANCELLED'];

/** The paid, not-yet-final Niva Bupa proposals due for another look. */
export async function findPending({ maxAgeDays, minGapMinutes, limit }) {
  // Whole numbers written into the SQL: mysql2's execute() refuses a bound
  // LIMIT on MySQL 8.0.22+, and these come from config, never from a request.
  const days = Math.max(1, Math.floor(Number(maxAgeDays) || 1));
  const gap = Math.max(1, Math.floor(Number(minGapMinutes) || 1));
  const max = Math.min(100, Math.max(1, Math.floor(Number(limit) || 1)));
  return db.query(
    `SELECT p.journey_id, p.application_number, p.proposer_mobile, p.datapush_request_payload
       FROM nivabupa_journey_proposals p
       LEFT JOIN nivabupa_journey_policies pol
              ON pol.journey_id = p.journey_id AND pol.deleted_at IS NULL
      WHERE p.deleted_at IS NULL
        AND p.datapush_status = 'SUCCESS'
        AND p.application_number IS NOT NULL
        AND p.datapush_submitted_at >= NOW() - INTERVAL ${days} DAY
        AND (pol.id IS NULL OR pol.status NOT IN (${FINAL.map(() => '?').join(', ')}))
        AND (pol.proposal_status_checked_at IS NULL
             OR pol.proposal_status_checked_at < NOW() - INTERVAL ${gap} MINUTE)
      ORDER BY p.datapush_submitted_at DESC
      LIMIT ${max}`,
    FINAL,
  );
}

/** The proposer's mobile: the saved column, else the datapush body's. */
function mobileOf(row) {
  if (row.proposer_mobile) return String(row.proposer_mobile);
  let body = row.datapush_request_payload;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = null; }
  }
  return String(body?.Proposal?.PROPOSER?.CONTACT_DETAILS?.MOBILE || '');
}

/** Asks Niva Bupa about one proposal and records the answer. */
export async function checkOne(row) {
  const startedAt = Date.now();
  const payload = { ApplicationNumber: String(row.application_number), MobileNumber: mobileOf(row) };
  const endpointUrl = config.nivabupa.caseApi.proposalStatusUrl;
  try {
    const { data } = await caseApi.getProposalStatus(payload);
    const saved = await journeyService.recordProposalStatus({
      journeyId: row.journey_id,
      requestPayload: payload,
      responsePayload: data,
      httpSucceeded: true,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      endpointUrl,
    });
    const sent = await reportIssuedToMyPolicies({ journeyId: row.journey_id, payload, data, saved });
    return { applicationNumber: payload.ApplicationNumber, status: saved?.status || null, sentToMyPolicies: Boolean(sent?.ok) };
  } catch (error) {
    await journeyService.recordProposalStatus({
      journeyId: row.journey_id,
      requestPayload: payload,
      responsePayload: error.response?.data || null,
      httpSucceeded: false,
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      endpointUrl,
      errorMessage: error.message,
    });
    return { applicationNumber: payload.ApplicationNumber, status: null, error: error.response?.status || error.code || error.message };
  }
}

/** One run: every due proposal, one after another. Never throws. */
export async function runIssueCheck() {
  const settings = config.myPolicies;
  try {
    const rows = await findPending({
      maxAgeDays: settings.issueCheckMaxAgeDays,
      minGapMinutes: settings.issueCheckMinutes,
      limit: settings.issueCheckBatch,
    });
    const results = [];
    for (const row of rows) results.push(await checkOne(row));
    for (const r of results) {
      const outcome = r.error ? `failed (${r.error})` : `${r.status || 'no status'}${r.sentToMyPolicies ? ' → My Policies' : ''}`;
      console.log(`🔎 Niva Bupa issue check: ${r.applicationNumber} ${outcome}`);
    }
    return results;
  } catch (error) {
    console.warn(`⚠️  Niva Bupa issue check skipped: ${error.message}`);
    return [];
  }
}

let timer = null;

/** Starts the timer when the intake is configured and the interval is above 0. */
export function startIssueCheck() {
  const minutes = config.myPolicies.issueCheckMinutes;
  if (!myPolicies.isConfigured() || !(minutes > 0)) {
    console.log('  🔎 Niva Bupa issue check: off (needs MY_POLICIES_INTAKE_URL, HEALTH_POLICY_SECRET and NIVABUPA_ISSUE_CHECK_MINUTES > 0)');
    return null;
  }
  console.log(`  🔎 Niva Bupa issue check: every ${minutes} min, paid in the last ${config.myPolicies.issueCheckMaxAgeDays} days`);
  // First run shortly after boot, so a restart does not wait a whole interval.
  const first = setTimeout(() => { void runIssueCheck(); }, 60 * 1000);
  first.unref();
  timer = setInterval(() => { void runIssueCheck(); }, minutes * 60 * 1000);
  timer.unref();
  return timer;
}

export function stopIssueCheck() {
  if (timer) clearInterval(timer);
  timer = null;
}
