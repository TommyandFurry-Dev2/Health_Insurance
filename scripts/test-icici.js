// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard — offline test suite.
//
//   npm run test:icici
//
// Exercises every /icici-lombard route through the REAL Express app against a
// local mock of ICICI's gateway speaking their wire format. No request leaves
// this machine: EL_BASE_URL is pointed at the mock before any module that reads
// configuration is imported, and the database is pointed at a closed port so no
// audit row can land in a real MySQL.
//
// Carries over all 17 unit tests of the working implementation
// (test/elevate/elAdapter.test.js and test/elevate/authCrypto.test.js there)
// and adds what the migration itself must prove:
//
//   * response and error envelopes are byte-compatible with what the SPA reads
//   * ICICI's TransactionId (bnc_…) reaches ICICI verbatim on every later call
//   * retry, 401-refresh, timeout and Success:false handling are unchanged
//   * the /health alias serves the same routes
//   * an unconfigured deployment answers 503 naming the variables
//   * no password, encrypted password, login or token is ever logged
//   * the other insurers' routers are still mounted and answering
//
// No test framework: this service has none, and adding one for this would be a
// dependency ICICI does not need. Exit 0 = all passed.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import crypto from 'node:crypto';

// ── 1. The mock ICICI gateway (started before any config is read) ───────────

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
    if (out.buffer) {
      res.writeHead(out.status ?? 200, { 'Content-Type': out.contentType || 'application/pdf' });
      res.end(out.buffer);
    } else if (out.text !== undefined) {
      res.writeHead(out.status ?? 200, { 'Content-Type': 'text/plain' });
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
// dotenv never overwrites a variable already set, so everything ICICI reads is
// pinned here. Anything left unset would be inherited from the developer's own
// .env — a real EL_BASE_URL or EL_PASSWORD_PRE_ENCRYPTED=true leaking in would
// point these tests at ICICI's live gateway or at the wrong password branch.

const TEST_AES_KEY = Buffer.from('0123456789abcdef', 'utf8').toString('base64');
Object.assign(process.env, {
  EL_BASE_URL: MOCK,
  EL_LOGIN: 'test-login-7f3a',
  EL_PASSWORD: 'test-password-9c2e',
  EL_AES_KEY: TEST_AES_KEY,
  EL_AES_MODE: 'aes-128-ecb',
  EL_AES_IV: '',
  EL_PASSWORD_PRE_ENCRYPTED: 'false',
  EL_CLIENT_NAME: 'novacred',
  EL_TOKEN_SKEW_SECONDS: '60',
  EL_MAX_RETRIES: '1',
  EL_RETRY_BASE_DELAY_MS: '1',
  EL_API_TIMEOUT_MS: '3000',
  EL_JSON_BODY_LIMIT: '5mb',
  EL_DEBUG: '0',
  EL_CORS_ORIGINS: '*',
  NIVABUPA_ALIAS_PREFIX: '/health',
  // A closed port: audit writes fail fast and are swallowed, and nothing can
  // reach a developer's real MySQL.
  NIVABUPA_DB_HOST: '127.0.0.1',
  NIVABUPA_DB_PORT: '1',
  NIVABUPA_DB_CONNECT_TIMEOUT_MS: '500',
});
for (const name of [
  'EL_TOKEN_PATH', 'EL_PREMIUM_PATH', 'EL_PROPOSAL_PATH', 'EL_POLICY_SYNC_PATH', 'EL_POLICY_STATUS_PATH',
  'EL_EMI_DUE_PATH', 'EL_EMI_PROCESS_PATH', 'EL_COI_PATH', 'EL_ZONE_PATH', 'EL_CKYC_PATH', 'EL_OVD_INITIATE_PATH',
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
const { encryptPassword, normalizeEncKey } = await import('../src/helpers/iciciCrypto.helper.js');
const { getIciciToken, getIciciEncKey, resetIciciToken } = await import('../src/services/iciciAuth.service.js');
const { default: db } = await import('../src/db/index.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP_PORT = server.address().port;

function call(method, path, body, { headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const payload = rawBody !== undefined ? rawBody : (body === undefined ? null : JSON.stringify(body));
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
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── 5. Runner ───────────────────────────────────────────────────────────────

const results = [];
let section = '';

function heading(name) {
  section = name;
  out(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}

async function test(name, fn) {
  resetMock();
  resetIciciToken();
  try {
    const detail = await fn();
    results.push({ section, name, ok: true });
    out(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ section, name, ok: false, error: error.message });
    out(`  ❌ ${name}`);
    out(`       ${String(error.message).split('\n').join('\n       ')}`);
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

// Fixtures shaped exactly like ICICI's answers (from the working
// implementation's tests and observed UAT responses).
const BNC = 'bnc_6jvy53FUTUt0n';
let tokenSeq = 0;
function tokenOk() {
  tokenSeq += 1;
  return {
    json: {
      token: `jwt-secret-token-${tokenSeq}-abcdef0123456789`,
      expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      encKey: Buffer.from('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', 'utf8').toString('base64'),
      success: true,
      errorMessage: '',
    },
  };
}
function mockToken() {
  on('POST', '/auth-api/access/token', () => tokenOk());
}

const QUOTE = {
  RequestId: 'r1', SumInsured: 500000, Tenure: 1, Pincode: '560062',
  Insured: [{
    InsuredType: 'Adult', Name: 'Sam', DateOfBirth: '30-Aug-1989', Gender: 'Female', IsPED: false, RelationshipWithApplicant: 'SELF',
  }],
};

const PROPOSAL = {
  RequestId: 'r1', TransactionId: BNC,
  NomineeName: 'kashish more', NomineeDOB: '01-Jan-1970', RelationshipWithInsured: 'MOTHER',
  SuccessUrl: 'https://example.test/elevate-return', FailureUrl: 'https://example.test/elevate-return',
  Proposer: { EmailId: 'a@b.com', MobileNo: '7000000042', Name: 'Ramesh', DateOfBirth: '10-Oct-1989', PinCode: 122001, Gender: 'Male' },
  Insured: [{ Name: 'Ramesh', Gender: 'Male', InsuredType: 'Adult', RelationshipWithProposer: 'SELF', DateOfBirth: '10-Oct-1989', Weight: 55, HeightsInFeets: 5, HeightsInInches: 4 }],
  PaymentDetails: [{ PaymentDate: '03-Oct-2024', PaymentTransactionId: 'x', Amount: 8641 }],
};

const BASE = '/icici-lombard';

// ═════════════════════════════════════════════════════════════════════════════
heading('A. Crypto + token (ported from authCrypto.test.js)');

await test('encryptPassword produces decryptable AES-128-ECB base64', () => {
  const key = Buffer.from(TEST_AES_KEY, 'base64');
  const enc = encryptPassword('test-password', { aesKey: TEST_AES_KEY, aesMode: 'aes-128-ecb' });
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  const dec = Buffer.concat([decipher.update(Buffer.from(enc, 'base64')), decipher.final()]).toString('utf8');
  eq(dec, 'test-password', 'decrypted password');
});

await test('encryptPassword throws AUTH_ERROR when the key is missing', () => {
  let thrown = null;
  try { encryptPassword('x', { aesKey: undefined }); } catch (error) { thrown = error; }
  assert(thrown, 'no error thrown');
  eq(thrown.code, 'AUTH_ERROR', 'code');
  eq(thrown.provider, 'elevate', 'provider');
});

await test('normalizeEncKey unwraps base64-of-PEM', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  assert(normalizeEncKey(Buffer.from(publicKey, 'utf8').toString('base64')).includes('BEGIN PUBLIC KEY'), 'no PEM header');
});

await test('token is fetched, cached, reused, and refreshed on force', async () => {
  let calls = 0;
  on('POST', '/auth-api/access/token', ({ json }) => {
    calls += 1;
    eq(json.Login, 'test-login-7f3a', 'Login sent');
    assert(json.Password && json.Password !== 'test-password-9c2e', 'password was sent in plaintext');
    return tokenOk();
  });
  const t1 = await getIciciToken();
  const t2 = await getIciciToken();
  eq(t1, t2, 'cached token reused');
  eq(calls, 1, 'token calls after two gets');
  const t3 = await getIciciToken({ force: true });
  assert(t3 !== t1, 'forced refresh returned the old token');
  eq(calls, 2, 'token calls after forced refresh');
  assert(getIciciEncKey().includes('BEGIN PUBLIC KEY'), 'encKey not cached as PEM');
});

await test('unsuccessful token response throws AUTH_ERROR', async () => {
  on('POST', '/auth-api/access/token', () => ({ json: { success: false, errorMessage: 'bad creds', errorCode: 12 } }));
  let thrown = null;
  try { await getIciciToken(); } catch (error) { thrown = error; }
  assert(thrown, 'no error thrown');
  eq(thrown.code, 'AUTH_ERROR', 'code');
  eq(thrown.details, { httpStatus: 200, errorCode: 12, errorMessage: 'bad creds' }, 'details');
});

await test('concurrent callers share ONE in-flight token request', async () => {
  let calls = 0;
  on('POST', '/auth-api/access/token', () => { calls += 1; return { ...tokenOk(), delayMs: 50 }; });
  const [a, b, c] = await Promise.all([getIciciToken(), getIciciToken(), getIciciToken()]);
  eq(calls, 1, 'token calls');
  assert(a === b && b === c, 'callers got different tokens');
});

await test('EL_PASSWORD_PRE_ENCRYPTED=true sends the password verbatim', async () => {
  config.icici.passwordPreEncrypted = true;
  try {
    let sent = null;
    on('POST', '/auth-api/access/token', ({ json }) => { sent = json.Password; return tokenOk(); });
    await getIciciToken();
    eq(sent, 'test-password-9c2e', 'password on the wire');
  } finally {
    config.icici.passwordPreEncrypted = false;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('B. Quote (ported from elAdapter.test.js + envelope contract)');

await test('POST /quote sends Bearer token, defaults ProductCode 18, normalizes premium', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({
    json: {
      BasicPremium: 5988, EmiPremium: 0, TotalPremium: 7065, ZoneName: 'Zone B', TotalTax: 1078,
      TransactionId: BNC, CibilDiscount: 0, Success: true, ErrorCode: 0, CorelationId: 'cid-1',
      Premium: { Loading: [{ CoverName: 'NH', CoverPremium: 714 }], Discount: [{ DiscountName: 'CBS', DiscountAmount: 100 }] },
    },
  }));
  const res = await call('POST', `${BASE}/quote`, QUOTE);
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/health-fresh/elevate/generic/premium');
  assert(/^Bearer jwt-secret-token-/.test(upstream.headers.authorization), 'no Bearer token upstream');
  eq(upstream.json.ProductCode, 18, 'ProductCode defaulted');
  eq(upstream.json.RequestId, 'r1', 'body forwarded');
  const j = res.json;
  eq([j.ok, j.provider, j.operation], [true, 'elevate', 'getQuote'], 'envelope head');
  eq(j.data, {
    transactionId: BNC, basicPremium: 5988, totalTax: 1078, totalPremium: 7065, emiPremium: 0, cibilDiscount: 0,
    zoneName: 'Zone B', loading: [{ coverName: 'NH', coverPremium: 714 }],
    discount: [{ discountName: 'CBS', discountAmount: 100 }], corelationId: 'cid-1',
  }, 'data');
  eq(j.meta, { corelationId: 'cid-1', httpStatus: 200 }, 'meta');
  return `transactionId ${j.data.transactionId}`;
});

await test('iciciRequest is returned beside the envelope with the token masked', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { TotalPremium: 1, TransactionId: BNC, Success: true } }));
  const res = await call('POST', `${BASE}/quote`, QUOTE);
  const ex = res.json.iciciRequest;
  assert(ex, 'no iciciRequest');
  eq(ex.url, `${MOCK}/health-fresh/elevate/generic/premium`, 'exchange url');
  eq(ex.method, 'POST', 'exchange method');
  assert(/^\*\*\*set \(\d+ chars\)\*\*\*$/.test(ex.requestHeaders.Authorization), `Authorization not masked: ${ex.requestHeaders.Authorization}`);
  assert(!JSON.stringify(ex).includes('jwt-secret-token'), 'token appears in the exchange');
});

await test('quote validates required fields → 400 VALIDATION_ERROR, no upstream call', async () => {
  const res = await call('POST', `${BASE}/quote`, { RequestId: 'r1' });
  eq(res.status, 400, 'HTTP status');
  eq(res.json.ok, false, 'ok');
  eq(res.json.error.code, 'VALIDATION_ERROR', 'code');
  eq(res.json.error.provider, null, 'provider (the working implementation left it null)');
  eq(res.json.error.details, { context: 'Elevate premium', missing: ['SumInsured', 'Tenure', 'Insured'] }, 'details');
  eq(received.length, 0, 'upstream requests');
});

await test('quote accepts the sample spelling PinCode, forwarded untouched', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { BasicPremium: 5988, TotalPremium: 7065, TransactionId: 'epn_x', Success: true, ErrorCode: 0 } }));
  const { Pincode, ...rest } = QUOTE;
  const res = await call('POST', `${BASE}/quote`, { ...rest, PinCode: 560062 });
  eq(res.json.data.totalPremium, 7065, 'totalPremium');
  const [upstream] = hits('POST', '/health-fresh/elevate/generic/premium');
  eq(upstream.json.PinCode, 560062, 'PinCode forwarded');
  eq(upstream.json.Pincode, undefined, 'Pincode not invented');
});

await test('quote still rejects when neither pincode spelling is present', async () => {
  const { Pincode, ...rest } = QUOTE;
  const res = await call('POST', `${BASE}/quote`, rest);
  eq(res.status, 400, 'HTTP status');
  assert(/Pincode/.test(res.json.error.message), `message: ${res.json.error.message}`);
});

await test('a request with no body answers 400, as it did under Express 4', async () => {
  const res = await call('POST', `${BASE}/quote`);
  eq(res.status, 400, 'HTTP status');
  eq(res.json.error.code, 'VALIDATION_ERROR', 'code');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('C. Proposal / sync / status — the bnc_ TransactionId');

await test('proposal requires the mandatory nominee fields', async () => {
  const { NomineeName, NomineeDOB, ...rest } = PROPOSAL;
  const res = await call('POST', `${BASE}/proposal`, rest);
  eq(res.status, 400, 'HTTP status');
  assert(/NomineeName, NomineeDOB/.test(res.json.error.message), `message: ${res.json.error.message}`);
});

await test('proposal returns paymentUrl + proposalId; TransactionId reaches ICICI verbatim', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/proposal-payment', () => ({
    json: {
      TransactionId: BNC, PaymentUrl: 'https://pay/x', ProposalId: '3200909705', RequestId: 'r1',
      BasicPremium: 5389, Gst: 0, TotalPremium: 6359, Status: 'NCCN', PfPolicyNo: '4001/4323/5675/0000', Success: true, ErrorCode: 0,
    },
  }));
  const res = await call('POST', `${BASE}/proposal`, PROPOSAL);
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/health-fresh/elevate/generic/proposal-payment');
  eq(upstream.json, PROPOSAL, 'upstream body (forwarded untouched)');
  const d = res.json.data;
  eq([d.transactionId, d.paymentUrl, d.proposalId, d.pfPolicyNo, d.status], [BNC, 'https://pay/x', '3200909705', '4001/4323/5675/0000', 'NCCN'], 'data');
  eq(res.json.operation, 'createProposal', 'operation');
  return `${BNC} → ProposalId ${d.proposalId}`;
});

await test('issue (policy sync) maps status via the Status Master', async () => {
  mockToken();
  on('POST', '/health-servicing/payment/generic/sync', () => ({
    json: { TransactionId: BNC, PolicyNo: '4001/4323/5675/0000', Status: 'NC', StartDate: '2024-06-09T08:31:45Z', EndDate: '2025-06-08T08:31:45Z', Success: true, ErrorCode: 0 },
  }));
  const res = await call('POST', `${BASE}/issue`, {
    RequestId: 'r1', TransactionId: BNC, PaymentDetails: [{ PaymentDate: '03-Oct-2024', PaymentTransactionId: 'x', Amount: 8641 }],
  });
  const d = res.json.data;
  eq([d.policyNo, d.status, d.statusDescription, d.transactionId], ['4001/4323/5675/0000', 'NC', 'Policy generated', BNC], 'data');
  eq(hits('POST', '/health-servicing/payment/generic/sync')[0].json.TransactionId, BNC, 'upstream TransactionId');
});

await test('policy/status reads ProposalStatus/PaymentStatus/PolicyStatus (UAT shape)', async () => {
  mockToken();
  on('POST', '/health-servicing/proposal/generic/status', () => ({
    json: { TransactionId: BNC, PolicyNo: '4001/X', ProposalStatus: 'NC', PolicyStatus: 'ACTIVE', PaymentStatus: 'Paid', Success: true },
  }));
  const res = await call('POST', `${BASE}/policy/status`, { TransactionId: BNC, RequestId: 'r2' });
  const d = res.json.data;
  eq(
    [d.transactionId, d.policyNo, d.paymentStatus, d.proposalStatus, d.policyStatus, d.status, d.statusDescription],
    [BNC, '4001/X', 'Paid', 'NC', 'ACTIVE', 'NC', 'Policy generated'],
    'data'
  );
  eq(res.json.operation, 'policyStatus', 'operation');
});

await test('business error (Success:false) becomes 502 UPSTREAM_ERROR with ICICI\'s wording', async () => {
  mockToken();
  on('POST', '/health-servicing/proposal/generic/status', () => ({ json: { Success: false, ErrorMessage: 'not found', ErrorCode: 404 } }));
  const res = await call('POST', `${BASE}/policy/status`, { TransactionId: 't', RequestId: 'r' });
  eq(res.status, 502, 'HTTP status');
  eq(res.json.error.code, 'UPSTREAM_ERROR', 'code');
  eq(res.json.error.provider, 'elevate', 'provider');
  eq(res.json.error.message, 'Elevate policyStatus failed: not found', 'message');
  eq(res.json.error.details.errorCode, 404, 'details.errorCode');
  assert(res.json.iciciRequest?.responseStatus === 200, 'failure exchange missing');
});

await test('401 triggers one token refresh then succeeds', async () => {
  mockToken();
  on('POST', '/health-servicing/proposal/generic/status',
    () => ({ status: 401, json: { message: 'expired' } }),
    () => ({ json: { TransactionId: 't', PolicyNo: 'P1', Status: 'NC', Success: true, ErrorCode: 0 } }));
  const res = await call('POST', `${BASE}/policy/status`, { TransactionId: 't', RequestId: 'r' });
  eq(res.status, 200, 'HTTP status');
  eq(res.json.data.policyNo, 'P1', 'policyNo');
  eq(hits('POST', '/auth-api/access/token').length, 2, 'token calls (initial + forced refresh)');
});

await test('non-2xx answer → 502 UPSTREAM_ERROR "returned HTTP n"', async () => {
  mockToken();
  on('POST', '/health-servicing/proposal/generic/status', () => ({ status: 400, json: { title: 'Bad Request' } }));
  const res = await call('POST', `${BASE}/policy/status`, { TransactionId: 't', RequestId: 'r' });
  eq(res.status, 502, 'HTTP status');
  eq(res.json.error.message, 'Elevate policyStatus returned HTTP 400', 'message');
  eq(res.json.error.details.httpStatus, 400, 'details.httpStatus');
});

await test('HTTP 503 is retried (EL_MAX_RETRIES) and the retry succeeds', async () => {
  mockToken();
  on('POST', '/Generic/Health/Zone',
    () => ({ status: 503, json: {} }),
    () => ({ json: { PinCode: '400069', Zone: 'Zone I', Success: true } }));
  const res = await call('POST', `${BASE}/zone`, { PinCode: '400069', IssuanceSystem: 'Artemis', ProductCode: '4225' });
  eq(res.status, 200, 'HTTP status');
  eq(hits('POST', '/Generic/Health/Zone').length, 2, 'upstream attempts');
});

await test('HTTP 503 on every attempt → 502 "Upstream returned 503"', async () => {
  mockToken();
  on('POST', '/Generic/Health/Zone', () => ({ status: 503, json: {} }));
  const res = await call('POST', `${BASE}/zone`, { PinCode: '400069', IssuanceSystem: 'Artemis', ProductCode: '4225' });
  eq(res.status, 502, 'HTTP status');
  eq(res.json.error.message, 'Upstream returned 503', 'message');
  eq(res.json.error.details, { status: 503 }, 'details');
  eq(hits('POST', '/Generic/Health/Zone').length, 2, 'upstream attempts (1 + EL_MAX_RETRIES)');
});

await test('an upstream that never answers → 504 TIMEOUT_ERROR', async () => {
  const saved = config.timeouts.icici;
  config.timeouts.icici = 150;
  try {
    mockToken();
    on('POST', '/Generic/Health/Zone', () => ({ delayMs: 600, json: {} }));
    const res = await call('POST', `${BASE}/zone`, { PinCode: '400069', IssuanceSystem: 'Artemis', ProductCode: '4225' });
    eq(res.status, 504, 'HTTP status');
    eq(res.json.error.code, 'TIMEOUT_ERROR', 'code');
    eq(res.json.error.message, '[elevate] zone timed out after 150ms', 'message');
  } finally {
    config.timeouts.icici = saved;
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('D. Servicing: zone, EMI');

await test('zone lookup normalizes response', async () => {
  mockToken();
  on('POST', '/Generic/Health/Zone', () => ({
    json: { PinCode: '400069', StateId: 55, StateName: 'MAHARASHTRA', CityDistrictId: 444301, CityDistrictName: 'MUMBAI SUBURBAN', Zone: 'Zone I', Success: true, StatusCode: 0 },
  }));
  const res = await call('POST', `${BASE}/zone`, { PinCode: '400069', IssuanceSystem: 'Artemis', ProductCode: '4225' });
  eq([res.json.data.zone, res.json.data.stateName, res.json.data.cityDistrictId], ['Zone I', 'MAHARASHTRA', 444301], 'data');
});

await test('emi/due returns the installment list', async () => {
  mockToken();
  on('POST', '/health-servicing/emi/generic/getdue', () => ({
    json: { EMIDueDetail: [{ EMINumber: 1, EmiAmount: 2071, EMIStatus: 'Paid', DueDate: '28-May-2024' }], TransactionId: BNC, Success: true, ErrorCode: 0 },
  }));
  const res = await call('POST', `${BASE}/emi/due`, { RequestId: 'r1', TransactionId: BNC });
  eq(res.json.data.emiDueDetail.length, 1, 'list length');
  eq(res.json.data.emiDueDetail[0].EMIStatus, 'Paid', 'EMIStatus');
});

await test('emi/process validates and normalizes', async () => {
  const bad = await call('POST', `${BASE}/emi/process`, { RequestId: 'r1', TransactionId: BNC });
  eq(bad.status, 400, 'missing fields status');
  mockToken();
  on('POST', '/health-servicing/emi/generic/process', () => ({ json: { TransactionId: BNC, PolicyNo: 'P9', EMIAmount: 2071, Success: true } }));
  const res = await call('POST', `${BASE}/emi/process`, {
    RequestId: 'r1', TransactionId: BNC, InstallmentNo: 2, PaymentTransactionId: 'pay-2', EMIAmount: 2071,
  });
  eq([res.json.data.transactionId, res.json.data.policyNo, res.json.data.emiAmount], [BNC, 'P9', 2071], 'data');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('E. Certificate of insurance');

const PDF = Buffer.concat([Buffer.from('%PDF-1.3\n', 'latin1'), crypto.randomBytes(2048)]);

await test('COI answered as a raw PDF → base64 + filename; path carries clientname + bnc_', async () => {
  mockToken();
  on('GET', `/generic/common/customer/novacred/certificate/health/${BNC}`, () => ({ buffer: PDF }));
  const res = await call('GET', `${BASE}/coi/${BNC}`);
  eq(res.status, 200, 'HTTP status');
  const d = res.json.data;
  eq([d.contentType, d.byteLength, d.filename, d.raw], ['application/pdf', PDF.length, `ICICI-COI-${BNC}.pdf`, null], 'data');
  assert(Buffer.from(d.coi, 'base64').equals(PDF), 'PDF bytes corrupted in transit');
  assert(!('iciciRequest' in res.json), 'COI must not echo an exchange');
});

await test('COI answered as the documented JSON shape → base64 from COI', async () => {
  mockToken();
  const b64 = PDF.toString('base64');
  on('GET', `/generic/common/customer/novacred/certificate/health/${BNC}`, () => ({ json: { COI: b64, Status: 'Success' } }));
  const res = await call('GET', `${BASE}/coi/${BNC}`);
  eq([res.json.data.coi === b64, res.json.data.status, res.json.data.byteLength], [true, 'Success', PDF.length], 'data');
});

await test('COI that is neither PDF nor JSON → 502 PARSE_ERROR', async () => {
  mockToken();
  on('GET', `/generic/common/customer/novacred/certificate/health/${BNC}`, () => ({ text: '<html>oops</html>' }));
  const res = await call('GET', `${BASE}/coi/${BNC}`);
  eq(res.status, 502, 'HTTP status');
  eq(res.json.error.code, 'PARSE_ERROR', 'code');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('F. CKYC + OVD');

await test('ckyc validates identifier presence → 400', async () => {
  const res = await call('POST', `${BASE}/ckyc`, { transactionId: 't', dateOfBirth: '29-Oct-2001' });
  eq(res.status, 400, 'HTTP status');
  eq(res.json.error.details, { field: 'panNumber|ckycNumber|aadhaarNumber' }, 'details');
});

await test('ckyc with Aadhaar requires nameAsPerAadhaar and gender → 400', async () => {
  const res = await call('POST', `${BASE}/ckyc`, { transactionId: 't', dateOfBirth: '29-Oct-2001', aadhaarNumber: '123412341234' });
  eq(res.status, 400, 'HTTP status');
  eq(res.json.error.details, { field: 'nameAsPerAadhaar|gender' }, 'details');
});

await test('ckyc succeeds with PAN, maps the request and normalizes fields', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ckyc', () => ({
    json: {
      Name: 'fhgf gft', DOB: '08-Nov-1992', EmailId: 'H***@x.com', PhoneNo: '94****32', Gender: 'F', KycID: 'kyc_abc123',
      PermanentAddress: 'addr', CorrespondenceAddress: 'addr', Success: true, isKycSuccess: true, StatusCode: 0, CorelationId: 'cid',
    },
  }));
  const res = await call('POST', `${BASE}/ckyc`, { transactionId: BNC, dateOfBirth: '29-Oct-2001', panNumber: 'AJAPA9335P' });
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/generic/common/ckyc/generic/health/ckyc');
  eq(upstream.json, {
    TransactionId: BNC, DateOfBirth: '29-Oct-2001', PanNumber: 'AJAPA9335P', CkycNumber: null, AadhaarNumber: null, NameAsPerAadhaar: null, Gender: null,
  }, 'upstream body');
  const d = res.json.data;
  eq([d.isKycSuccess, d.kycId, d.name, d.statusCode], [true, 'kyc_abc123', 'fhgf gft', 0], 'data');
  eq(res.json.meta, { corelationId: 'cid', statusCode: 0 }, 'meta');
  assert(!('iciciRequest' in res.json), 'CKYC must not echo the PAN back in an exchange');
});

await test('ckyc NOT verified (Success:false, StatusCode 451) is a 200 outcome carrying ICICI\'s wording', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ckyc', () => ({
    json: {
      Success: false, StatusCode: 451, DisplayMessage: 'Failed: - Request failed, please retry with alternate KYC options.',
      OVDLink: 'https://ovd.example.test/x', CorelationId: 'cid-2',
    },
  }));
  const res = await call('POST', `${BASE}/ckyc`, { transactionId: BNC, dateOfBirth: '29-Oct-2001', panNumber: 'AJAPA9335P' });
  eq(res.status, 200, 'HTTP status');
  eq(res.json, {
    ok: true,
    provider: 'elevate',
    operation: 'ckyc',
    data: {
      isKycSuccess: false,
      displayMessage: 'Failed: - Request failed, please retry with alternate KYC options.',
      statusCode: 451,
      ovdLink: 'https://ovd.example.test/x',
      name: null, dob: null, emailId: null, phoneNo: null, gender: null, permanentAddress: null, correspondenceAddress: null,
    },
    meta: { corelationId: 'cid-2', statusCode: 451 },
  }, 'envelope');
});

await test('OVD proof types are validated against the right list per field', async () => {
  const a = await call('POST', `${BASE}/ckyc/ovd`, { quoteTransactionId: 't', proofOfIdentityType: 'PAN', proofOfAddressType: 'PAN' });
  eq([a.status, a.json.error.code, a.json.error.details], [400, 'VALIDATION_ERROR', { field: 'proofOfAddressType' }], 'PAN as address proof');
  const b = await call('POST', `${BASE}/ckyc/ovd`, { quoteTransactionId: 't', proofOfIdentityType: 'VOTER', proofOfAddressType: 'VOTER' });
  eq([b.status, b.json.error.details], [400, { field: 'proofOfIdentityType' }], 'VOTER as identity proof');
});

await test('OVD happy path sends multipart with the documented field names', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ovdinitiate', () => ({ json: { isKycSuccess: true, CustomerName: 'SAM', ErrorCode: 0 } }));
  const res = await call('POST', `${BASE}/ckyc/ovd`, {
    quoteTransactionId: BNC, proofOfIdentityType: 'PAN', proofOfAddressType: 'AADHAAR',
    proofOfIdentity: { value: 'identity-bytes', options: { filename: 'pan.pdf' } },
    proofOfAddress: { value: 'address-bytes', options: { filename: 'aadhaar.pdf' } },
  });
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/generic/common/ckyc/generic/health/ovdinitiate');
  assert(/^multipart\/form-data; boundary=/.test(upstream.headers['content-type']), `content-type: ${upstream.headers['content-type']}`);
  const text = upstream.raw.toString('utf8');
  for (const field of ['quoteTransactionId', 'ProofOfIdentityType', 'ProofOfAddressType', 'ProofOfIdentify', 'ProofOfAddress']) {
    assert(text.includes(`name="${field}"`), `multipart field ${field} missing`);
  }
  assert(text.includes(BNC), 'quoteTransactionId value missing');
  eq([res.json.operation, res.json.data.isKycSuccess, res.json.data.customerName], ['ovdInitiate', true, 'SAM'], 'data');
});

await test('ckyc with Aadhaar sends Gender as the kit\'s M/F even when given the word', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ckyc', () => ({
    json: { Success: true, isKycSuccess: true, StatusCode: 0, CorelationId: 'cid-g' },
  }));
  const res = await call('POST', `${BASE}/ckyc`, {
    transactionId: BNC, dateOfBirth: '29-Oct-2001', aadhaarNumber: '987654398765', nameAsPerAadhaar: 'abv dth', gender: 'Female',
  });
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/generic/common/ckyc/generic/health/ckyc');
  eq(upstream.json.Gender, 'F', 'upstream Gender');
});

await test('ckyc with Aadhaar and an unmappable gender → 400', async () => {
  const res = await call('POST', `${BASE}/ckyc`, {
    transactionId: 't', dateOfBirth: '29-Oct-2001', aadhaarNumber: '123412341234', nameAsPerAadhaar: 'x', gender: 'Other',
  });
  eq([res.status, res.json.error.details], [400, { field: 'gender' }], 'status/details');
});

await test('OVD accepts base64 proofs from the SPA and uploads the decoded bytes', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ovdinitiate', () => ({ json: { isKycSuccess: true, Success: true, CustomerName: 'SAM' } }));
  const res = await call('POST', `${BASE}/ckyc/ovd`, {
    quoteTransactionId: BNC, proofOfIdentityType: 'PAN', proofOfAddressType: 'PASSPORT',
    proofOfIdentity: { base64: Buffer.from('%PDF-identity').toString('base64'), filename: 'pan.pdf', contentType: 'application/pdf' },
    proofOfAddress: { base64: Buffer.from('JPEG-address').toString('base64'), filename: 'passport.jpg', contentType: 'image/jpeg' },
  });
  eq(res.status, 200, 'HTTP status');
  const [upstream] = hits('POST', '/generic/common/ckyc/generic/health/ovdinitiate');
  const text = upstream.raw.toString('utf8');
  assert(text.includes('%PDF-identity') && text.includes('JPEG-address'), 'decoded file bytes missing from multipart');
  assert(text.includes('filename="pan.pdf"') && text.includes('Content-Type: image/jpeg'), 'part filename/content-type missing');
  eq(res.json.data.isKycSuccess, true, 'isKycSuccess');
});

await test('OVD without a proof file → 400 naming it', async () => {
  const res = await call('POST', `${BASE}/ckyc/ovd`, {
    quoteTransactionId: BNC, proofOfIdentityType: 'PAN', proofOfAddressType: 'AADHAAR',
    proofOfIdentity: { base64: Buffer.from('x').toString('base64'), filename: 'pan.pdf' },
  });
  eq([res.status, res.json.error.details], [400, { field: 'proofOfAddress' }], 'status/details');
});

await test('OVD documents ICICI decline (Success:false) are a 200 outcome carrying their wording', async () => {
  mockToken();
  on('POST', '/generic/common/ckyc/generic/health/ovdinitiate', () => ({
    json: { isKycSuccess: false, Success: false, ErrorMessage: 'Document not clear', ErrorCode: 1 },
  }));
  const res = await call('POST', `${BASE}/ckyc/ovd`, {
    quoteTransactionId: BNC, proofOfIdentityType: 'PAN', proofOfAddressType: 'AADHAAR',
    proofOfIdentity: { base64: Buffer.from('a').toString('base64'), filename: 'pan.pdf' },
    proofOfAddress: { base64: Buffer.from('b').toString('base64'), filename: 'aadhaar.pdf' },
  });
  eq(res.status, 200, 'HTTP status');
  eq([res.json.data.isKycSuccess, res.json.data.errorMessage], [false, 'Document not clear'], 'data');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('G. Routing, configuration, isolation');

await test('the /health alias serves the same ICICI routes', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { TotalPremium: 7065, TransactionId: BNC, Success: true } }));
  const res = await call('POST', `/health${BASE}/quote`, QUOTE);
  eq(res.status, 200, 'HTTP status');
  eq(res.json.data.transactionId, BNC, 'transactionId');
});

await test('an unknown /icici-lombard path answers the 404 envelope', async () => {
  const res = await call('POST', `${BASE}/does-not-exist`, {});
  eq(res.status, 404, 'HTTP status');
  eq(res.json.status, 'ERROR', 'status field');
});

await test('journeyId in the body is stripped before the payload reaches ICICI', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { TotalPremium: 1, TransactionId: BNC, Success: true } }));
  const res = await call('POST', `${BASE}/quote`, { ...QUOTE, journeyId: '00000000-0000-0000-0000-000000000000' });
  eq(res.status, 200, 'HTTP status');
  eq(hits('POST', '/health-fresh/elevate/generic/premium')[0].json.journeyId, undefined, 'journeyId forwarded');
});

await test('GET /config/test reports readiness without printing a value', async () => {
  const res = await call('GET', `${BASE}/config/test`);
  eq(res.status, 200, 'HTTP status');
  eq(res.json.data.missing, [], 'missing');
  eq(res.json.data.clientNameSet, true, 'clientNameSet');
  for (const secret of ['test-login-7f3a', 'test-password-9c2e', TEST_AES_KEY, 'novacred']) {
    assert(!res.body.includes(secret), `config/test leaked a value (${secret.slice(0, 4)}…)`);
  }
});

await test('unconfigured deployment → 503 CONFIG_ERROR naming the variables, no upstream call', async () => {
  const saved = { ...config.icici };
  Object.assign(config.icici, { baseUrl: undefined, login: undefined, password: undefined, aesKey: null });
  try {
    const q = await call('POST', `${BASE}/quote`, QUOTE);
    eq(q.status, 503, 'quote status');
    eq(q.json.error.code, 'CONFIG_ERROR', 'code');
    eq(q.json.error.message, 'Elevate is not configured. Missing: EL_BASE_URL, EL_LOGIN, EL_PASSWORD, EL_AES_KEY', 'message');
    const t = await call('GET', `${BASE}/config/test`);
    eq([t.status, t.json.data.unconfigured], [503, true], 'config/test');
    eq(received.length, 0, 'upstream requests');
  } finally {
    Object.assign(config.icici, saved);
  }
});

await test('audit writes failing (database down) never fail an ICICI call', async () => {
  mockToken();
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { TotalPremium: 1, TransactionId: BNC, Success: true } }));
  const before = logged.length;
  const res = await call('POST', `${BASE}/quote`, QUOTE);
  eq(res.status, 200, 'HTTP status');
  const lines = logged.slice(before).join('\n');
  assert(/api_transactions write failed|Journey persistence failed/.test(lines), 'audit write was not attempted');
});

await test('other insurers are still mounted and answering', async () => {
  const probes = [
    ['GET', '/healthz'],
    ['GET', '/iffcotokio/config/test'],
    ['GET', '/future-generali/config/test'],
    ['GET', '/health/iffcotokio/config/test'],
    ['GET', '/health/future-generali/config/test'],
  ];
  const statuses = [];
  for (const [method, path] of probes) {
    const res = await call(method, path);
    assert(res.status !== 404, `${method} ${path} answered 404`);
    statuses.push(`${path} ${res.status}`);
  }
  const nb = await call('POST', '/nivabupa/payment/initiate', {});
  eq(nb.status, 400, 'NivaBupa payment/initiate still validates locally');
  return statuses.join(', ');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('H. Logging never leaks credentials');

await test('no password, encrypted password, login or token appears in any log line', () => {
  const all = logged.join('\n');
  const encrypted = encryptPassword('test-password-9c2e', { aesKey: TEST_AES_KEY, aesMode: 'aes-128-ecb' });
  const forbidden = {
    'EL_PASSWORD': 'test-password-9c2e',
    'encrypted password': encrypted,
    'EL_LOGIN': 'test-login-7f3a',
    'bearer token': 'jwt-secret-token',
    'EL_AES_KEY': TEST_AES_KEY,
  };
  for (const [what, value] of Object.entries(forbidden)) {
    assert(!all.includes(value), `${what} appeared in the logs`);
  }
  assert(all.includes(`${MOCK}/health-fresh/elevate/generic/premium`), 'the request URL is not being logged');
  assert(all.includes(`transactionId=${BNC}`), 'the ICICI TransactionId is not being logged');
  return `${logged.length} log lines checked`;
});

// ── Summary ─────────────────────────────────────────────────────────────────

server.closeAllConnections?.();
server.close();
mock.closeAllConnections?.();
mock.close();
await db.closePool().catch(() => undefined);

const failed = results.filter((r) => !r.ok);
out('\n═══════════════════════════════════════════════════════════════════');
out(`  ${results.length - failed.length} passed, ${failed.length} failed`);
for (const f of failed) out(`  ❌ [${f.section}] ${f.name}\n       ${f.error.split('\n')[0]}`);
out('═══════════════════════════════════════════════════════════════════\n');
process.exit(failed.length ? 1 : 0);
