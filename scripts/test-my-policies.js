// My Policies hand-off (src/services/myPolicies.service.js + the proposal-status hook in
// controllers/case.controller.js): the body built from a Niva Bupa datapush, the call to
// insuranceapi with the shared secret, that failures never throw, and that nothing personal
// is logged. A local HTTP server stands in for insuranceapi; no database, no Niva Bupa.
//
//   node --test --test-force-exit --experimental-test-module-mocks scripts/test-my-policies.js
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { format } from 'node:util';

// ── Fake insuranceapi ───────────────────────────────────────────────────────
const received = [];
let answer = { status: 200, body: { status: 'ok', id: 1, action: 'inserted' } };
const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    received.push({ path: req.url, secret: req.headers['x-health-policy-secret'], body: JSON.parse(raw || '{}') });
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());

process.env.MY_POLICIES_INTAKE_URL = `http://127.0.0.1:${server.address().port}/api/internal/health-policies`;
process.env.HEALTH_POLICY_SECRET = 'test-secret';
process.env.MY_POLICIES_INTAKE_TIMEOUT_MS = '2000';
process.env.NIVABUPA_DB_HOST = '127.0.0.1';
process.env.NIVABUPA_DB_PORT = '1';

// ── A datapush body as the website builds it (uwPayload.ts) ─────────────────
const dataPush = {
  Proposal: {
    POLICY: {
      CONTRACT_DETAILS: { SOURCING_APPNO: '123456789012', PRODUCT_VARIANT: 'Titanium', SUM_INSURED: '500000' },
      PAYMENT_INFO: { NET_PREMIUM_AMOUNT_WITH_TAX: '13795' },
    },
    PROPOSER: {
      PERSON_DETAILS: { FIRST_NAME: 'Priya', LAST_NAME: 'Sharma', RELATIONSHIP_PROPOSER: 'SELF' },
      CONTACT_DETAILS: { MOBILE: '9876543210', EMAIL_ID: 'priya@example.com' },
    },
    MEMBER: [
      { MEMBER_ID: '9001', PERSON_DETAILS: { RELATIONSHIP_PROPOSER: 'SELF', FIRST_NAME: 'Priya', LAST_NAME: 'Sharma', DOB: '06/Aug/1988', GENDER: 'F' } },
      { MEMBER_ID: '9002', PERSON_DETAILS: { RELATIONSHIP_PROPOSER: 'SPOUSE', FIRST_NAME: 'Rahul', MIDDLE_NAME: '', LAST_NAME: 'Sharma', DOB: '14/Jan/1986', GENDER: 'M' } },
      { MEMBER_ID: '9003', PERSON_DETAILS: { RELATIONSHIP_PROPOSER: 'SON', FIRST_NAME: 'Aarav', LAST_NAME: 'Sharma', DOB: '01/Dec/2015', GENDER: 'M' } },
      { MEMBER_ID: '9004', PERSON_DETAILS: { RELATIONSHIP_PROPOSER: 'DAUGHTER', FIRST_NAME: 'Anaya', LAST_NAME: 'Sharma', DOB: '22/Mar/2019', GENDER: 'F' } },
    ],
  },
};

// The stored proposal row the proposal-status hook reads (datapush body kept as JSON text)
let storedProposal = null;
const lookups = [];
mock.module(new URL('../src/repositories/proposal.repository.js', import.meta.url).href, {
  namedExports: {
    findByJourneyId: async (journeyId) => { lookups.push(['journey', journeyId]); return journeyId ? storedProposal : null; },
    findByApplicationNumber: async (code) => { lookups.push(['code', code]); return storedProposal; },
    extractDataPush: () => ({}),
    isDataPushSuccess: () => false,
    findOrCreate: async () => null,
    saveDetails: async () => null,
    replaceMembers: async () => null,
    findMembers: async () => [],
    saveUwResult: async () => null,
    saveDataPushResult: async () => null,
    extractUwDecision: () => ({}),
    mapUwStatus: () => null,
    softDelete: async () => null,
  },
});

const myPolicies = await import('../src/services/myPolicies.service.js');
const { reportIssuedToMyPolicies } = await import('../src/controllers/case.controller.js');
const { default: config } = await import('../src/config/env.js');

/** Console output captured while `fn` runs. */
async function logsOf(fn) {
  const lines = [];
  const keep = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(keep)) console[k] = (...args) => lines.push(format(...args));
  try {
    return { result: await fn(), logs: lines.join('\n') };
  } finally {
    Object.assign(console, keep);
  }
}

test('the body: plan name, cover, family, policy code, keyed by SOURCING_APPNO', () => {
  assert.deepEqual(myPolicies.nivaBupaPolicyBody(dataPush, { stage: 'paid', policyNumber: '12345678', numberKind: 'code' }), {
    insurer: 'nivabupa',
    insurerName: 'Niva Bupa',
    reference: '123456789012',
    mobile: '9876543210',
    stage: 'paid',
    holder: 'Priya Sharma',
    email: 'priya@example.com',
    premium: 13795,
    plan: 'Reassure 3.0 Black',
    cover: 500000,
    members: ['You', 'Spouse', 'Son', 'Daughter'],
    insured: [
      { name: 'Priya Sharma', relation: 'Self', dob: '1988-08-06', gender: 'F', memberId: '9001' },
      { name: 'Rahul Sharma', relation: 'Spouse', dob: '1986-01-14', gender: 'M', memberId: '9002' },
      { name: 'Aarav Sharma', relation: 'Son', dob: '2015-12-01', gender: 'M', memberId: '9003' },
      { name: 'Anaya Sharma', relation: 'Daughter', dob: '2019-03-22', gender: 'F', memberId: '9004' },
    ],
    policyNumber: '12345678',
    numberKind: 'code',
  });
  // Stored as JSON text works the same; no number means no numberKind
  const fromText = myPolicies.nivaBupaPolicyBody(JSON.stringify(dataPush), { stage: 'paid', numberKind: 'code' });
  assert.equal(fromText.reference, '123456789012');
  assert.equal(fromText.policyNumber, undefined);
  assert.equal(fromText.numberKind, undefined);
});

test('members are counted; a body without SOURCING_APPNO or mobile is not built', () => {
  const rel = (...codes) => codes.map((c) => ({ PERSON_DETAILS: { RELATIONSHIP_PROPOSER: c } }));
  assert.deepEqual(myPolicies.membersOf(rel('SELF', 'SON', 'SON', 'MOTHER')), ['You', '2 Sons', 'Mother']);
  assert.deepEqual(myPolicies.membersOf(null), []);

  const noRef = structuredClone(dataPush);
  delete noRef.Proposal.POLICY.CONTRACT_DETAILS.SOURCING_APPNO;
  assert.equal(myPolicies.nivaBupaPolicyBody(noRef, { stage: 'paid' }), null);

  const noMobile = structuredClone(dataPush);
  noMobile.Proposal.PROPOSER.CONTACT_DETAILS.MOBILE = '';
  assert.equal(myPolicies.nivaBupaPolicyBody(noMobile, { stage: 'paid' }), null);
  assert.equal(myPolicies.nivaBupaPolicyBody(noMobile, { stage: 'issued', mobile: '9876543210' }).mobile, '9876543210');
  assert.equal(myPolicies.nivaBupaPolicyBody('not json', { stage: 'paid' }), null);
});

test('insured members: dates to ISO, relation labels, nameless members skipped', () => {
  assert.equal(myPolicies.isoDate('06/Aug/1998'), '1998-08-06');
  assert.equal(myPolicies.isoDate('6/aug/1998'), '1998-08-06');
  assert.equal(myPolicies.isoDate('06/08/1998'), '1998-08-06');
  assert.equal(myPolicies.isoDate('1998-08-06T00:00:00Z'), '1998-08-06');
  assert.equal(myPolicies.isoDate('06/Foo/1998'), '');
  assert.equal(myPolicies.isoDate(null), '');

  assert.deepEqual(myPolicies.insuredOf([
    { PERSON_DETAILS: { FIRST_NAME: 'Asha', RELATIONSHIP_PROPOSER: 'GRAND_MOTHER', DOB: 'bad', GENDER: 'X' } },
    { PERSON_DETAILS: { RELATIONSHIP_PROPOSER: 'SON' } },
  ]), [{ name: 'Asha', relation: 'Grand mother' }]);
  assert.deepEqual(myPolicies.insuredOf(undefined), []);

  // No names at all: no `insured` key, the labels still go
  const unnamed = structuredClone(dataPush);
  for (const m of unnamed.Proposal.MEMBER) { delete m.PERSON_DETAILS.FIRST_NAME; delete m.PERSON_DETAILS.LAST_NAME; }
  const body = myPolicies.nivaBupaPolicyBody(unnamed, { stage: 'paid' });
  assert.equal('insured' in body, false);
  assert.deepEqual(body.members, ['You', 'Spouse', 'Son', 'Daughter']);
});

test('sends to insuranceapi with the secret; logs only the reference', async () => {
  received.length = 0;
  answer = { status: 200, body: { status: 'ok', id: 7, action: 'inserted' } };
  const body = myPolicies.nivaBupaPolicyBody(dataPush, { stage: 'paid', policyNumber: '12345678', numberKind: 'code' });
  const { result, logs } = await logsOf(() => myPolicies.recordInBackground('datapush', body));
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.equal(received[0].path, '/api/internal/health-policies');
  assert.equal(received[0].secret, 'test-secret');
  assert.equal(received[0].body.reference, '123456789012');
  assert.match(logs, /nivabupa:123456789012 paid \(code\) → inserted/);
  assert.doesNotMatch(logs, /9876543210|Priya|Rahul|Aarav|Anaya|1988-08-06|priya@example\.com/);
  assert.equal(received[0].body.insured.length, 4);
});

test('a refusal or an unreachable insuranceapi never throws', async () => {
  answer = { status: 401, body: { status: 'error', message: 'Not authorised.' } };
  const body = myPolicies.nivaBupaPolicyBody(dataPush, { stage: 'paid' });
  const { result: refused } = await logsOf(() => myPolicies.recordInBackground('datapush', body));
  assert.deepEqual([refused.ok, refused.status, refused.reason], [false, 401, 'Not authorised.']);

  const url = config.myPolicies.url;
  config.myPolicies.url = 'http://127.0.0.1:1/nowhere';
  try {
    const { result: down } = await logsOf(() => myPolicies.recordInBackground('datapush', body));
    assert.equal(down.ok, false);
  } finally {
    config.myPolicies.url = url;
  }
});

test('not configured: nothing is sent', async () => {
  received.length = 0;
  const secret = config.myPolicies.secret;
  config.myPolicies.secret = '';
  try {
    const result = await myPolicies.recordInBackground('datapush', myPolicies.nivaBupaPolicyBody(dataPush, { stage: 'paid' }));
    assert.equal(result.reason, 'not_configured');
    assert.equal(received.length, 0);
  } finally {
    config.myPolicies.secret = secret;
  }
});

test('proposal status ISSUED sends the real number, keyed from the stored datapush body', async () => {
  received.length = 0;
  lookups.length = 0;
  answer = { status: 200, body: { status: 'ok', id: 7, action: 'updated' } };
  storedProposal = { datapush_request_payload: JSON.stringify(dataPush) };

  const { result } = await logsOf(() => reportIssuedToMyPolicies({
    journeyId: 42,
    payload: { ApplicationNumber: '12345678', MobileNumber: '9876543210' },
    data: {},
    saved: { status: 'ISSUED', policy_number: '31254010' },
  }));
  assert.equal(result.ok, true);
  assert.equal(received.length, 1);
  assert.deepEqual(
    (({ reference, stage, policyNumber, numberKind }) => ({ reference, stage, policyNumber, numberKind }))(received[0].body),
    { reference: '123456789012', stage: 'issued', policyNumber: '31254010', numberKind: undefined },
  );
});

test('proposal status without a journey reads Niva Bupa\'s own answer and finds the proposal by policy code', async () => {
  received.length = 0;
  lookups.length = 0;
  storedProposal = { datapush_request_payload: dataPush };
  const { result } = await logsOf(() => reportIssuedToMyPolicies({
    journeyId: null,
    payload: { ApplicationNumber: '12345678' },
    data: { Status: 'Success', preIssuanceStatusData: [{ Status: 'Policy Issued', PolicyNumber: '31254010' }] },
    saved: null,
  }));
  assert.equal(result.ok, true);
  assert.deepEqual(lookups, [['code', '12345678']]);
  assert.equal(received[0].body.policyNumber, '31254010');
});

test('not issued yet, or nothing stored to key it by: nothing is sent', async () => {
  received.length = 0;
  storedProposal = { datapush_request_payload: dataPush };
  assert.equal(await reportIssuedToMyPolicies({ journeyId: 42, payload: {}, data: {}, saved: { status: 'PENDING', policy_number: null } }), null);

  storedProposal = null;
  const { result } = await logsOf(() => reportIssuedToMyPolicies({
    journeyId: 42, payload: { ApplicationNumber: '12345678' }, data: {}, saved: { status: 'ISSUED', policy_number: '31254010' },
  }));
  assert.equal(result, null);
  assert.equal(received.length, 0);
});
