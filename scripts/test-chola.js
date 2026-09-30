// ─────────────────────────────────────────────────────────────────────────────
// Chola MS — offline test suite.
//
//   npm run test:chola
//
// Exercises every /chola-ms route through the REAL Express app against a local
// mock of Chola's three hosts — the WSO2 product gateway, the Super Topup .svc
// host and the CKYC e-policy portal — speaking their wire format. No request
// leaves this machine: every CHOLA_* URL is pointed at the mock before any
// module that reads configuration is imported, and the database is pointed at
// a closed port so no row can land in a real MySQL. PolicyGeneration's store is
// an in-memory fake with the repository's claim rules.
//
// Carries over the working implementation's three Chola suites
// (test/chola/cholaAdapter.test.js, cholaAllApis.test.js and cholaApd.test.js
// there — the upstream bodies below are the REAL UAT payloads they captured)
// and adds what the migration itself must prove:
//
//   * response and error envelopes are the ones the SPA reads
//   * Chola's operation names and the SPA's short names reach the same handler
//   * the /health alias serves the same routes
//   * an unconfigured deployment answers 503 naming the variables
//   * the ops screen works under helmet's CSP, at both mounts
//   * no client secret, token, CKYC key or ops key is ever logged
//   * the other insurers' routers are still mounted and answering
//
// No test framework: this service has none. Exit 0 = all passed.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

// ── 1. The mock Chola hosts (started before any config is read) ─────────────

const handlers = new Map();   // "METHOD /path" → [handler, …] (last one sticks)
const received = [];          // every request the mock saw

function on(method, path, ...list) {
  handlers.set(`${method} ${path}`, list);
}

function resetMock() {
  handlers.clear();
  received.length = 0;
}

function hits(method, path) {
  return received.filter((r) => r.method === method && r.path === path);
}

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks);
    const path = decodeURIComponent(req.url.split('?')[0]);
    let json = null;
    try { json = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { json = null; }
    const entry = { method: req.method, path, headers: req.headers, raw, json };
    received.push(entry);

    const key = `${req.method} ${path}`;
    const list = handlers.get(key);
    if (!list || list.length === 0) {
      res.writeHead(599, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: `no handler for ${key}` }));
      return;
    }
    const handler = list.length > 1 ? list.shift() : list[0];
    const out = await handler(entry);
    if (out.delayMs) await new Promise((resolve) => setTimeout(resolve, out.delayMs));
    if (res.destroyed) return;
    if (out.status === 204) {
      res.writeHead(204);
      res.end();
    } else if (out.text !== undefined) {
      res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType || 'text/plain' });
      res.end(out.text);
    } else {
      res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json ?? {}));
    }
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ── 2. Pin the environment BEFORE config is imported ────────────────────────
//
// dotenv never overwrites a variable already set, so everything Chola reads is
// pinned here. Anything left unset would be inherited from the developer's own
// .env — a real CHOLA_BASE_URL or CHOLA_PAYMENT_MODE=APD leaking in would point
// these tests at Chola's live gateway, or at the deposit.

const SECRETS = {
  clientSecret: 'test-client-secret-5d1c',
  privateKey: 'test-private-key-8e2f',
  opsKey: 'test-ops-key-3a9b',
  token: 'chola-jwt-secret-71c0',
  tokenKey: 'TK-secret-44d2',
};
// A made-up code: the real intermediary code is partner identity and lives in
// .env only, like every other insurer's partner/vendor code.
const INTERMEDIARY_CODE = 'TEST-INTERMEDIARY-0001';
const TOPUP_PATH = '/Portalservice/HealthService/SuperTopUp.svc/ProposalSave';
const PORTAL = '/portal';

Object.assign(process.env, {
  NODE_ENV: 'test',
  CHOLA_BASE_URL: MOCK,
  CHOLA_CLIENT_ID: 'test-client-id',
  CHOLA_CLIENT_SECRET: SECRETS.clientSecret,
  CHOLA_INTERMEDIARY_CODE: INTERMEDIARY_CODE,
  CHOLA_TOPUP_PROPOSAL_URL: `${MOCK}${TOPUP_PATH}`,
  CHOLA_CKYC_BASE_URL: `${MOCK}${PORTAL}`,
  CHOLA_CKYC_PRIVATE_KEY: SECRETS.privateKey,
  CHOLA_CKYC_USER_ID: '',
  CHOLA_PAYMENT_MODE: 'PG_CHOLA',
  CHOLA_OPS_KEY: SECRETS.opsKey,
  CHOLA_PUBLIC_URL_BASE: '',
  CHOLA_TOKEN_SKEW_SECONDS: '60',
  CHOLA_MAX_RETRIES: '1',
  CHOLA_RETRY_BASE_DELAY_MS: '1',
  // Short, so the timeout tests stay quick. The backend-built PolicyGeneration
  // gets a longer budget than every other call, which one test relies on.
  CHOLA_API_TIMEOUT_MS: '1000',
  CHOLA_POLICY_GENERATION_TIMEOUT_MS: '2500',
  CHOLA_JSON_BODY_LIMIT: '5mb',
  CHOLA_DEBUG: '0',
  CHOLA_CORS_ORIGINS: '*',
  NIVABUPA_ALIAS_PREFIX: '/health',
  // A closed port: audit writes fail fast and are swallowed, and nothing can
  // reach a developer's real MySQL.
  NIVABUPA_DB_HOST: '127.0.0.1',
  NIVABUPA_DB_PORT: '1',
  NIVABUPA_DB_CONNECT_TIMEOUT_MS: '500',
});
for (const name of [
  'CHOLA_TOKEN_PATH', 'CHOLA_PRODUCT_PATH', 'CHOLA_CKYC_AUTH_PATH', 'CHOLA_CKYC_VERIFY_PATH', 'CHOLA_CKYC_QUERY_PATH',
]) {
  process.env[name] = '';
}

// ── 3. Capture everything logged, to prove no credential is ever printed ────

const VERBOSE = process.env.TEST_VERBOSE === '1';
const logged = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    const line = args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' ');
    logged.push(line);
    if (VERBOSE) original[level](...args);
  };
}
function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
const out = (...args) => original.log(...args);

// ── 4. Now the application ──────────────────────────────────────────────────

const { default: config } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { CHOLA_PRODUCTS, CHOLA_OPERATIONS } = await import('../src/constants/chola.constants.js');
const { resetCholaToken, getCholaToken } = await import('../src/services/cholaAuth.service.js');
const cholaCkyc = await import('../src/services/cholaCkyc.service.js');
const issuer = await import('../src/services/cholaPolicyIssuer.service.js');
const cholaRepository = await import('../src/repositories/chola.repository.js');
const { buildPolicyGenerationBody } = await import('../src/helpers/cholaPolicyGeneration.helper.js');
const { default: db } = await import('../src/db/index.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP_PORT = server.address().port;

function call(method, path, body, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port: APP_PORT,
      method,
      path,
      headers: {
        ...(payload !== null ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: text, buffer, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── 5. Runner, fixtures and the fake PolicyGeneration store ─────────────────

const results = [];
let section = '';

function heading(name) {
  section = name;
  out(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}

// In-memory stand-in for chola.repository with the same claim rules, and a
// global call counter so "claimed BEFORE sent" can be asserted.
let callOrder = 0;
function fakeStore() {
  const s = {
    logs: [],
    proposals: new Map(),
    order: { claim: [], log: [] },
    failClaim: false,
    failLogOnce: false,
    recordScheduleCalls: [],
  };
  s.insertPolicyGenerationLog = async (entry) => {
    s.order.log.push(++callOrder);
    if (s.failLogOnce) { s.failLogOnce = false; throw new Error('db gone'); }
    s.logs.push(entry);
    return s.logs.length;
  };
  s.claimForPolicyGeneration = async ({ genconProposalNumber: no, ...rest }) => {
    s.order.claim.push(++callOrder);
    if (s.failClaim) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const cur = s.proposals.get(no);
    if (!cur) {
      s.proposals.set(no, { ...rest, status: 'POLICY_GENERATION_SENT' });
      return { claimed: true, reattempt: false };
    }
    if (cur.status === 'PAYMENT_FAILED') {
      cur.status = 'POLICY_GENERATION_SENT';
      return { claimed: true, reattempt: true };
    }
    return { claimed: false, existing: { status: cur.status, error_message: cur.errorMessage || null } };
  };
  s.recordOutcome = async (no, outcome) => { Object.assign(s.proposals.get(no), outcome); return 1; };
  s.recordSchedule = async (no, schedule) => {
    s.recordScheduleCalls.push(schedule);
    s.proposals.get(no).schedule = schedule;
    return 1;
  };
  s.listProposals = async () => [...s.proposals.entries()].map(([no, p]) => ({ gencon_proposal_number: no, ...p }));
  s.listPolicyGenerationLogs = async ({ genconProposalNumber } = {}) => (genconProposalNumber
    ? s.logs.filter((l) => l.genconProposalNumber === String(genconProposalNumber))
    : s.logs);
  s.findProposal = async (no) => s.proposals.get(no) || null;
  s.findPolicyPdf = async (no) => {
    const p = s.proposals.get(no);
    return p?.schedule?.pdf ? { gencon_policy_number: p.genconPolicyNumber, policy_pdf: p.schedule.pdf } : null;
  };
  return s;
}

let store = null;
let pdfFetches = [];
let pdfFailure = null;
async function fakeFetchPdf(url) {
  pdfFetches.push(url);
  if (pdfFailure) throw pdfFailure;
  return Buffer.from('%PDF-1.4 test');
}

async function test(name, fn) {
  resetMock();
  resetCholaToken();
  cholaCkyc.resetCholaCkycToken();
  config.env = 'test';
  config.chola.paymentMode = 'PG_CHOLA';
  config.chola.opsKey = SECRETS.opsKey;
  store = fakeStore();
  pdfFetches = [];
  pdfFailure = null;
  const restore = issuer.setCholaIssuerDependencies({ store, fetchPdf: fakeFetchPdf });
  try {
    const detail = await fn();
    results.push({ section, name, ok: true });
    out(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ section, name, ok: false, error: error.message });
    out(`  ❌ ${name}`);
    out(`       ${String(error.message).split('\n').join('\n       ')}`);
  } finally {
    restore();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}\n  expected: ${e}\n  actual:   ${a}`);
}

// Resolves when `fn` rejects; asserts the error matches `check`.
async function rejects(fn, check, what) {
  try {
    await fn();
  } catch (error) {
    check(error);
    return error;
  }
  throw new Error(`${what}: expected a rejection, got a result`);
}

function productPath(key, operation) {
  return `/endpoint/${CHOLA_PRODUCTS[key].path}/v1.0.0/${operation}`;
}
const CKYC_AUTH = `${PORTAL}/epolicyv3api/api/KYC/CholaMS_CKYC_Auth`;
const CKYC_VERIFY = `${PORTAL}/Epolicyv3API/api/KYC/CholaMS_CKYC_Verify`;
const CKYC_QUERY = `${PORTAL}/Epolicyv3API/api/KYC/CholaMS_CKYC_Query`;

function mockToken(token = SECRETS.token) {
  on('POST', '/oauth2/token', () => ({ json: { access_token: token, token_type: 'Bearer', expires_in: 3600 } }));
}
function mockCkycAuth(tokenKey = SECRETS.tokenKey) {
  on('POST', CKYC_AUTH, () => ({ json: { TokenKey: tokenKey, ErrorMSG: '' } }));
}

/** Real WSO2 gateway rejection when the bearer token is bad. */
const WSO2_401 = (seg) => ({
  code: '900901',
  message: 'Invalid Credentials',
  description: `Access failure for API: /${seg}/v1.0.0, version: v1.0.0 status: (900901) - Invalid Credentials.`,
});

/** Real CKYC verify body when the TokenKey is stale — note HTTP 200. */
const CKYC_BAD_TOKEN_BODY = {
  Transaction_ID: null, App_Ref_No: null, CKYC_No: null, Customer_Name: null,
  Status: 'Failure', ErrorMsg: 'Invalid Token Key',
};

const PROPOSAL = '2890476880869';
const POLICY = '2890/00199999/000/00';
// 28 Sep 2026, 11:30 IST.
const NOW = new Date('2026-09-28T06:00:00Z');
const BASE = '/chola-ms';

// ═════════════════════════════════════════════════════════════════════════════
heading('A. OAuth2 token (ported from cholaAllApis.test.js 1/16)');

await test('sends Basic auth + client_credentials, caches by expires_in', async () => {
  mockToken('tok-1');
  eq(await getCholaToken(), 'tok-1', 'first token');
  const [h] = hits('POST', '/oauth2/token');
  eq(h.headers.authorization, `Basic ${Buffer.from(`test-client-id:${SECRETS.clientSecret}`).toString('base64')}`, 'Basic header');
  assert(/application\/x-www-form-urlencoded/.test(h.headers['content-type']), `content-type ${h.headers['content-type']}`);
  eq(h.raw.toString('utf8'), 'grant_type=client_credentials', 'form body');
  eq(await getCholaToken(), 'tok-1', 'second token');
  eq(hits('POST', '/oauth2/token').length, 1, 'token calls');
});

await test('a token expiring inside the skew is re-fetched', async () => {
  on('POST', '/oauth2/token', () => ({ json: { access_token: 'short', expires_in: 5 } }));
  await getCholaToken();
  await getCholaToken();
  eq(hits('POST', '/oauth2/token').length, 2, 'token calls');
});

await test('concurrent getCholaToken() calls share one in-flight request', async () => {
  on('POST', '/oauth2/token', () => ({ json: { access_token: 'once', expires_in: 3600 }, delayMs: 50 }));
  const all = await Promise.all([getCholaToken(), getCholaToken(), getCholaToken()]);
  eq(all, ['once', 'once', 'once'], 'tokens');
  eq(hits('POST', '/oauth2/token').length, 1, 'token calls');
});

await test('forced refresh mints a new token', async () => {
  on('POST', '/oauth2/token',
    () => ({ json: { access_token: 't1', expires_in: 3600 } }),
    () => ({ json: { access_token: 't2', expires_in: 3600 } }));
  eq(await getCholaToken(), 't1', 'first');
  eq(await getCholaToken(), 't1', 'cached');
  eq(await getCholaToken({ force: true }), 't2', 'forced');
});

await test('real UAT invalid_client body → AUTH_ERROR carrying the upstream status', async () => {
  on('POST', '/oauth2/token', () => ({
    status: 401,
    json: {
      error_description: 'Error decoding authorization header. Space delimited "<authMethod> <base64Hash>" format violated.',
      error: 'invalid_client',
    },
  }));
  await rejects(() => getCholaToken(), (e) => {
    eq(e.code, 'AUTH_ERROR', 'code');
    eq(e.status, 502, 'status');
    eq(e.details.httpStatus, 401, 'details.httpStatus');
  }, 'token');
});

await test('200 without access_token → AUTH_ERROR', async () => {
  on('POST', '/oauth2/token', () => ({ json: { token_type: 'Bearer' } }));
  await rejects(() => getCholaToken(), (e) => eq(e.code, 'AUTH_ERROR', 'code'), 'token');
});

await test('missing client credentials → AUTH_ERROR before any network call', async () => {
  const saved = config.chola.clientSecret;
  config.chola.clientSecret = undefined;
  try {
    await rejects(() => getCholaToken(), (e) => eq(e.code, 'AUTH_ERROR', 'code'), 'token');
    eq(received.length, 0, 'requests sent');
  } finally {
    config.chola.clientSecret = saved;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('B. Every product × operation over HTTP (cholaAllApis 2-13/16)');

const ROUTE_OF = {
  PremiumComputation: `${BASE}/PremiumComputation`,
  ProposalSave: `${BASE}/ProposalSave`,
  PolicyGeneration: `${BASE}/PolicyGeneration`,
  PolicySchedule: `${BASE}/PolicySchedule`,
};
const OPERATION_OF = {
  PremiumComputation: 'getQuote',
  ProposalSave: 'createProposal',
  PolicyGeneration: 'issuePolicy',
  PolicySchedule: 'policySchedule',
};
// The minimum input each operation validates for.
const INPUT = {
  PremiumComputation: { InsuredMembers: [{ Relation: 'Self', SumInsured: '500000' }] },
  ProposalSave: { CustomerName: 'Test', InsuredMembers: [] },
  PolicyGeneration: { GenconProposalNumber: '2890476265318', Amount: '18106', TaggingMode: 'PG' },
  PolicySchedule: { GenconPolicyNumber: '2890/00172362/000/00' },
};

for (const productKey of Object.keys(CHOLA_PRODUCTS)) {
  for (const operation of CHOLA_OPERATIONS) {
    const isTopupProposal = productKey === 'SUPER_TOPUP' && operation === 'ProposalSave';
    const upstream = isTopupProposal ? TOPUP_PATH : productPath(productKey, operation);
    await test(`${productKey}.${operation} → ${isTopupProposal ? 'the Super Topup .svc host' : upstream}`, async () => {
      mockToken();
      on('POST', upstream, () => ({
        json: { Status: 'Success', GENCONProposalNumber: 2890476265318, PolicyNumber: '2890/00172362/000/00', TotalPremiumPayable_InclGST: 18106 },
      }));
      const r = await call('POST', ROUTE_OF[operation], { product: productKey, ...INPUT[operation] });
      eq(r.status, 200, `HTTP status (${r.body.slice(0, 200)})`);
      eq([r.json.ok, r.json.provider, r.json.product, r.json.operation], [true, 'chola', productKey, OPERATION_OF[operation]], 'envelope');
      eq(r.json.meta.httpStatus, 200, 'meta.httpStatus');
      assert(/^chola-/.test(r.json.meta.correlationId), `correlationId ${r.json.meta.correlationId}`);
      const [h] = hits('POST', upstream);
      assert(h, `upstream ${upstream} was not called`);
      eq(h.headers.authorization, `Bearer ${SECRETS.token}`, 'Bearer header');
      assert(/application\/json/.test(h.headers['content-type']), 'JSON content-type');
      eq(h.json.product, undefined, 'the `product` selector is stripped');
    });
  }
}

// ═════════════════════════════════════════════════════════════════════════════
heading('C. Transport behaviour (cholaAllApis / cholaAdapter)');

await test('IntermediaryCode is injected on quote/proposal, and never overwritten', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ json: { Status: 'Success', TotalPremiumPayable_InclGST: 1 } }));
  on('POST', productPath('SUPREME', 'ProposalSave'), () => ({ json: { Status: 'Success', GENCONProposalNumber: '1' } }));
  await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  await call('POST', `${BASE}/proposal`, { product: 'SUPREME', IntermediaryCode: 'CALLER-SET' });
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'))[0].json.IntermediaryCode, INTERMEDIARY_CODE, 'injected');
  eq(hits('POST', productPath('SUPREME', 'ProposalSave'))[0].json.IntermediaryCode, 'CALLER-SET', 'caller wins');
});

await test('PolicyGeneration and PolicySchedule are forwarded without IntermediaryCode, as before', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'), () => ({ json: { Status: 'Success', PolicyNumber: 'P' } }));
  on('POST', productPath('FLEXI_HEALTH', 'PolicySchedule'), () => ({ json: { CMSScheduleURL: '' } }));
  await call('POST', `${BASE}/issue`, INPUT.PolicyGeneration);
  await call('POST', `${BASE}/policy/schedule`, INPUT.PolicySchedule);
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'))[0].json.IntermediaryCode, undefined, 'PolicyGeneration');
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PolicySchedule'))[0].json.IntermediaryCode, undefined, 'PolicySchedule');
});

await test('other fields reach Chola untouched (Supreme Plan)', async () => {
  mockToken();
  on('POST', productPath('SUPREME', 'PremiumComputation'), () => ({ json: { Status: 'Success', TotalPremiumPayable_InclGST: 1 } }));
  await call('POST', `${BASE}/quote`, { product: 'SUPREME', InsuredMembers: [], Plan: 'Gold' });
  eq(hits('POST', productPath('SUPREME', 'PremiumComputation'))[0].json.Plan, 'Gold', 'Plan');
});

await test('401 on a product call refreshes the token and retries exactly once', async () => {
  on('POST', '/oauth2/token',
    () => ({ json: { access_token: 'stale', expires_in: 3600 } }),
    () => ({ json: { access_token: 'fresh', expires_in: 3600 } }));
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'),
    () => ({ status: 401, json: WSO2_401('Health-flexiretail') }),
    () => ({ json: { Status: 'Success', TotalPremiumPayable_InclGST: 18106 } }));
  const r = await call('POST', `${BASE}/PremiumComputation`, { InsuredMembers: [] });
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PremiumComputation')).map((h) => h.headers.authorization),
    ['Bearer stale', 'Bearer fresh'], 'Authorization per attempt');
  eq(r.json.data.totalPremium, 18106, 'totalPremium');
});

await test('persistent 401 (real WSO2 body) → 502 UPSTREAM_ERROR carrying the status', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ status: 401, json: WSO2_401('Health-flexiretail') }));
  const r = await call('POST', `${BASE}/PremiumComputation`, { InsuredMembers: [] });
  eq(r.status, 502, 'HTTP status');
  eq(r.json.error.code, 'UPSTREAM_ERROR', 'code');
  eq(r.json.error.details.httpStatus, 401, 'details.httpStatus');
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PremiumComputation')).length, 2, 'attempts');
});

await test('HTTP 500 from Chola → 502 UPSTREAM_ERROR', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ status: 500, text: 'boom' }));
  const r = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  eq([r.status, r.json.error.code], [502, 'UPSTREAM_ERROR'], 'status/code');
});

await test('a JSON `null` body → PARSE_ERROR', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'), () => ({ text: 'null', contentType: 'application/json' }));
  const r = await call('POST', `${BASE}/ProposalSave`, {});
  eq([r.status, r.json.error.code], [502, 'PARSE_ERROR'], 'status/code');
});

await test('a blank 200 / a 204 → PARSE_ERROR, not an all-null "success"', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'), () => ({ text: '', contentType: 'application/json' }));
  on('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'), () => ({ status: 204 }));
  const a = await call('POST', `${BASE}/ProposalSave`, {});
  const b = await call('POST', `${BASE}/PolicyGeneration`, { GenconProposalNumber: '1', Amount: '1' });
  eq([a.json.error.code, b.json.error.code], ['PARSE_ERROR', 'PARSE_ERROR'], 'codes');
});

await test('string JSON body is parsed; non-JSON string is passed through raw', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'),
    () => ({ text: '{"Status":"Success","TotalPremiumPayable_InclGST":"7500.50"}' }));
  on('POST', productPath('FLEXI_HEALTH', 'PolicySchedule'), () => ({ text: '%PDF-1.4 raw' }));
  const q = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  const s = await call('POST', `${BASE}/policy/schedule`, { GenconPolicyNumber: 'X' });
  eq(q.json.data.totalPremium, 7500.5, 'totalPremium');
  eq(s.json.data.raw, '%PDF-1.4 raw', 'raw');
});

await test('502 from Chola is retried (CHOLA_MAX_RETRIES), then surfaces as UPSTREAM_ERROR', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ status: 502, text: '<html>502 Bad Gateway</html>' }));
  const r = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  eq([r.status, r.json.error.code], [502, 'UPSTREAM_ERROR'], 'status/code');
  eq(r.json.error.details.status, 502, 'details.status (what the SPA reads as UPSTREAM_DOWN)');
  eq(hits('POST', productPath('FLEXI_HEALTH', 'PremiumComputation')).length, 2, 'attempts (1 + 1 retry)');
});

await test('a timeout → 504 TIMEOUT_ERROR', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ json: { Status: 'Success' }, delayMs: 1300 }));
  const r = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  eq([r.status, r.json.error.code], [504, 'TIMEOUT_ERROR'], 'status/code');
});

await test('cholaRequest echoes the exchange with the Bearer token masked', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({ json: { Status: 'Success', TotalPremiumPayable_InclGST: 1 } }));
  const r = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
  eq(r.json.cholaRequest.url, `${MOCK}${productPath('FLEXI_HEALTH', 'PremiumComputation')}`, 'url');
  assert(/^\*\*\*set \(\d+ chars\)\*\*\*$/.test(r.json.cholaRequest.requestHeaders.Authorization), 'Authorization masked');
  assert(!r.body.includes(SECRETS.token), 'token leaked into the response');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('D. Validation guards — 400, no network call');

for (const [label, route, body] of [
  ['quote without InsuredMembers', `${BASE}/PremiumComputation`, {}],
  ['PolicyGeneration without GenconProposalNumber', `${BASE}/PolicyGeneration`, { Amount: '1' }],
  ['PolicyGeneration without Amount', `${BASE}/PolicyGeneration`, { GenconProposalNumber: '1' }],
  ['PolicySchedule without GenconPolicyNumber', `${BASE}/PolicySchedule`, {}],
  ['unknown product on quote', `${BASE}/quote`, { product: 'NOPE', InsuredMembers: [] }],
  ['unknown product on proposal', `${BASE}/proposal`, { product: 'NOPE' }],
  ['unknown product on PolicyGeneration', `${BASE}/issue`, { product: 'NOPE', GenconProposalNumber: '1', Amount: '1' }],
  ['unknown product on schedule', `${BASE}/policy/schedule`, { product: 'NOPE', GenconPolicyNumber: '1' }],
]) {
  await test(`${label} → 400 VALIDATION_ERROR`, async () => {
    const r = await call('POST', route, body);
    eq(r.status, 400, 'HTTP status');
    eq([r.json.ok, r.json.error.code, r.json.error.provider], [false, 'VALIDATION_ERROR', null], 'error envelope');
    eq(received.length, 0, 'requests sent to Chola');
  });
}

await test('a request with no body at all is a 400, not a 500 (Express 5)', async () => {
  const r = await call('POST', `${BASE}/PremiumComputation`);
  eq([r.status, r.json.error.code], [400, 'VALIDATION_ERROR'], 'status/code');
});

await test('ProposalSave defaults to FLEXI_HEALTH when product is omitted', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'), () => ({ json: { Status: 'Success', GENCONProposalNumber: '1' } }));
  const r = await call('POST', `${BASE}/ProposalSave`, {});
  eq(r.json.product, 'FLEXI_HEALTH', 'product');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('E. Response normalisation — verbatim UAT bodies');

await test('premium reads the field names Chola actually send', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PremiumComputation'), () => ({
    json: {
      Errormessage: null, GST_on_Modal_Premium: 0, GST_on_TotalPremium: 1613, ModalPremiumPayable_InclGST: 10555,
      ModalPremium_exclGST: 8942, OptedforTier1Premium: '', Status: 'Success',
      TotalPremiumPayable_InclGST: 10555, TotalPremium_exclGST: 8942,
    },
  }));
  const { data } = (await call('POST', `${BASE}/quote`, { InsuredMembers: [] })).json;
  eq([data.succeeded, data.totalPremium, data.netPremium, data.tax, data.modalPremium], [true, 10555, 8942, 1613, 10555], 'premium');
});

await test('a premium response in an unknown shape yields nulls but keeps raw', async () => {
  mockToken();
  on('POST', productPath('SUPREME', 'PremiumComputation'), () => ({ json: { SomethingElse: 9911, Status: 'Success' } }));
  const { data } = (await call('POST', `${BASE}/quote`, { product: 'SUPREME', InsuredMembers: [] })).json;
  eq([data.totalPremium, data.netPremium, data.tax, data.raw.SomethingElse], [null, null, null, 9911], 'premium');
});

await test('GENCONProposalNumber is read (all-caps), coerced to a string; raw kept', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'), () => ({
    json: {
      CustomerID: '190000032216762', Errormessage: null, GENCONProposalNumber: 2890476265318,
      NetPremium: 20490, Status: 'Success', TotalPremiumPayable_InclGST: 20490, UniqueTransactionID: 21163050528786,
    },
  }));
  const { data } = (await call('POST', `${BASE}/proposal`, {})).json;
  eq([data.genconProposalNumber, data.succeeded, data.customerId, data.premium, data.raw.GENCONProposalNumber],
    ['2890476265318', true, '190000032216762', 20490, 2890476265318], 'proposal');
});

await test('a rejected proposal (GENCONProposalNumber 0) reports no proposal number', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'), () => ({
    json: {
      CustomerID: null, Errormessage: ' Please Select NameofInsuranceRepository If eFormatrequirement is Y',
      GENCONProposalNumber: 0, Status: 'Failure', TotalPremiumPayable_InclGST: 0,
    },
  }));
  const r = await call('POST', `${BASE}/proposal`, {});
  eq([r.status, r.json.ok, r.json.data.genconProposalNumber, r.json.data.succeeded], [200, true, null, false], 'proposal');
  assert(/NameofInsuranceRepository/.test(r.json.data.message), 'Chola message kept');
});

await test('PolicyGeneration reads PolicyNumber', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'), () => ({
    json: { Errormessage: '', PayzappID: '', PolicyNumber: '2890/00172362/000/00', Status: 'Success', URL: '' },
  }));
  const { data } = (await call('POST', `${BASE}/issue`, { GenconProposalNumber: '1', Amount: '1' })).json;
  eq([data.genconPolicyNumber, data.succeeded], ['2890/00172362/000/00', true], 'policy');
});

await test('PayMode "Chola" returns a payment URL and no policy number', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'), () => ({
    json: {
      Errormessage: '', PayzappID: '', PolicyNumber: '', Status: 'Success',
      URL: 'https://10.105.63.69/websales/frmTermsandCondition.aspx?SOURCE=INTEGRATION&TRANSID=2890476864840',
    },
  }));
  const { data } = (await call('POST', `${BASE}/issue`, { GenconProposalNumber: '1', Amount: '1' })).json;
  eq(data.genconPolicyNumber, null, 'policy number');
  assert(data.paymentUrl.includes('frmTermsandCondition.aspx'), `paymentUrl ${data.paymentUrl}`);
});

await test('CHOLA_PUBLIC_URL_BASE rewrites only the scheme/host of Chola\'s links', async () => {
  config.chola.publicUrlBase = 'https://uatportal.example.test';
  try {
    mockToken();
    on('POST', productPath('FLEXI_HEALTH', 'PolicyGeneration'), () => ({
      json: { Status: 'Success', PolicyNumber: '', URL: 'http://10.105.63.69/websales/frmTermsandCondition.aspx?TRANSID=9' },
    }));
    const { data } = (await call('POST', `${BASE}/issue`, { GenconProposalNumber: '1', Amount: '1' })).json;
    eq(data.paymentUrl, 'https://uatportal.example.test/websales/frmTermsandCondition.aspx?TRANSID=9', 'paymentUrl');
    eq(data.raw.URL, 'http://10.105.63.69/websales/frmTermsandCondition.aspx?TRANSID=9', 'raw untouched');
  } finally {
    config.chola.publicUrlBase = '';
  }
});

await test('PolicySchedule reports "no document" rather than failing, and reads both URLs', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'PolicySchedule'),
    () => ({ json: { CISScheduleURL: '', CMSScheduleURL: '' } }),
    () => ({
      json: {
        CISScheduleURL: 'http://10.105.63.69/Configurator/CISPage.aspx?OP=x1',
        CMSScheduleURL: 'http://10.105.63.69/Configurator/frmPolicySchedule.aspx?RefNo=Mjg=',
      },
    }));
  const empty = (await call('POST', `${BASE}/PolicySchedule`, { GenconPolicyNumber: '2890476864817' })).json.data;
  const found = (await call('POST', `${BASE}/PolicySchedule`, { GenconPolicyNumber: '2890/00175145/000/00' })).json.data;
  eq([empty.succeeded, empty.scheduleUrl], [false, null], 'empty');
  eq(found.succeeded, true, 'found');
  assert(found.scheduleUrl.includes('frmPolicySchedule.aspx'), 'scheduleUrl');
  assert(found.customerInformationSheetUrl.includes('CISPage.aspx'), 'CIS url');
});

await test('a business rejection (HTTP 200, Status=Failure) is data, not an exception', async () => {
  mockToken();
  on('POST', productPath('FLEXI_HEALTH', 'ProposalSave'),
    () => ({ json: { GenconProposalNumber: null, Status: 'Failure', Message: 'Mandatory field InsuredCity missing' } }));
  const r = await call('POST', `${BASE}/ProposalSave`, {});
  eq([r.status, r.json.ok, r.json.data.genconProposalNumber, r.json.data.status], [200, true, null, 'Failure'], 'envelope');
  assert(/InsuredCity/.test(r.json.data.message), 'message');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('F. CKYC portal (cholaAllApis 14-16/16)');

await test('auth posts PrivateKey/UserID and caches the TokenKey', async () => {
  mockCkycAuth('TK-123');
  eq(await cholaCkyc.auth(), 'TK-123', 'TokenKey');
  eq(hits('POST', CKYC_AUTH)[0].json, { PrivateKey: SECRETS.privateKey, UserID: '' }, 'auth body');
});

await test('real auth rejection (HTTP 200 + empty TokenKey) → AUTH_ERROR', async () => {
  on('POST', CKYC_AUTH, () => ({ json: { TokenKey: '', ErrorMSG: 'Invalid Token Key.' } }));
  await rejects(() => cholaCkyc.auth(), (e) => eq(e.code, 'AUTH_ERROR', 'code'), 'auth');
});

await test('missing CHOLA_CKYC_PRIVATE_KEY → AUTH_ERROR before any network call', async () => {
  const saved = config.chola.ckyc.privateKey;
  config.chola.ckyc.privateKey = null;
  try {
    await rejects(() => cholaCkyc.auth(), (e) => eq(e.code, 'AUTH_ERROR', 'code'), 'auth');
    eq(received.length, 0, 'requests sent');
  } finally {
    config.chola.ckyc.privateKey = saved;
  }
});

await test('POST /chola-ms/CholaMS_CKYC_Verify: auto-auth, TokenKey header, full field map', async () => {
  mockCkycAuth();
  on('POST', CKYC_VERIFY, () => ({ json: { Status: 'Success', CKYC_No: '60023464944656', ErrorMsg: null } }));
  const r = await call('POST', `${BASE}/CholaMS_CKYC_Verify`, {
    appRefNo: '46176753945998', customerType: 'I', customerName: 'ACME',
    panNo: 'CESPK1304A', dobDoi: '13-07-2020', gender: 'M', mobileNo: '9876543210',
  });
  const [h] = hits('POST', CKYC_VERIFY);
  eq(h.headers.tokenkey, SECRETS.tokenKey, 'TokenKey header');
  eq([r.status, r.json.ok, r.json.provider, r.json.operation, r.json.data.CKYC_No],
    [200, true, 'chola', 'ckyc.verify', '60023464944656'], 'envelope');
  eq(h.json, {
    Verify_Type: 'VERIFY', App_Ref_No: '46176753945998', Customer_Type: 'I', Customer_Name: 'ACME',
    Gender: 'M', DOB_DOI: '13-JUL-2020', Mobile_No: '9876543210', CKYC_No: '', PAN_No: 'CESPK1304A',
    Aadhar_No: '', DL_No: '', Voter_ID: '', Passport_no: '', CIN: '', Redirection_URL: '',
  }, 'verify body (all fifteen fields, empties as "")');
  eq(r.json.cholaRequest, undefined, 'no exchange echoed on CKYC');
});

for (const [input, expected, why] of [
  ['13-07-2020', '13-JUL-2020', "the kit's documented dd-MM-yyyy"],
  ['05/12/1991', '05-DEC-1991', 'dd/MM/yyyy'],
  ['1991-12-05', '05-DEC-1991', 'ISO'],
  ['5-2-1990', '05-FEB-1990', 'unpadded'],
  ['13-JUL-2020', '13-JUL-2020', 'already correct'],
  ['13-jul-2020', '13-JUL-2020', 'upper-cased'],
  ['07-13-2020', '07-13-2020', 'MM-dd-yyyy is NOT reinterpreted'],
  ['garbage', 'garbage', 'passed through'],
  ['', '', 'empty stays empty'],
  [undefined, '', 'absent becomes empty'],
]) {
  await test(`DOB_DOI ${JSON.stringify(input)} → ${JSON.stringify(expected)} (${why})`, async () => {
    mockCkycAuth();
    on('POST', CKYC_VERIFY, () => ({ json: { Status: 'Success' } }));
    await cholaCkyc.verify({ appRefNo: 'A', customerType: 'I', customerName: 'ACME', dobDoi: input });
    eq(hits('POST', CKYC_VERIFY)[0].json.DOB_DOI, expected, 'DOB_DOI');
  });
}

await test('POST /chola-ms/ckyc/query posts App_Ref_No + Transaction_ID', async () => {
  mockCkycAuth();
  on('POST', CKYC_QUERY, () => ({ json: { Status: 'Success', CKYC_No: '600' } }));
  const r = await call('POST', `${BASE}/ckyc/query`, { appRefNo: 'AR-1', transactionId: 'TX-1' });
  eq(hits('POST', CKYC_QUERY)[0].json, { App_Ref_No: 'AR-1', Transaction_ID: 'TX-1' }, 'query body');
  eq(r.json.operation, 'ckyc.query', 'operation');
});

await test('the TokenKey is cached across verify + query (auth runs once)', async () => {
  mockCkycAuth();
  on('POST', CKYC_VERIFY, () => ({ json: { Status: 'Success' } }));
  on('POST', CKYC_QUERY, () => ({ json: { Status: 'Success' } }));
  await call('POST', `${BASE}/ckyc/verify`, { appRefNo: 'A', customerType: 'I', customerName: 'N' });
  await call('POST', `${BASE}/ckyc/query`, { appRefNo: 'A' });
  eq(hits('POST', CKYC_AUTH).length, 1, 'auth calls');
});

await test('a 401 from verify triggers exactly one re-auth and retry', async () => {
  on('POST', CKYC_AUTH, () => ({ json: { TokenKey: 'TK-old' } }), () => ({ json: { TokenKey: 'TK-new' } }));
  on('POST', CKYC_VERIFY, () => ({ status: 401, json: { message: 'expired' } }), () => ({ json: { Status: 'Success' } }));
  const r = await call('POST', `${BASE}/ckyc/verify`, { appRefNo: 'A', customerType: 'I', customerName: 'N' });
  eq(hits('POST', CKYC_VERIFY).map((h) => h.headers.tokenkey), ['TK-old', 'TK-new'], 'TokenKey per attempt');
  eq(r.json.data.Status, 'Success', 'Status');
});

for (const [wording, body] of [
  ['"Invalid Token Key"', CKYC_BAD_TOKEN_BODY],
  ['"Enter CKYC Token Key"', { Status: 'Failure', ErrorMsg: 'Enter CKYC Token Key' }],
  ['"Session Expired"', { Status: 'Failure', ErrorMsg: 'Session Expired, please check timestamp.' }],
]) {
  await test(`HTTP 200 + ${wording} re-authenticates and retries`, async () => {
    on('POST', CKYC_AUTH, () => ({ json: { TokenKey: 'TK-1' } }), () => ({ json: { TokenKey: 'TK-2' } }));
    on('POST', CKYC_QUERY, () => ({ json: body }), () => ({ json: { Status: 'Success', CKYC_No: '30092089587992' } }));
    const r = await call('POST', `${BASE}/CholaMS_CKYC_Query`, { appRefNo: 'A' });
    eq(hits('POST', CKYC_QUERY).map((h) => h.headers.tokenkey), ['TK-1', 'TK-2'], 'TokenKey per attempt');
    eq(r.json.data.CKYC_No, '30092089587992', 'CKYC_No');
  });
}

await test('a token rejection that survives the retry → 502 AUTH_ERROR, never ok:true', async () => {
  mockCkycAuth();
  on('POST', CKYC_VERIFY, () => ({ json: CKYC_BAD_TOKEN_BODY }));
  const r = await call('POST', `${BASE}/ckyc/verify`, { appRefNo: 'A', customerType: 'I', customerName: 'N' });
  eq([r.status, r.json.ok, r.json.error.code], [502, false, 'AUTH_ERROR'], 'error');
});

await test('a business-level Failure (no CKYC record) passes through untouched, no re-auth', async () => {
  mockCkycAuth();
  on('POST', CKYC_VERIFY, () => ({ json: { CKYC_No: null, Status: 'Failure', ErrorMsg: 'No record found for the given PAN' } }));
  const r = await call('POST', `${BASE}/ckyc/verify`, { appRefNo: 'A', customerType: 'I', customerName: 'N', panNo: 'ZZZPZ9999Z' });
  eq([r.status, r.json.ok, r.json.data.Status], [200, true, 'Failure'], 'envelope');
  assert(/No record found/.test(r.json.data.ErrorMsg), 'ErrorMsg');
  eq(hits('POST', CKYC_AUTH).length, 1, 'auth calls');
});

await test('HTTP 500 from the portal → 502 UPSTREAM_ERROR', async () => {
  mockCkycAuth();
  on('POST', CKYC_QUERY, () => ({ status: 500, text: 'server error' }));
  const r = await call('POST', `${BASE}/ckyc/query`, { appRefNo: 'A' });
  eq([r.status, r.json.error.code], [502, 'UPSTREAM_ERROR'], 'status/code');
});

for (const [label, route, body] of [
  ['verify without appRefNo', 'ckyc/verify', { customerType: 'I', customerName: 'N' }],
  ['verify without customerName', 'ckyc/verify', { appRefNo: 'A', customerType: 'I' }],
  ['verify without customerType', 'ckyc/verify', { appRefNo: 'A', customerName: 'N' }],
  ['query without appRefNo', 'ckyc/query', {}],
]) {
  await test(`${label} → 400 VALIDATION_ERROR`, async () => {
    const r = await call('POST', `${BASE}/${route}`, body);
    eq([r.status, r.json.error.code], [400, 'VALIDATION_ERROR'], 'status/code');
    eq(received.length, 0, 'requests sent');
  });
}

// ═════════════════════════════════════════════════════════════════════════════
heading('G. PolicyGeneration body — per product, per mode (cholaApd)');

await test('APD for Flexi Health is the specified body, in the kit\'s field order and spelling', () => {
  const body = buildPolicyGenerationBody({
    product: 'FLEXI_HEALTH', mode: 'APD', genconProposalNumber: PROPOSAL, amount: 7795, now: NOW,
  });
  eq(Object.entries(body), [
    ['GenconProposalNumber', PROPOSAL], ['TaggingMode', 'APD'], ['PayMode', ''],
    ['ChequeorDDnumber ', ''], ['ChequeOrDDDate', ''], ['Amount', '7795'], ['BankName', ''],
    ['BankBranch', ''], ['InstrumentType', ''], ['BTAdvicenumber', ''], ['PaymentID', ''],
    ['PGID', ''], ['Dateoftransaction', '28/09/2026'],
  ], 'body');
});

await test('Supreme and Super Topup keep their own spellings', () => {
  const supreme = buildPolicyGenerationBody({ product: 'SUPREME', mode: 'APD', genconProposalNumber: '1', amount: 1, now: NOW });
  const topup = buildPolicyGenerationBody({ product: 'SUPER_TOPUP', mode: 'APD', genconProposalNumber: '1', amount: 1, now: NOW });
  eq([supreme.ChequeOrDDNumber, supreme.BTAdviceNumber, supreme.Dateoftransaction, 'DateOfTransaction' in supreme],
    ['', 0, '28/09/2026', false], 'Supreme');
  eq([topup.ChequeOrDDNumber, topup.BTAdviceNumber, topup.DateOfTransaction, 'Dateoftransaction' in topup],
    ['', '0', '28/09/2026', false], 'Super Topup');
});

await test('the transaction date is the Indian date, not the server\'s', () => {
  const body = buildPolicyGenerationBody({
    product: 'FLEXI_HEALTH', mode: 'APD', genconProposalNumber: '1', amount: 1, now: new Date('2026-09-28T20:00:00Z'),
  });
  eq(body.Dateoftransaction, '29/09/2026', 'date');
});

await test('PG_CHOLA is a gateway tag on Chola\'s page, with our reference', () => {
  const body = buildPolicyGenerationBody({ product: 'FLEXI_HEALTH', mode: 'PG_CHOLA', genconProposalNumber: '1', amount: 1 });
  eq([body.TaggingMode, body.PayMode, body.BankName], ['PG', 'Chola', '3719'], 'tag');
  assert(/^NC/.test(body.PGID), `PGID ${body.PGID}`);
});

await test('PG_DIRECT refuses to assert a payment it has no reference for', async () => {
  await rejects(async () => buildPolicyGenerationBody({ product: 'FLEXI_HEALTH', mode: 'PG_DIRECT', genconProposalNumber: '1', amount: 1 }),
    (e) => eq(e.code, 'VALIDATION_ERROR', 'code'), 'PG_DIRECT');
  const body = buildPolicyGenerationBody({
    product: 'FLEXI_HEALTH', mode: 'PG_DIRECT', genconProposalNumber: '1', amount: 1, paymentReference: 'PAY123',
  });
  eq([body.TaggingMode, body.PayMode, body.PGID], ['PG', 'Direct', 'PAY123'], 'tag');
});

for (const [label, override] of [
  ['a zero amount', { amount: 0 }],
  ['a non-numeric amount', { amount: 'abc' }],
  ['no proposal number', { genconProposalNumber: '' }],
  ['an unknown mode', { mode: 'CASH' }],
]) {
  await test(`rejects ${label}`, async () => {
    await rejects(async () => buildPolicyGenerationBody({
      product: 'FLEXI_HEALTH', mode: 'APD', genconProposalNumber: '1', amount: 1, ...override,
    }), (e) => eq(e.code, 'VALIDATION_ERROR', 'code'), label);
  });
}

// ═════════════════════════════════════════════════════════════════════════════
heading('H. Backend-built PolicyGeneration in APD (cholaApd)');

const PG = productPath('FLEXI_HEALTH', 'PolicyGeneration');
const SCHEDULE = productPath('FLEXI_HEALTH', 'PolicySchedule');
const issueApd = () => issuer.issue({ product: 'FLEXI_HEALTH', GenconProposalNumber: PROPOSAL, Amount: '7795' });

await test('Success with a policy number: POLICY_ISSUED, schedule + PDF stored, evidence logged', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  // Exact raw text, so the evidence can be checked byte for byte.
  const raw = '{"Errormessage":null,"PayzappID":"","PolicyNumber":"2890/00199999/000/00","Status":"Success","URL":""}';
  on('POST', PG, () => ({ text: raw, contentType: 'application/json' }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: 'http://10.105.63.69/sched.pdf', CISScheduleURL: 'http://10.105.63.69/cis.pdf' } }));

  const { result } = await issueApd();
  const sent = hits('POST', PG)[0].json;
  eq([sent.GenconProposalNumber, sent.TaggingMode, sent.PayMode, sent.Amount, sent.BankName, sent.PGID, sent['ChequeorDDnumber ']],
    [PROPOSAL, 'APD', '', '7795', '', '', ''], 'APD body');
  eq([result.data.paymentMode, result.data.status, result.data.genconPolicyNumber, result.data.paymentUrl],
    ['APD', 'POLICY_ISSUED', POLICY, null], 'outcome');
  eq([result.data.schedule.pdfStored, result.data.schedule.scheduleUrl], [true, 'http://10.105.63.69/sched.pdf'], 'schedule');
  eq(hits('POST', SCHEDULE)[0].json, { GenconPolicyNumber: POLICY }, 'PolicySchedule body');
  assert(store.order.claim[0] < store.order.log[0], 'the proposal must be claimed BEFORE anything is sent');
  eq(store.proposals.get(PROPOSAL).status, 'POLICY_ISSUED', 'stored status');
  eq(pdfFetches, ['http://10.105.63.69/sched.pdf'], 'PDF fetched');
  assert(Buffer.isBuffer(store.recordScheduleCalls[0].pdf), 'PDF stored');
  eq(store.logs.length, 1, 'evidence rows');
  const log = store.logs[0];
  eq([log.source, log.product, log.paymentMode, log.taggingMode, log.payMode, log.genconProposalNumber, log.httpStatus, log.responseBody],
    ['ops', 'FLEXI_HEALTH', 'APD', 'APD', '', PROPOSAL, 200, raw], 'evidence');
  eq(JSON.parse(log.requestBody), sent, 'evidence request body');
  eq(log.requestHeaders.Authorization, 'Bearer ***MASKED***', 'masked bearer');
  assert(!JSON.stringify(log).includes(SECRETS.token), 'token leaked into the evidence');
  assert(log.at instanceof Date, 'evidence timestamp');
});

await test('it waits out the long PolicyGeneration budget (slower than CHOLA_API_TIMEOUT_MS)', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: POLICY }, delayMs: 1500 }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: '' } }));
  const { result } = await issueApd();
  eq(result.data.status, 'POLICY_ISSUED', 'status');
});

await test('a failure answer: PAYMENT_FAILED with Chola\'s message, sent once, no schedule', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Failure', Errormessage: 'Insufficient balance in APD account', PolicyNumber: '' } }));
  const { result } = await issueApd();
  eq([result.data.status, result.data.message, result.data.genconPolicyNumber, result.data.schedule],
    ['PAYMENT_FAILED', 'Insufficient balance in APD account', null, null], 'outcome');
  eq(hits('POST', PG).length, 1, 'sends');
  eq(store.proposals.get(PROPOSAL).errorMessage, 'Insufficient balance in APD account', 'stored message');
  eq(hits('POST', SCHEDULE).length, 0, 'schedule calls');
});

await test('HTTP 503 is sent once — no transport retry — and left for review', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ status: 503, text: 'Service Unavailable' }));
  const { result } = await issueApd();
  eq(hits('POST', PG).length, 1, 'sends (CHOLA_MAX_RETRIES=1 must not apply)');
  eq(result.data.status, 'NEEDS_REVIEW', 'status');
  assert(/reconcile/.test(result.data.message), 'reconcile instruction');
  eq(store.logs.length, 1, 'evidence rows');
  assert(/503/.test(store.logs[0].error.message), 'evidence error names the 503');
});

await test('a timeout is sent once and left for review', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success' }, delayMs: 3200 }));
  const { result } = await issueApd();
  eq(hits('POST', PG).length, 1, 'sends');
  eq([result.data.status, result.data.error.code], ['NEEDS_REVIEW', 'TIMEOUT_ERROR'], 'outcome');
});

await test('HTTP 400 is Chola refusing the request: PAYMENT_FAILED, raw body evidenced', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ status: 400, text: '<html>Request Error</html>', contentType: 'text/html' }));
  const { result } = await issueApd();
  eq(result.data.status, 'PAYMENT_FAILED', 'status');
  eq([store.logs[0].httpStatus, store.logs[0].responseBody], [400, '<html>Request Error</html>'], 'evidence');
});

await test('"Success" with no policy number is NEEDS_REVIEW, not a failure to retry from', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: '', URL: '' } }));
  eq((await issueApd()).result.data.status, 'NEEDS_REVIEW', 'status');
});

await test('a token failure means nothing was sent: PAYMENT_FAILED, nothing evidenced', async () => {
  config.chola.paymentMode = 'APD';
  on('POST', '/oauth2/token', () => ({ status: 401, json: { error: 'invalid_client' } }));
  const { result } = await issueApd();
  eq(result.data.status, 'PAYMENT_FAILED', 'status');
  assert(/^Not sent to Chola MS/.test(result.data.message), `message ${result.data.message}`);
  eq(store.logs.length, 0, 'evidence rows');
  eq(hits('POST', PG).length, 0, 'sends');
});

await test('a proposal already sent is refused before any request', async () => {
  config.chola.paymentMode = 'APD';
  store.proposals.set(PROPOSAL, { status: 'POLICY_ISSUED' });
  await rejects(() => issueApd(), (e) => {
    eq(e.code, 'VALIDATION_ERROR', 'code');
    assert(/already been sent.*POLICY_ISSUED/.test(e.message), e.message);
  }, 'issue');
  eq(received.length, 0, 'requests sent');
});

await test('a proposal whose outcome is unknown is refused with a reconcile instruction', async () => {
  config.chola.paymentMode = 'APD';
  store.proposals.set(PROPOSAL, { status: 'NEEDS_REVIEW' });
  await rejects(() => issueApd(), (e) => assert(/reconcile it with Chola MS/.test(e.message), e.message), 'issue');
});

await test('a PAYMENT_FAILED proposal may be sent again when someone asks', async () => {
  config.chola.paymentMode = 'APD';
  store.proposals.set(PROPOSAL, { status: 'PAYMENT_FAILED', errorMessage: 'APD not mapped' });
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Failure', Errormessage: 'APD not mapped' } }));
  eq((await issueApd()).result.data.status, 'PAYMENT_FAILED', 'status');
  eq(store.logs.length, 1, 'evidence rows');
});

await test('if the claim cannot be written, nothing is sent (fake store)', async () => {
  config.chola.paymentMode = 'APD';
  store.failClaim = true;
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: POLICY } }));
  await rejects(() => issueApd(), (e) => assert(/ECONNREFUSED/.test(e.message), e.message), 'issue');
  eq(hits('POST', PG).length, 0, 'sends');
});

await test('if the claim cannot be written, nothing is sent (the REAL repository, database down)', async () => {
  config.chola.paymentMode = 'APD';
  const restore = issuer.setCholaIssuerDependencies({ store: cholaRepository });
  try {
    mockToken();
    on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: POLICY } }));
    await rejects(() => issueApd(), () => {}, 'issue');
    eq(hits('POST', PG).length, 0, 'sends');
  } finally {
    restore();
  }
});

await test('a lost evidence write does not hide the outcome', async () => {
  config.chola.paymentMode = 'APD';
  store.failLogOnce = true;
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Failure', Errormessage: 'Invalid Tagging Mode' } }));
  const { result } = await issueApd();
  eq([result.data.status, result.data.message], ['PAYMENT_FAILED', 'Invalid Tagging Mode'], 'outcome');
  assert(logged.some((l) => l.includes('PolicyGeneration evidence NOT stored')), 'evidence failure logged');
});

await test('the PDF being unreachable leaves the policy issued, with the reason stored', async () => {
  config.chola.paymentMode = 'APD';
  pdfFailure = new Error('connect ETIMEDOUT 10.105.63.69:80');
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: POLICY } }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: 'http://10.105.63.69/s.pdf', CISScheduleURL: '' } }));
  const { result } = await issueApd();
  eq([result.data.status, result.data.schedule.pdfStored], ['POLICY_ISSUED', false], 'outcome');
  assert(/10\.105\.63\.69/.test(result.data.schedule.pdfError), result.data.schedule.pdfError);
});

await test('APD is refused outright in production', async () => {
  config.chola.paymentMode = 'APD';
  config.env = 'production';
  await rejects(() => issueApd(), (e) => eq([e.code, e.status], ['CONFIG_ERROR', 503], 'error'), 'issue');
  eq(store.order.claim.length, 0, 'claims');
});

await test('an unknown CHOLA_PAYMENT_MODE is a config error', async () => {
  config.chola.paymentMode = 'APD_TYPO';
  await rejects(() => issueApd(), (e) => eq(e.code, 'CONFIG_ERROR', 'code'), 'issue');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('I. The website\'s PolicyGeneration (cholaApd)');

const BROWSER_PG = {
  GenconProposalNumber: PROPOSAL, TaggingMode: 'PG', PayMode: 'Chola', 'ChequeorDDnumber ': '', ChequeOrDDDate: '',
  Amount: '7795', BankName: '3719', BankBranch: '', InstrumentType: '', BTAdvicenumber: '', PaymentID: '',
  PGID: 'NCTEST1', Dateoftransaction: '28/09/2026',
};

await test('forwards the browser\'s PG body untouched and logs the exchange (no claim)', async () => {
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Success', PolicyNumber: '', URL: 'https://10.105.63.69/websales/x' } }));
  const r = await call('POST', `${BASE}/PolicyGeneration`, { product: 'FLEXI_HEALTH', ...BROWSER_PG });
  eq(r.json.data.paymentUrl, 'https://10.105.63.69/websales/x', 'paymentUrl');
  eq(hits('POST', PG)[0].json, BROWSER_PG, 'body sent to Chola');
  eq(store.logs.length, 1, 'evidence rows');
  eq([store.logs[0].source, store.logs[0].paymentMode, store.logs[0].taggingMode, store.logs[0].payMode],
    ['website', null, 'PG', 'Chola'], 'evidence');
  eq(JSON.parse(store.logs[0].requestBody), BROWSER_PG, 'evidence body');
  eq(store.order.claim.length, 0, 'claims');
});

for (const mode of ['APD', 'apd', 'Cash']) {
  await test(`refuses TaggingMode ${mode} before any request`, async () => {
    const r = await call('POST', `${BASE}/PolicyGeneration`, { GenconProposalNumber: PROPOSAL, Amount: '7795', TaggingMode: mode });
    eq([r.status, r.json.error.code], [400, 'VALIDATION_ERROR'], 'status/code');
    assert(/only PG/.test(r.json.error.message), r.json.error.message);
    eq([received.length, store.logs.length], [0, 0], 'requests / evidence');
  });
}

await test('under CHOLA_PAYMENT_MODE=APD: issues from the deposit and answers the policy number', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Errormessage: '', PayzappID: '', PolicyNumber: POLICY, Status: 'Success', URL: '' } }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: 'http://10.105.63.69/s.pdf' } }));
  pdfFailure = new Error('connect ETIMEDOUT 10.105.63.69:80');
  const r = await call('POST', `${BASE}/issue`, { product: 'FLEXI_HEALTH', ...BROWSER_PG, Dateoftransaction: '29/09/2026' });
  const sent = hits('POST', PG)[0].json;
  eq([sent.TaggingMode, sent.PayMode, sent.BankName, sent.PGID], ['APD', '', '', ''], 'the browser\'s PG fields are NOT forwarded');
  eq([r.status, r.json.ok, r.json.provider, r.json.operation, r.json.product], [200, true, 'chola', 'issuePolicy', 'FLEXI_HEALTH'], 'envelope');
  const d = r.json.data;
  eq([d.succeeded, d.status, d.outcome, d.paymentMode, d.genconPolicyNumber, d.paymentUrl, d.raw.PolicyNumber],
    [true, 'Success', 'POLICY_ISSUED', 'APD', POLICY, null, POLICY], 'data');
  eq(r.json.meta.httpStatus, 200, 'meta.httpStatus');
  eq(store.order.claim.length, 1, 'claims');
  eq([store.logs[0].source, store.logs[0].paymentMode, store.logs[0].taggingMode], ['website', 'APD', 'APD'], 'evidence');
});

await test('under APD, a second website call for the same proposal is refused before any request', async () => {
  config.chola.paymentMode = 'APD';
  store.proposals.set(PROPOSAL, { status: 'POLICY_ISSUED' });
  const r = await call('POST', `${BASE}/PolicyGeneration`, { product: 'FLEXI_HEALTH', ...BROWSER_PG });
  eq(r.status, 400, 'HTTP status');
  assert(/already been sent/.test(r.json.error.message), r.json.error.message);
  eq(received.length, 0, 'requests');
});

await test('under APD, Chola refusing it reaches the browser as a failed outcome with their message', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Failure', Errormessage: 'Insufficient balance in APD account', PolicyNumber: '' } }));
  const d = (await call('POST', `${BASE}/PolicyGeneration`, { product: 'FLEXI_HEALTH', ...BROWSER_PG })).json.data;
  eq([d.succeeded, d.outcome, d.message, d.genconPolicyNumber],
    [false, 'PAYMENT_FAILED', 'Insufficient balance in APD account', null], 'data');
});

await test('under APD in production the website route answers 503, not a fallback', async () => {
  config.chola.paymentMode = 'APD';
  config.env = 'production';
  const r = await call('POST', `${BASE}/PolicyGeneration`, { product: 'FLEXI_HEALTH', ...BROWSER_PG });
  eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], 'status/code');
  eq(store.order.claim.length, 0, 'claims');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('J. Ops routes and screen');

const OPS_BODY = { product: 'FLEXI_HEALTH', GenconProposalNumber: PROPOSAL, Amount: '7795' };

await test('without the key: 401, and nothing is sent', async () => {
  const r = await call('POST', `${BASE}/ops/PolicyGeneration`, OPS_BODY);
  eq([r.status, r.json.error.code], [401, 'UNAUTHORIZED'], 'status/code');
  eq([store.order.claim.length, received.length], [0, 0], 'claims / requests');
});

await test('with a wrong key: 401', async () => {
  const r = await call('GET', `${BASE}/ops/proposals`, undefined, { headers: { 'X-Ops-Key': `${SECRETS.opsKey}x` } });
  eq(r.status, 401, 'HTTP status');
});

await test('switched off (503) while CHOLA_OPS_KEY is unset', async () => {
  config.chola.opsKey = '';
  const r = await call('GET', `${BASE}/ops/proposals`, undefined, { headers: { 'X-Ops-Key': 'anything' } });
  eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], 'status/code');
});

await test('with the key: issues in the configured mode, and the listing shows it', async () => {
  config.chola.paymentMode = 'APD';
  mockToken();
  on('POST', PG, () => ({ json: { Status: 'Failure', Errormessage: 'APD not mapped for this intermediary' } }));
  const headers = { 'X-Ops-Key': SECRETS.opsKey };
  const r = await call('POST', `${BASE}/ops/PolicyGeneration`, OPS_BODY, { headers });
  eq(r.status, 200, 'HTTP status');
  eq([r.json.data.paymentMode, r.json.data.status, r.json.data.message],
    ['APD', 'PAYMENT_FAILED', 'APD not mapped for this intermediary'], 'outcome');
  eq(hits('POST', PG)[0].json.TaggingMode, 'APD', 'TaggingMode sent');
  const list = await call('GET', `${BASE}/ops/proposals`, undefined, { headers });
  eq([list.json.data[0].gencon_proposal_number, list.json.data[0].status], [PROPOSAL, 'PAYMENT_FAILED'], 'listing');
  const logs = await call('GET', `${BASE}/ops/proposals/${PROPOSAL}/PolicyGeneration`, undefined, { headers });
  eq(logs.json.data.length, 1, 'evidence for the proposal');
  const recent = await call('GET', `${BASE}/ops/PolicyGeneration/logs`, undefined, { headers });
  eq(recent.json.data.length, 1, 'recent evidence');
});

await test('a second send for the same proposal is a 400 naming why', async () => {
  store.proposals.set(PROPOSAL, { status: 'POLICY_ISSUED' });
  const r = await call('POST', `${BASE}/ops/PolicyGeneration`, OPS_BODY, { headers: { 'X-Ops-Key': SECRETS.opsKey } });
  eq(r.status, 400, 'HTTP status');
  assert(/not idempotent/.test(r.json.error.message), r.json.error.message);
});

await test('the stored policy PDF is served, and 404 when there is none', async () => {
  const headers = { 'X-Ops-Key': SECRETS.opsKey };
  const none = await call('GET', `${BASE}/ops/proposals/${PROPOSAL}/pdf`, undefined, { headers });
  eq([none.status, none.json.error.code], [404, 'NOT_FOUND'], 'no PDF');
  store.proposals.set(PROPOSAL, { status: 'POLICY_ISSUED', genconPolicyNumber: POLICY, schedule: { pdf: Buffer.from('%PDF-1.4 x') } });
  const pdf = await call('GET', `${BASE}/ops/proposals/${PROPOSAL}/pdf`, undefined, { headers });
  eq([pdf.status, pdf.headers['content-type'], pdf.buffer.subarray(0, 4).toString('latin1')], [200, 'application/pdf', '%PDF'], 'PDF');
});

await test('the ops screen is served, CSP-safe, at both mounts', async () => {
  for (const [path, base] of [[`${BASE}/ops`, '/chola-ms'], [`/health${BASE}/ops`, '/health/chola-ms']]) {
    const r = await call('GET', path);
    eq(r.status, 200, `${path} status`);
    assert(/text\/html/.test(r.headers['content-type']), `${path} content-type`);
    assert(r.body.includes(`<meta name="chola-base" content="${base}">`), `${path} base`);
    assert(r.body.includes(`<script src="${base}/ops/chola-ops.js"`), `${path} script src`);
    assert(!/<script>/.test(r.body), `${path} has an inline script, which helmet's CSP blocks`);
    assert(/script-src 'self'/.test(r.headers['content-security-policy'] || ''), `${path} CSP`);
    const js = await call('GET', `${base}/ops/chola-ops.js`);
    eq(js.status, 200, `${base} script status`);
    assert(/javascript/.test(js.headers['content-type']), `${base} script content-type`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('K. Routes, alias, configuration');

for (const [primary, short, upstreamOp, body] of [
  ['PremiumComputation', 'quote', 'PremiumComputation', { InsuredMembers: [{ Relation: 'Self' }] }],
  ['ProposalSave', 'proposal', 'ProposalSave', { CustomerName: 'Test' }],
  ['PolicyGeneration', 'issue', 'PolicyGeneration', { GenconProposalNumber: '2890476265318', Amount: '18106' }],
  ['PolicySchedule', 'policy/schedule', 'PolicySchedule', { GenconPolicyNumber: '2890/00172362/000/00' }],
]) {
  await test(`/${primary}, /${short} and /health/chola-ms/${short} reach Chola ${upstreamOp}`, async () => {
    mockToken();
    on('POST', productPath('FLEXI_HEALTH', upstreamOp), () => ({ json: { Status: 'Success', GENCONProposalNumber: '1', PolicyNumber: 'P' } }));
    for (const route of [`${BASE}/${primary}`, `${BASE}/${short}`, `/health${BASE}/${short}`]) {
      const r = await call('POST', route, body);
      eq([r.status, r.json.ok], [200, true], `${route}`);
    }
    eq(hits('POST', productPath('FLEXI_HEALTH', upstreamOp)).length, 3, 'upstream calls');
  });
}

await test('CKYC answers at /CholaMS_CKYC_Verify, /ckyc/verify and under /health', async () => {
  mockCkycAuth();
  on('POST', CKYC_VERIFY, () => ({ json: { Status: 'Success' } }));
  on('POST', CKYC_QUERY, () => ({ json: { Status: 'Success' } }));
  const body = { appRefNo: 'A', customerType: 'I', customerName: 'N' };
  for (const route of [`${BASE}/CholaMS_CKYC_Verify`, `${BASE}/ckyc/verify`, `/health${BASE}/ckyc/verify`,
    `${BASE}/CholaMS_CKYC_Query`, `${BASE}/ckyc/query`, `/health${BASE}/CholaMS_CKYC_Query`]) {
    const r = await call('POST', route, body);
    eq([r.status, r.json.ok], [200, true], route);
  }
});

await test('GET /chola-ms/config/test answers 200 and prints no value', async () => {
  const r = await call('GET', `${BASE}/config/test`);
  eq([r.status, r.json.ok, r.json.data.configured, r.json.data.missing], [200, true, true, []], 'probe');
  eq(r.json.data.ckyc.configured, true, 'ckyc');
  for (const secret of [SECRETS.clientSecret, SECRETS.privateKey, SECRETS.opsKey, 'test-client-id', INTERMEDIARY_CODE]) {
    assert(!r.body.includes(secret), `config/test printed a credential (${secret.slice(0, 6)}…)`);
  }
});

await test('an unconfigured deployment answers 503 CONFIG_ERROR naming the variables', async () => {
  const saved = { ...config.chola };
  Object.assign(config.chola, { baseUrl: undefined, clientId: undefined, clientSecret: undefined, intermediaryCode: undefined });
  try {
    const r = await call('POST', `${BASE}/quote`, { InsuredMembers: [] });
    eq([r.status, r.json.error.code, r.json.error.provider], [503, 'CONFIG_ERROR', 'chola'], 'error');
    eq(r.json.error.details.missing, ['CHOLA_BASE_URL', 'CHOLA_CLIENT_ID', 'CHOLA_CLIENT_SECRET', 'CHOLA_INTERMEDIARY_CODE'], 'missing');
    const probe = await call('GET', `${BASE}/config/test`);
    eq([probe.status, probe.json.data.unconfigured], [503, true], 'probe');
    eq(received.length, 0, 'requests');
  } finally {
    Object.assign(config.chola, saved);
  }
});

await test('Super Topup ProposalSave with no CHOLA_TOPUP_PROPOSAL_URL → 503 naming it', async () => {
  const saved = config.chola.topupProposalUrl;
  config.chola.topupProposalUrl = null;
  try {
    const r = await call('POST', `${BASE}/proposal`, { product: 'SUPER_TOPUP' });
    eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], 'error');
    assert(/CHOLA_TOPUP_PROPOSAL_URL/.test(r.json.error.message), r.json.error.message);
  } finally {
    config.chola.topupProposalUrl = saved;
  }
});

await test('an unknown /chola-ms path answers the 404 envelope, not another insurer\'s', async () => {
  const r = await call('GET', `${BASE}/nope`);
  eq([r.status, r.json.status], [404, 'ERROR'], '404');
});

await test('the other insurers\' routers are still mounted and answering', async () => {
  for (const path of ['/icici-lombard/config/test', '/iffcotokio/config/test', '/future-generali/config/test']) {
    const r = await call('GET', path);
    // Each insurer keeps its own envelope (ITGI answers { status: 'SUCCESS' },
    // ICICI and FG { ok }), so only "answered as itself" is asserted.
    assert([200, 503].includes(r.status), `${path} answered ${r.status}`);
    assert(r.json && (typeof r.json.ok === 'boolean' || typeof r.json.status === 'string'), `${path} answered no JSON envelope`);
  }
  eq((await call('GET', '/healthz')).status, 200, '/healthz');
  const nb = await call('GET', '/nivabupa/zz-not-a-route');
  eq(nb.status, 404, '/nivabupa router still owns its prefix');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('L. Logging never leaks a credential');

await test('no client secret, Basic pair, token, CKYC key, TokenKey or ops key was logged', () => {
  const basic = Buffer.from(`test-client-id:${SECRETS.clientSecret}`).toString('base64');
  const all = logged.join('\n');
  for (const [name, value] of [
    ['client secret', SECRETS.clientSecret], ['Basic pair', basic], ['bearer token', SECRETS.token],
    ['CKYC private key', SECRETS.privateKey], ['CKYC TokenKey', SECRETS.tokenKey], ['ops key', SECRETS.opsKey],
  ]) {
    assert(!all.includes(value), `${name} appeared in the log`);
  }
  return `${logged.length} log lines checked`;
});

// ── Done ────────────────────────────────────────────────────────────────────

server.close();
mock.close();
await db.closePool().catch(() => {});

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  out('\nFailed:');
  for (const f of failed) out(`  ✗ [${f.section}] ${f.name}\n      ${f.error.split('\n').join('\n      ')}`);
}
process.exit(failed.length ? 1 : 0);
