// ─────────────────────────────────────────────────────────────────────────────
// My Policies on the website.
//
// A health policy used to reach the customer's My Policies only if their
// browser came back to the website's "Covered" page after paying. This sends
// it from here instead, the way pet and motor are recorded by the backend that
// talks to the insurer: insuranceapi's POST /api/internal/health-policies
// (its docs/health-policy-intake.md), with the shared secret in
// X-Health-Policy-Secret.
//
// Niva Bupa, twice:
//   * after a successful datapush: stage 'paid', the POLICY_CODE as a policy code
//   * when proposal status reports the policy ISSUED: stage 'issued', the real number
// Both are keyed by SOURCING_APPNO, the application number the website keeps
// too, so insuranceapi updates one row and lists the policy once.
//
// Rules: off while MY_POLICIES_INTAKE_URL or HEALTH_POLICY_SECRET is empty;
// never throws; never delays the buyer (callers use recordInBackground); never
// logs the mobile, name or email.
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';

import config from '../config/env.js';

const SECRET_HEADER = 'X-Health-Policy-Secret';

// The Premium API's variant values and the names the buyer was shown
// (website services/health/nivabupa/premium.ts NIVABUPA_VARIANTS).
const NIVABUPA_VARIANT_LABELS = { Gold: 'Classic', Diamond: 'Select', Platinum: 'Elite', Titanium: 'Black' };

const text = (value) => (value === null || value === undefined ? '' : String(value).trim());

export function isConfigured() {
  return Boolean(config.myPolicies?.url && config.myPolicies?.secret);
}

/** A stored payload may be the object or its JSON text. */
function asObject(payload) {
  if (!payload) return null;
  if (typeof payload === 'object') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/** "You", "Spouse", "2 Sons"… in MEMBER order, from RELATIONSHIP_PROPOSER (SELF, SPOUSE, SON…). */
export function membersOf(members) {
  const counts = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    const code = text(member?.PERSON_DETAILS?.RELATIONSHIP_PROPOSER).toUpperCase();
    if (!code) continue;
    const label = code === 'SELF' ? 'You' : code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' ');
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts].map(([label, n]) => (n > 1 ? `${n} ${label}s` : label));
}

/**
 * The insuranceapi body for a Niva Bupa policy, from the datapush request
 * (`{ Proposal: { POLICY, PROPOSER, MEMBER[] } }`), or null when it lacks the
 * application number or the proposer's mobile.
 *
 * @param {object|string} dataPushPayload  the datapush body (or its stored JSON)
 * @param {{stage: 'paid'|'issued', policyNumber?: string, numberKind?: 'code', mobile?: string}} opts
 */
export function nivaBupaPolicyBody(dataPushPayload, { stage, policyNumber, numberKind, mobile } = {}) {
  const proposal = asObject(dataPushPayload)?.Proposal;
  if (!proposal) return null;
  const contract = proposal.POLICY?.CONTRACT_DETAILS || {};
  const person = proposal.PROPOSER?.PERSON_DETAILS || {};
  const contact = proposal.PROPOSER?.CONTACT_DETAILS || {};

  const reference = text(contract.SOURCING_APPNO);
  const phone = text(contact.MOBILE) || text(mobile);
  if (!reference || !phone) return null;

  const variant = text(contract.PRODUCT_VARIANT);
  const body = {
    insurer: 'nivabupa',
    insurerName: 'Niva Bupa',
    reference,
    mobile: phone,
    stage,
    holder: [text(person.FIRST_NAME), text(person.LAST_NAME)].filter(Boolean).join(' '),
    email: text(contact.EMAIL_ID),
    premium: Number(proposal.POLICY?.PAYMENT_INFO?.NET_PREMIUM_AMOUNT_WITH_TAX) || undefined,
    plan: variant ? `Reassure 3.0 ${NIVABUPA_VARIANT_LABELS[variant] || variant}` : 'Reassure 3.0',
    cover: Number(contract.SUM_INSURED) || undefined,
    members: membersOf(proposal.MEMBER),
  };
  if (text(policyNumber)) body.policyNumber = text(policyNumber);
  if (numberKind === 'code' && body.policyNumber) body.numberKind = 'code';
  return body;
}

/**
 * POSTs one policy to insuranceapi. Never throws.
 * @returns {Promise<{ok: boolean, status?: number, reason?: string, data?: any}>}
 */
export async function recordHealthPolicy(body) {
  if (!isConfigured()) return { ok: false, reason: 'not_configured' };
  if (!body) return { ok: false, reason: 'no_body' };
  try {
    const res = await axios.post(config.myPolicies.url, body, {
      timeout: config.myPolicies.timeoutMs,
      headers: { 'content-type': 'application/json', [SECRET_HEADER]: config.myPolicies.secret },
      validateStatus: () => true,
    });
    const ok = res.status >= 200 && res.status < 300;
    return ok ? { ok, status: res.status, data: res.data } : { ok, status: res.status, reason: text(res.data?.message) || 'refused' };
  } catch (error) {
    return { ok: false, reason: error.code || error.message || 'network_error' };
  }
}

/**
 * Sends without making the caller wait, and logs the outcome by reference only.
 * Returns the promise so tests can await it; callers ignore it.
 */
export function recordInBackground(label, body) {
  if (!isConfigured()) return Promise.resolve({ ok: false, reason: 'not_configured' });
  if (!body) {
    console.warn(`⚠️  My Policies (${label}): not sent, the datapush body has no SOURCING_APPNO or proposer mobile`);
    return Promise.resolve({ ok: false, reason: 'no_body' });
  }
  const outline = `${body.insurer}:${body.reference} ${body.stage}${body.numberKind ? ' (code)' : ''}`;
  return recordHealthPolicy(body).then((result) => {
    if (result.ok) console.log(`📋 My Policies (${label}): ${outline} → ${result.data?.action || 'saved'}`);
    else console.warn(`⚠️  My Policies (${label}): ${outline} not saved: ${result.status || ''} ${result.reason}`.replace(/\s+/g, ' '));
    return result;
  });
}
