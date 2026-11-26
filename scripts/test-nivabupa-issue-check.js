// Niva Bupa issue check (src/services/nivabupaIssueCheck.service.js): which proposals are
// asked about, that each answer goes through recordProposalStatus and the My Policies hook,
// that a failed call is recorded and does not stop the run, and that nothing personal is
// logged. The database, Niva Bupa's case API and the hook are stand-ins.
//
//   node --test --test-force-exit --experimental-test-module-mocks scripts/test-nivabupa-issue-check.js
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { format } from 'node:util';

process.env.MY_POLICIES_INTAKE_URL = 'http://127.0.0.1:1/api/internal/health-policies';
process.env.HEALTH_POLICY_SECRET = 'test-secret';
process.env.NIVABUPA_ISSUE_CHECK_MINUTES = '30';
process.env.NIVABUPA_ISSUE_CHECK_MAX_AGE_DAYS = '15';
process.env.NIVABUPA_ISSUE_CHECK_BATCH = '10';
process.env.NIVABUPA_DB_HOST = '127.0.0.1';
process.env.NIVABUPA_DB_PORT = '1';

const src = (p) => new URL(`../src/${p}`, import.meta.url).href;

let rows = [];
const queries = [];
mock.module(src('db/index.js'), {
  defaultExport: { query: async (sql, params) => { queries.push({ sql, params }); return rows; } },
});

const answers = new Map();
const asked = [];
mock.module(src('services/caseApi.service.js'), {
  namedExports: {
    getProposalStatus: async (payload) => {
      asked.push(payload);
      const a = answers.get(payload.ApplicationNumber);
      if (a instanceof Error) throw a;
      return { data: a, exchange: {} };
    },
    forwardToCaseApi: async () => ({}),
    downloadPolicy: async () => ({}),
  },
});

const recorded = [];
mock.module(src('services/journey.service.js'), {
  namedExports: {
    recordProposalStatus: async (args) => {
      recorded.push(args);
      if (!args.httpSucceeded) return null;
      const first = args.responsePayload?.preIssuanceStatusData?.[0] || {};
      return /issued/i.test(first.Status || '') ? { status: 'ISSUED', policy_number: first.PolicyNumber } : { status: 'PENDING', policy_number: null };
    },
  },
});

const hooked = [];
mock.module(src('controllers/case.controller.js'), {
  namedExports: {
    reportIssuedToMyPolicies: async (args) => {
      hooked.push(args);
      return args.saved?.status === 'ISSUED' ? { ok: true } : null;
    },
  },
});

const check = await import('../src/services/nivabupaIssueCheck.service.js');

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

test('the query: paid, has a policy code, recent, not final, not asked lately; numbers inlined', async () => {
  queries.length = 0;
  rows = [];
  await check.findPending({ maxAgeDays: 15, minGapMinutes: 30, limit: 10 });
  const { sql, params } = queries[0];
  assert.match(sql, /datapush_status = 'SUCCESS'/);
  assert.match(sql, /application_number IS NOT NULL/);
  assert.match(sql, /INTERVAL 15 DAY/);
  assert.match(sql, /INTERVAL 30 MINUTE/);
  assert.match(sql, /LIMIT 10\b/);
  assert.deepEqual(params, ['ISSUED', 'REJECTED', 'CANCELLED']);

  queries.length = 0;
  await check.findPending({ maxAgeDays: 'x', minGapMinutes: -5, limit: 5000 });
  assert.match(queries[0].sql, /INTERVAL 1 DAY/);
  assert.match(queries[0].sql, /INTERVAL 1 MINUTE/);
  assert.match(queries[0].sql, /LIMIT 100\b/);
});

test('a run asks each, records each answer, and an issued one reaches My Policies', async () => {
  asked.length = 0; recorded.length = 0; hooked.length = 0;
  rows = [
    { journey_id: 11, application_number: '50001', proposer_mobile: '9876543210', datapush_request_payload: null },
    // No saved mobile: read from the datapush body (stored as JSON text)
    { journey_id: 12, application_number: '50002', proposer_mobile: null, datapush_request_payload: JSON.stringify({ Proposal: { PROPOSER: { CONTACT_DETAILS: { MOBILE: '9123456789' } } } }) },
    { journey_id: 13, application_number: '50003', proposer_mobile: '9000000000', datapush_request_payload: null },
  ];
  answers.set('50001', { Status: 'Success', preIssuanceStatusData: [{ Status: 'Policy Issued', PolicyNumber: '31254010' }] });
  answers.set('50002', { Status: 'Success', preIssuanceStatusData: [{ Status: 'Pending For Underwriting' }] });
  answers.set('50003', Object.assign(new Error('Request failed with status code 403'), { response: { status: 403, data: { msg: 'no' } } }));

  const { result, logs } = await logsOf(() => check.runIssueCheck());

  assert.deepEqual(asked, [
    { ApplicationNumber: '50001', MobileNumber: '9876543210' },
    { ApplicationNumber: '50002', MobileNumber: '9123456789' },
    { ApplicationNumber: '50003', MobileNumber: '9000000000' },
  ]);
  assert.deepEqual(recorded.map((r) => [r.journeyId, r.httpSucceeded]), [[11, true], [12, true], [13, false]]);
  assert.equal(recorded[2].httpStatus, 403);
  // The hook sees every successful answer (it decides itself whether to send); not the failure
  assert.deepEqual(hooked.map((h) => h.journeyId), [11, 12]);
  assert.deepEqual(result, [
    { applicationNumber: '50001', status: 'ISSUED', sentToMyPolicies: true },
    { applicationNumber: '50002', status: 'PENDING', sentToMyPolicies: false },
    { applicationNumber: '50003', status: null, error: 403 },
  ]);
  assert.match(logs, /50001 ISSUED → My Policies/);
  assert.match(logs, /50003 failed \(403\)/);
  assert.doesNotMatch(logs, /9876543210|9123456789|9000000000/);
});

test('a database failure is logged, never thrown', async () => {
  const keep = rows;
  rows = null; // query() resolves to null → iterating it throws inside runIssueCheck
  const { result, logs } = await logsOf(() => check.runIssueCheck());
  assert.deepEqual(result, []);
  assert.match(logs, /issue check skipped/);
  rows = keep;
});
