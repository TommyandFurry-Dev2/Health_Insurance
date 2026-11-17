// ─────────────────────────────────────────────────────────────────────────────
// Chola MS × Freecharge (FCPG) — offline test suite.
//
//   npm run test:chola:freecharge
//
// Drives every /chola-ms/freecharge route through the REAL Express app against
// a local mock of Chola's WSO2 gateway — the Freecharge token, crypto/encrypt,
// crypto/decrypt, checkout/txn/status, refund and pay-link APIs, plus the
// product PolicyGeneration / PolicySchedule the issuance rides on. No request
// leaves this machine: every CHOLA_* URL points at the mock before config is
// imported, and the database at a closed port. The payment and proposal stores
// are in-memory fakes with the repositories' rules.
//
// The request bodies asserted are the ones in Chola's "Free Charge APIs"
// Postman collection; the status codes are FCPG's published table.
//
// What it must prove:
//   * the checkout is the collection's encrypt body, and the browser gets
//     { url, POST, clientId, encData } — and a ref, never a payment detail
//   * a payment is decided by txn/status, never by the callback alone
//   * SUCCESS → PolicyGeneration PG_DIRECT with PGID = FCPG's txnReferenceId,
//     exactly once, however many callbacks arrive
//   * failure, pending, amount mismatch, callback/status disagreement,
//     undecryptable and unmatched callbacks each land where they should
//   * a proposal is never paid twice
//   * ops: verify, re-issue, refund, pay link — behind X-Ops-Key
//   * no Freecharge secret or token is ever logged
//
// No test framework: this service has none. Exit 0 = all passed.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

// ── 1. The mock gateway (started before any config is read) ─────────────────

const handlers = new Map();
const received = [];

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

    const list = handlers.get(`${req.method} ${path}`);
    if (!list || list.length === 0) {
      res.writeHead(599, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: `no handler for ${req.method} ${path}` }));
      return;
    }
    const handler = list.length > 1 ? list.shift() : list[0];
    const out = await handler(entry);
    if (out.text !== undefined) {
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

const SECRETS = {
  clientSecret: 'test-product-secret-91aa',
  fcClientSecret: 'test-fc-secret-6b2e',
  fcToken: 'fc-jwt-secret-0c7d',
  productToken: 'chola-jwt-secret-3f18',
  opsKey: 'test-ops-key-5e4c',
};
const MERCHANT = 'MERTEST00001';
const SITE = 'https://site.example.test';
const RETURN_PAGE = `${SITE}/insurance/get-quote/health/chola-return`;
const FALLBACK_PAGE = `${SITE}/fallback/chola-return`;
const CALLBACK = 'https://api.example.test/health/chola-ms/freecharge/return';
const CHECKOUT = 'https://sandbox-axispg.example.test/payment/v1/checkout';
const FC_TOKEN_PATH = '/fc-final/oauth2/token';

Object.assign(process.env, {
  NODE_ENV: 'test',
  CHOLA_BASE_URL: MOCK,
  CHOLA_CLIENT_ID: 'test-product-client',
  CHOLA_CLIENT_SECRET: SECRETS.clientSecret,
  CHOLA_INTERMEDIARY_CODE: 'TEST-INTERMEDIARY-0001',
  CHOLA_TOPUP_PROPOSAL_URL: '',
  CHOLA_CKYC_BASE_URL: '',
  CHOLA_CKYC_PRIVATE_KEY: '',
  CHOLA_PAYMENT_MODE: 'APD', // proves the Freecharge path issues PG_DIRECT whatever this says
  CHOLA_OPS_KEY: SECRETS.opsKey,
  CHOLA_PUBLIC_URL_BASE: '',
  CHOLA_MAX_RETRIES: '1',
  CHOLA_RETRY_BASE_DELAY_MS: '1',
  CHOLA_API_TIMEOUT_MS: '1500',
  CHOLA_POLICY_GENERATION_TIMEOUT_MS: '2500',
  CHOLA_DEBUG: '0',
  CHOLA_CORS_ORIGINS: '*',
  CHOLA_FREECHARGE_BASE_URL: '',
  CHOLA_FREECHARGE_TOKEN_URL: `${MOCK}${FC_TOKEN_PATH}`,
  CHOLA_FREECHARGE_CLIENT_ID: 'test-fc-client',
  CHOLA_FREECHARGE_CLIENT_SECRET: SECRETS.fcClientSecret,
  CHOLA_FREECHARGE_BASIC_AUTH: '',
  CHOLA_FREECHARGE_MERCHANT_ID: MERCHANT,
  CHOLA_FREECHARGE_CHECKOUT_URL: CHECKOUT,
  CHOLA_FREECHARGE_CALLBACK_URL: CALLBACK,
  CHOLA_FREECHARGE_FRONTEND_RETURN_URL: FALLBACK_PAGE,
  CHOLA_FREECHARGE_FRONTEND_RETURN_ORIGINS: SITE,
  NIVABUPA_ALIAS_PREFIX: '/health',
  NIVABUPA_DB_HOST: '127.0.0.1',
  NIVABUPA_DB_PORT: '1',
  NIVABUPA_DB_CONNECT_TIMEOUT_MS: '500',
});
for (const name of [
  'CHOLA_TOKEN_PATH', 'CHOLA_PRODUCT_PATH', 'CHOLA_FREECHARGE_TOKEN_PATH', 'CHOLA_FREECHARGE_ENCRYPT_PATH',
  'CHOLA_FREECHARGE_DECRYPT_PATH', 'CHOLA_FREECHARGE_TXN_STATUS_PATH', 'CHOLA_FREECHARGE_PAYLINK_CREATE_PATH',
  'CHOLA_FREECHARGE_PAYLINK_STATUS_PATH', 'CHOLA_FREECHARGE_REFUND_PATH', 'CHOLA_FREECHARGE_CURRENCY',
]) {
  process.env[name] = '';
}

// ── 3. Capture everything logged ────────────────────────────────────────────

const VERBOSE = process.env.TEST_VERBOSE === '1';
const logged = [];
const original = { log: console.log, warn: console.warn, error: console.error };
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => {
    logged.push(args.map((a) => (typeof a === 'string' ? a : safeStringify(a))).join(' '));
    if (VERBOSE) original[level](...args);
  };
}
function safeStringify(value) {
  try { return JSON.stringify(value); } catch { return String(value); }
}
const out = (...args) => original.log(...args);

// ── 4. The application ──────────────────────────────────────────────────────

const { default: config } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { CHOLA_PRODUCTS } = await import('../src/constants/chola.constants.js');
const { resetCholaToken } = await import('../src/services/cholaAuth.service.js');
const { resetFreechargeToken } = await import('../src/services/cholaFreecharge.service.js');
const issuer = await import('../src/services/cholaPolicyIssuer.service.js');
const payments = await import('../src/services/cholaFreechargePayment.service.js');
const helper = await import('../src/helpers/cholaFreecharge.helper.js');
const { default: db } = await import('../src/db/index.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP_PORT = server.address().port;

function request(method, path, { body, form, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    let payload = null;
    const sent = { ...headers };
    if (form) {
      payload = new URLSearchParams(form).toString();
      sent['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      sent['Content-Type'] = 'application/json';
    }
    if (payload !== null) sent['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port: APP_PORT, method, path, headers: sent }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, body: text, json });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const call = (method, path, body, opts = {}) => request(method, path, { ...opts, body });
const ops = (method, path, body) => call(method, path, body, { headers: { 'X-Ops-Key': SECRETS.opsKey } });

// ── 5. Runner and fakes ─────────────────────────────────────────────────────

const results = [];
let section = '';

function heading(name) {
  section = name;
  out(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}

/** In-memory health_chola_freecharge_payments, with the repository's rules (amounts as DECIMAL strings). */
function fakePaymentStore() {
  const rows = [];
  const find = (pred) => rows.find(pred);
  const copy = (row) => (row ? { ...row } : null);
  const s = { rows };
  s.insertPayment = async (p) => {
    if (s.failInsert) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    rows.push({
      id: rows.length + 1,
      merchant_txn_id: p.merchantTxnId,
      return_token: p.returnToken,
      gencon_proposal_number: String(p.genconProposalNumber),
      product: p.product,
      amount: Number(p.amount).toFixed(2),
      currency: p.currency,
      frontend_return_url: p.frontendReturnUrl ?? null,
      status: p.status,
      status_code: null,
      status_message: null,
      txn_reference_id: null,
      paid_amount: null,
      txn_mode: null,
      txn_sub_mode: null,
      callback_count: 0,
      callback_body: null,
      callback_decrypted: null,
      status_response: null,
      last_checked_at: null,
      issue_status: null,
      gencon_policy_number: null,
      issue_message: null,
      refund_txn_id: null,
      refund_status_code: null,
      refund_status_message: null,
      refund_response: null,
    });
    return rows.length;
  };
  s.findByMerchantTxnId = async (id) => copy(find((r) => r.merchant_txn_id === String(id)));
  s.findByToken = async (t) => copy(find((r) => r.return_token === String(t)));
  s.findDetail = s.findByMerchantTxnId;
  s.listForProposal = async (no) => rows.filter((r) => r.gencon_proposal_number === String(no)).map(copy);
  s.listPayments = async () => rows.map(copy);
  s.recordCallback = async (id, { body, decrypted }) => {
    const r = find((x) => x.merchant_txn_id === id);
    r.callback_count += 1;
    r.callback_body = JSON.stringify(body);
    r.callback_decrypted = decrypted == null ? null : JSON.stringify(decrypted);
    return 1;
  };
  s.recordVerification = async (id, v) => {
    const r = find((x) => x.merchant_txn_id === id);
    Object.assign(r, {
      status: v.status,
      status_code: v.statusCode ?? null,
      status_message: v.statusMessage ?? null,
      txn_reference_id: v.txnReferenceId ?? r.txn_reference_id,
      paid_amount: v.paidAmount != null ? Number(v.paidAmount).toFixed(2) : r.paid_amount,
      txn_mode: v.txnMode ?? r.txn_mode,
      txn_sub_mode: v.txnSubMode ?? r.txn_sub_mode,
      status_response: v.statusResponse != null ? JSON.stringify(v.statusResponse) : r.status_response,
      last_checked_at: new Date(),
    });
    return 1;
  };
  s.claimIssue = async (id, { retry = false } = {}) => {
    const r = find((x) => x.merchant_txn_id === id);
    if (!r || r.status !== 'SUCCESS') return false;
    if (r.issue_status === null || (retry && r.issue_status === 'ISSUE_FAILED')) {
      r.issue_status = 'IN_PROGRESS';
      r.issue_message = null;
      return true;
    }
    return false;
  };
  s.recordIssue = async (id, { issueStatus, policyNumber = null, message = null }) => {
    const r = find((x) => x.merchant_txn_id === id);
    Object.assign(r, { issue_status: issueStatus, gencon_policy_number: policyNumber ?? r.gencon_policy_number, issue_message: message });
    return 1;
  };
  s.recordRefund = async (id, { refundTxnId, statusCode = null, statusMessage = null, response = null }) => {
    const r = find((x) => x.merchant_txn_id === id);
    Object.assign(r, {
      refund_txn_id: refundTxnId, refund_status_code: statusCode, refund_status_message: statusMessage, refund_response: JSON.stringify(response),
    });
    return 1;
  };
  return s;
}

/** In-memory health_chola_proposals + logs, with chola.repository's claim rules. */
function fakeProposalStore() {
  const s = { logs: [], proposals: new Map() };
  s.insertPolicyGenerationLog = async (entry) => { s.logs.push(entry); return s.logs.length; };
  s.claimForPolicyGeneration = async ({ genconProposalNumber: no, ...rest }) => {
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
  s.recordSchedule = async (no, schedule) => { s.proposals.get(no).schedule = schedule; return 1; };
  s.findProposal = async (no) => {
    const p = s.proposals.get(no);
    return p ? { status: p.status, gencon_policy_number: p.genconPolicyNumber ?? null } : null;
  };
  s.listProposals = async () => [];
  s.listPolicyGenerationLogs = async () => s.logs;
  s.findPolicyPdf = async () => null;
  return s;
}

let store = null;
let proposals = null;

async function test(name, fn) {
  resetMock();
  resetCholaToken();
  resetFreechargeToken();
  config.env = 'test';
  config.chola.paymentMode = 'APD';
  config.chola.opsKey = SECRETS.opsKey;
  store = fakePaymentStore();
  proposals = fakeProposalStore();
  const restorePayments = payments.setCholaFreechargeDependencies({ store });
  const restoreIssuer = issuer.setCholaIssuerDependencies({ store: proposals, fetchPdf: async () => Buffer.from('%PDF-1.4 t') });
  try {
    const detail = await fn();
    await payments.whenIssuanceSettled();
    results.push({ section, name, ok: true });
    out(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    await payments.whenIssuanceSettled();
    results.push({ section, name, ok: false, error: error.message });
    out(`  ❌ ${name}`);
    out(`       ${String(error.message).split('\n').join('\n       ')}`);
  } finally {
    restorePayments();
    restoreIssuer();
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

// ── 6. Fixtures ─────────────────────────────────────────────────────────────

const BASE = '/chola-ms';
const FC = '/endpoint/free-charge/v1';
const ENCRYPT = `${FC}/crypto/encrypt`;
const DECRYPT = `${FC}/crypto/decrypt`;
const STATUS = `${FC}/checkout/txn/status`;
const REFUND = `${FC}/refund`;
const PAYLINK = `${FC}/paylinkqr/create`;
const PAYLINK_STATUS = `${FC}/payment/link/status`;
const PG = `/endpoint/${CHOLA_PRODUCTS.FLEXI_HEALTH.path}/v1.0.0/PolicyGeneration`;
const SCHEDULE = `/endpoint/${CHOLA_PRODUCTS.FLEXI_HEALTH.path}/v1.0.0/PolicySchedule`;

const PROPOSAL = '2890476880887';
const POLICY = '2890/00175370/000/00';
const AMOUNT = 8856.4;
const ENC = 'eyJhbGciOiJSUzI1NiJ9.ZW5jcnlwdGVk.c2lnbmVk';     // JWS-shaped, as FCPG's encData
const CB_ENC = 'eyJhbGciOiJSUzI1NiJ9.Y2FsbGJhY2s.c2lnbmVk';
const TXN_REF = '4325fedd1075002';

/** Real WSO2 refusal the product client got on every /free-charge path (UAT, 2026-11-17). */
const WSO2_900908 = {
  code: '900908', message: 'Resource forbidden ', description: 'User is NOT authorized to access the Resource. API Subscription validation failed.',
};

function mockFcToken(token = SECRETS.fcToken) {
  on('POST', FC_TOKEN_PATH, () => ({ json: { access_token: token, token_type: 'Bearer', expires_in: 3600, scope: 'default' } }));
}
function mockProductToken() {
  on('POST', '/oauth2/token', () => ({ json: { access_token: SECRETS.productToken, expires_in: 3600 } }));
}
function mockEncrypt() {
  on('POST', ENCRYPT, () => ({ json: { clientId: MERCHANT, encData: ENC } }));
}
/** FCPG's documented txn/status / callback body. */
function fcpgBody(merchantTxnId, { code = 'SPG-0000', message = 'SUCCESS', amount = AMOUNT, ref = TXN_REF } = {}) {
  return {
    statusCode: code,
    statusMessage: message,
    data: {
      merchantTxnId, merchantOrderId: PROPOSAL, txnReferenceId: ref, txnType: 'PAY', txnMode: 'UPI', txnSubMode: 'INTENT', amount, currency: 'INR',
    },
  };
}
function mockIssuance({ pg = { Status: 'Success', PolicyNumber: POLICY, Errormessage: '', URL: '' } } = {}) {
  mockProductToken();
  on('POST', PG, () => ({ json: pg }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: '', CISScheduleURL: '' } }));
}

async function checkout(body = {}) {
  mockFcToken();
  mockEncrypt();
  const r = await call('POST', `${BASE}/freecharge/initiate`, {
    product: 'FLEXI_HEALTH', GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE, ...body,
  });
  assert(r.status === 200, `initiate answered ${r.status}: ${r.body}`);
  return r.json.data;
}

/** FCPG returning the buyer: a form POST of { clientId, encData } to callbackUrl?ref=…. */
function callback(ref, fields = { clientId: MERCHANT, encData: CB_ENC }) {
  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  return request('POST', `${BASE}/freecharge/return${query}`, { form: fields });
}

const row = () => store.rows[store.rows.length - 1];

// ═════════════════════════════════════════════════════════════════════════════
heading('A. Configuration and the Freecharge token');

await test('an unconfigured Freecharge leg answers 503 naming what is missing, and calls nobody', async () => {
  const saved = { ...config.chola.freecharge };
  Object.assign(config.chola.freecharge, { merchantId: null, checkoutUrl: null });
  try {
    const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
    eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], 'error');
    assert(/CHOLA_FREECHARGE_MERCHANT_ID/.test(r.json.error.message) && /CHOLA_FREECHARGE_CHECKOUT_URL/.test(r.json.error.message), r.json.error.message);
    eq(received.length, 0, 'upstream calls');
    eq(store.rows.length, 0, 'rows');
  } finally {
    Object.assign(config.chola.freecharge, saved);
  }
});

await test('config/test reports the Freecharge leg without printing a credential', async () => {
  const r = await call('GET', `${BASE}/config/test`);
  const fc = r.json.data.freecharge;
  eq([fc.configured, fc.tokenUrlSet, fc.merchantIdSet, fc.missing], [true, true, true, []], 'freecharge block');
  eq(fc.tokenUrl, `${MOCK}${FC_TOKEN_PATH}`, 'token URL (the configurable one)');
  assert(!r.body.includes(SECRETS.fcClientSecret) && !r.body.includes(MERCHANT), 'a credential or the merchant id was printed');
});

await test('the token comes from CHOLA_FREECHARGE_TOKEN_URL with the Freecharge client, not the product one', async () => {
  await checkout();
  const [t] = hits('POST', FC_TOKEN_PATH);
  eq(t.headers.authorization, `Basic ${Buffer.from(`test-fc-client:${SECRETS.fcClientSecret}`).toString('base64')}`, 'Basic header');
  eq(t.raw.toString('utf8'), 'grant_type=client_credentials', 'form body');
  eq(hits('POST', '/oauth2/token').length, 0, 'product token calls');
  eq(hits('POST', ENCRYPT)[0].headers.authorization, `Bearer ${SECRETS.fcToken}`, 'bearer on encrypt');
});

await test('CHOLA_FREECHARGE_BASIC_AUTH, as Chola issued it, wins over the id/secret pair', async () => {
  const saved = config.chola.freecharge.basicAuth;
  config.chola.freecharge.basicAuth = 'Basic aXNzdWVkOmtleQ==';
  try {
    await checkout();
    eq(hits('POST', FC_TOKEN_PATH)[0].headers.authorization, 'Basic aXNzdWVkOmtleQ==', 'Basic header');
  } finally {
    config.chola.freecharge.basicAuth = saved;
  }
});

await test('with no token URL set, the token is minted at the base URL\'s /oauth2/token', async () => {
  const saved = config.chola.freecharge.tokenUrl;
  config.chola.freecharge.tokenUrl = null;
  config.chola.freecharge.baseUrl = MOCK;
  try {
    on('POST', '/oauth2/token', () => ({ json: { access_token: SECRETS.fcToken, expires_in: 3600 } }));
    mockEncrypt();
    const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
    eq(r.status, 200, 'status');
    eq(hits('POST', '/oauth2/token').length, 1, 'token at the base URL');
  } finally {
    config.chola.freecharge.tokenUrl = saved;
  }
});

await test('WSO2\'s 900908 subscription refusal → 502 AUTH_ERROR with Chola\'s own sentence; the row is freed', async () => {
  mockFcToken();
  on('POST', ENCRYPT, () => ({ status: 403, json: WSO2_900908 }));
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq([r.status, r.json.error.code], [502, 'AUTH_ERROR'], 'error');
  assert(/API Subscription validation failed/.test(r.json.error.message), r.json.error.message);
  eq(row().status, 'FAILED', 'row status (does not block the next attempt)');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('B. Checkout (POST /chola-ms/freecharge/initiate)');

await test('encrypts exactly the collection\'s fields and hands the browser a POST form', async () => {
  const d = await checkout();
  const sent = hits('POST', ENCRYPT)[0].json;
  eq(Object.keys(sent).sort(), ['callbackUrl', 'currency', 'merchantId', 'merchantOrderId', 'merchantTxnAmount', 'merchantTxnId', 'timestamp'], 'encrypt body keys');
  eq([sent.merchantId, sent.merchantTxnAmount, sent.merchantOrderId, sent.currency], [MERCHANT, '8856.40', PROPOSAL, 'INR'], 'encrypt body values');
  assert(/^\d{10}$/.test(sent.timestamp), `timestamp is epoch seconds: ${sent.timestamp}`);
  assert(/^[a-zA-Z0-9_-]{1,30}$/.test(sent.merchantTxnId), `merchantTxnId fits FCPG's rule: ${sent.merchantTxnId}`);
  eq(sent.callbackUrl, `${CALLBACK}?ref=${d.ref}`, 'callbackUrl carries our ref');
  eq(d.checkout, { url: CHECKOUT, method: 'POST', fields: { clientId: MERCHANT, encData: ENC } }, 'checkout form');
  eq([d.merchantTxnId, d.amount, d.genconProposalNumber], [sent.merchantTxnId, AMOUNT, PROPOSAL], 'answer');
  eq([row().status, row().frontend_return_url, row().amount], ['INITIATED', RETURN_PAGE, '8856.40'], 'row written');
});

await test('a return page off the allowed origins, or not a /chola-return page, is refused before anything is sent', async () => {
  for (const bad of [undefined, 'https://evil.example.test/insurance/get-quote/health/chola-return', `${SITE}/insurance/get-quote/health/fg-return`, `${RETURN_PAGE}?x=1`]) {
    const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: bad });
    eq([r.status, r.json.error.code], [400, 'VALIDATION_ERROR'], `refused ${bad}`);
  }
  eq([received.length, store.rows.length], [0, 0], 'nothing sent, nothing written');
});

await test('missing proposal number or a non-positive amount is a 400', async () => {
  for (const body of [{ Amount: AMOUNT }, { GenconProposalNumber: PROPOSAL, Amount: 0 }, { GenconProposalNumber: PROPOSAL, Amount: 'x' }]) {
    const r = await call('POST', `${BASE}/freecharge/initiate`, { ...body, frontendReturnUrl: RETURN_PAGE });
    eq(r.status, 400, JSON.stringify(body));
  }
});

await test('FCPG refusing the checkout (statusCode, no encData) → 502 with their sentence', async () => {
  mockFcToken();
  on('POST', ENCRYPT, () => ({ json: { statusCode: 'SPG-0010', statusMessage: 'Invalid request field[s]' } }));
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq([r.status, r.json.error.code], [502, 'UPSTREAM_ERROR'], 'error');
  assert(/Invalid request field/.test(r.json.error.message), r.json.error.message);
  eq(row().status, 'FAILED', 'row freed');
});

await test('no row can be written → no checkout (fails closed)', async () => {
  store.failInsert = true;
  mockFcToken();
  mockEncrypt();
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq(r.status, 500, 'status');
  eq(hits('POST', ENCRYPT).length, 0, 'encrypt calls');
});

await test('an earlier paid checkout refuses a second one', async () => {
  const first = await checkout();
  store.rows[0].status = 'SUCCESS';
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq([r.status, r.json.error.details.paymentStatus, r.json.error.details.merchantTxnId], [400, 'SUCCESS', first.merchantTxnId], 'refused');
  eq(hits('POST', ENCRYPT).length, 1, 'encrypt calls');
});

await test('an abandoned earlier checkout (SPG-0025) is settled FAILED and a new one starts', async () => {
  const first = await checkout();
  on('POST', STATUS, () => ({ json: { statusCode: 'SPG-0025', statusMessage: 'Transaction does not exist' } }));
  const second = await checkout();
  eq(hits('POST', STATUS)[0].json, { merchantId: MERCHANT, merchantTxnId: first.merchantTxnId }, 'status asked about the first');
  eq([store.rows[0].status, store.rows[1].status], ['FAILED', 'INITIATED'], 'rows');
  assert(first.merchantTxnId !== second.merchantTxnId && first.ref !== second.ref, 'fresh ids');
});

await test('an earlier checkout still pending refuses a second payment', async () => {
  await checkout();
  on('POST', STATUS, () => ({ json: { statusCode: 'SPG-5218', statusMessage: 'Transaction Pending at Bank end' } }));
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq([r.status, r.json.error.details.paymentStatus], [400, 'PENDING'], 'refused');
  assert(/not confirmed yet/.test(r.json.error.message), r.json.error.message);
});

await test('an earlier checkout that turns out paid refuses, and starts its issuance', async () => {
  const first = await checkout();
  on('POST', STATUS, () => ({ json: fcpgBody(first.merchantTxnId) }));
  mockIssuance();
  const r = await call('POST', `${BASE}/freecharge/initiate`, { GenconProposalNumber: PROPOSAL, Amount: AMOUNT, frontendReturnUrl: RETURN_PAGE });
  eq([r.status, r.json.error.details.paymentStatus], [400, 'SUCCESS'], 'refused');
  await payments.whenIssuanceSettled();
  eq([store.rows[0].issue_status, store.rows[0].gencon_policy_number], ['POLICY_ISSUED', POLICY], 'issued from the late discovery');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('C. Callback, verification and issuance');

await test('SUCCESS: decrypt → txn/status → 303 to the page with only the ref → PolicyGeneration PG_DIRECT', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();

  const r = await callback(d.ref);
  eq(r.status, 303, 'redirect status');
  eq(r.headers.location, `${RETURN_PAGE}?ref=${d.ref}`, 'redirect target');
  eq(hits('POST', DECRYPT)[0].json, { clientId: MERCHANT, encData: CB_ENC }, 'decrypt body (the collection\'s)');
  eq(hits('POST', STATUS)[0].json, { merchantId: MERCHANT, merchantTxnId: d.merchantTxnId, txnReferenceId: TXN_REF }, 'txn/status body (the collection\'s)');

  await payments.whenIssuanceSettled();
  const [pg] = hits('POST', PG);
  eq([pg.json.GenconProposalNumber, pg.json.TaggingMode, pg.json.PayMode, pg.json.PGID, pg.json.Amount, pg.json.BankName],
    [PROPOSAL, 'PG', 'Direct', TXN_REF, '8856.4', '3719'], 'PolicyGeneration (PG_DIRECT, despite CHOLA_PAYMENT_MODE=APD)');
  eq(proposals.logs[0].source, 'freecharge', 'evidence logged as freecharge');

  const res = (await call('GET', `${BASE}/freecharge/result/${d.ref}`)).json.data;
  eq([res.paymentStatus, res.issueStatus, res.genconPolicyNumber, res.txnReferenceId, res.amount], ['SUCCESS', 'POLICY_ISSUED', POLICY, TXN_REF, AMOUNT], 'result');
  assert(!JSON.stringify(res).includes(CB_ENC), 'result leaks the callback body');
});

await test('the callback alone is never trusted: callback SUCCESS, txn/status FAILED → NEEDS_REVIEW, no policy', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-0001', message: 'FAILED' }) }));
  mockIssuance();
  await callback(d.ref);
  eq([row().status, row().issue_status], ['NEEDS_REVIEW', null], 'row');
  eq(hits('POST', PG).length, 0, 'PolicyGeneration calls');
});

await test('paid amount ≠ premium → NEEDS_REVIEW, no policy', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId, { amount: 1 }) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId, { amount: 1 }) }));
  mockIssuance();
  await callback(d.ref);
  eq(row().status, 'NEEDS_REVIEW', 'status');
  assert(/collected 1\.00, but the premium is 8856\.40/.test(row().status_message), row().status_message);
  eq(hits('POST', PG).length, 0, 'PolicyGeneration calls');
});

await test('cancelled by the buyer (SPG-0150) → FAILED, no policy, sent back to the page', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-0150', message: 'Transaction cancelled by the user' }) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-0150', message: 'Transaction cancelled by the user' }) }));
  const r = await callback(d.ref);
  eq([r.status, r.headers.location], [303, `${RETURN_PAGE}?ref=${d.ref}`], 'redirect');
  const res = (await call('GET', `${BASE}/freecharge/result/${d.ref}`)).json.data;
  eq([res.paymentStatus, res.statusCode, res.issueStatus], ['FAILED', 'SPG-0150', null], 'result');
  eq(hits('POST', PG).length, 0, 'PolicyGeneration calls');
});

await test('pending at the bank → PENDING; "check again" after FCPG confirm → SUCCESS and issued', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-5218', message: 'Transaction Pending at Bank end' }) }));
  on('POST', STATUS,
    () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-5218', message: 'Transaction Pending at Bank end' }) }),
    () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  await callback(d.ref);
  eq(row().status, 'PENDING', 'after the callback');

  const again = await call('POST', `${BASE}/freecharge/status`, { ref: d.ref });
  eq([again.status, again.json.data.paymentStatus, again.json.data.issueStatus], [200, 'SUCCESS', 'IN_PROGRESS'], 'check again');
  await payments.whenIssuanceSettled();
  eq([row().issue_status, row().gencon_policy_number], ['POLICY_ISSUED', POLICY], 'issued');
});

await test('a request-level refusal on txn/status (SPG-0010) is "not confirmed", never FAILED', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: { statusCode: 'SPG-0010', statusMessage: 'Invalid request field[s]' } }));
  await callback(d.ref);
  eq(row().status, 'PENDING', 'status');
});

await test('txn/status unreachable → PENDING, not paid and not failed', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  // No STATUS handler: the mock answers 599 with no statusCode.
  await callback(d.ref);
  eq(row().status, 'PENDING', 'status');
  assert(/could not be asked/.test(row().status_message), row().status_message);
});

await test('an undecryptable callback is still matched by its ref and decided by txn/status', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ status: 500, text: 'Internal Server Error' }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  const r = await callback(d.ref);
  eq(r.headers.location, `${RETURN_PAGE}?ref=${d.ref}`, 'redirect');
  eq(hits('POST', STATUS)[0].json, { merchantId: MERCHANT, merchantTxnId: d.merchantTxnId }, 'status asked without a txnReferenceId');
  eq(row().status, 'SUCCESS', 'status');
  eq(JSON.parse(row().callback_body).encData, CB_ENC, 'raw callback kept for re-decryption');
});

await test('a callback naming another transaction on this ref is recorded, not acted on', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody('NCOTHER-TXN') }));
  mockIssuance();
  await callback(d.ref);
  eq(row().status, 'NEEDS_REVIEW', 'status');
  eq([hits('POST', STATUS).length, hits('POST', PG).length], [0, 0], 'no status check, no policy');
});

await test('a callback matching no payment → 303 to the fallback page with error=callback', async () => {
  on('POST', DECRYPT, () => ({ json: fcpgBody('NCUNKNOWN-TXN') }));
  const r = await callback(null);
  eq([r.status, r.headers.location], [303, `${FALLBACK_PAGE}?error=callback`], 'redirect');
});

await test('a GET callback (query string only) is handled the same way', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  const r = await request('GET', `${BASE}/freecharge/return?ref=${d.ref}&clientId=${MERCHANT}&encData=${CB_ENC}`);
  eq([r.status, row().status], [303, 'SUCCESS'], 'handled');
});

await test('repeated callbacks after success issue the policy exactly once', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  await Promise.all([callback(d.ref), callback(d.ref), callback(d.ref)]);
  await payments.whenIssuanceSettled();
  await callback(d.ref);
  await call('POST', `${BASE}/freecharge/status`, { ref: d.ref });
  await payments.whenIssuanceSettled();
  eq(hits('POST', PG).length, 1, 'PolicyGeneration calls');
  eq(row().callback_count, 4, 'callbacks recorded');
});

await test('the /health alias serves the callback (the URL a deployed build registers)', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-0001', message: 'FAILED' }) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId, { code: 'SPG-0001', message: 'FAILED' }) }));
  const r = await request('POST', `/health${BASE}/freecharge/return?ref=${d.ref}`, { form: { clientId: MERCHANT, encData: CB_ENC } });
  eq([r.status, row().status], [303, 'FAILED'], 'handled under /health');
});

await test('an unknown ref → 404, with "do NOT pay again"', async () => {
  const r = await call('GET', `${BASE}/freecharge/result/deadbeef`);
  eq([r.status, r.json.error.code], [404, 'NOT_FOUND'], 'status');
  assert(/do NOT pay again/.test(r.json.error.message), r.json.error.message);
});

await test('Chola refusing PolicyGeneration → ISSUE_FAILED; ops re-send issues it', async () => {
  const d = await checkout();
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockProductToken();
  on('POST', PG,
    () => ({ json: { Status: 'Failure', Errormessage: 'Invalid PGID', PolicyNumber: '' } }),
    () => ({ json: { Status: 'Success', PolicyNumber: POLICY } }));
  on('POST', SCHEDULE, () => ({ json: { CMSScheduleURL: '' } }));
  await callback(d.ref);
  await payments.whenIssuanceSettled();
  eq([row().issue_status, row().issue_message], ['ISSUE_FAILED', 'Invalid PGID'], 'refused');

  const r = await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/issue`);
  eq([r.status, r.json.data.issueStatus, r.json.data.genconPolicyNumber], [200, 'POLICY_ISSUED', POLICY], 'ops re-send');
  eq(hits('POST', PG).length, 2, 'PolicyGeneration calls');
});

await test('a proposal whose PolicyGeneration already went out is mirrored, never sent again', async () => {
  const d = await checkout();
  proposals.proposals.set(PROPOSAL, { status: 'POLICY_ISSUED', genconPolicyNumber: POLICY });
  on('POST', DECRYPT, () => ({ json: fcpgBody(d.merchantTxnId) }));
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  await callback(d.ref);
  await payments.whenIssuanceSettled();
  eq([row().issue_status, row().gencon_policy_number, hits('POST', PG).length], ['POLICY_ISSUED', POLICY, 0], 'mirrored');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('D. Ops: status, refund, pay links');

await test('every ops route needs the X-Ops-Key', async () => {
  for (const [method, path] of [
    ['GET', '/ops/freecharge/payments'], ['GET', '/ops/freecharge/payments/X'], ['POST', '/ops/freecharge/payments/X/status'],
    ['POST', '/ops/freecharge/payments/X/issue'], ['POST', '/ops/freecharge/payments/X/refund'], ['POST', '/ops/freecharge/paylink'],
    ['POST', '/ops/freecharge/paylink/status'],
  ]) {
    eq((await call(method, `${BASE}${path}`, method === 'POST' ? {} : undefined)).status, 401, `${method} ${path}`);
  }
});

await test('ops status re-checks a NEEDS_REVIEW payment and issues once FCPG confirm it', async () => {
  const d = await checkout();
  store.rows[0].status = 'NEEDS_REVIEW';
  on('POST', STATUS, () => ({ json: fcpgBody(d.merchantTxnId) }));
  mockIssuance();
  const r = await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/status`);
  eq([r.status, r.json.data.paymentStatus], [200, 'SUCCESS'], 'reconsidered');
  await payments.whenIssuanceSettled();
  eq(row().issue_status, 'POLICY_ISSUED', 'issued');
});

await test('refund sends the collection\'s body once, for a paid checkout with no policy', async () => {
  const d = await checkout();
  Object.assign(store.rows[0], { status: 'SUCCESS', txn_reference_id: TXN_REF, paid_amount: '8856.40', issue_status: 'ISSUE_FAILED' });
  on('POST', REFUND, () => ({ json: { statusCode: 'SPG-0000', statusMessage: 'SUCCESS' } }));
  const r = await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/refund`, {});
  eq([r.status, r.json.data.refundStatus], [200, 'SUCCESS'], 'refunded');
  const sent = hits('POST', REFUND)[0].json;
  eq(Object.keys(sent).sort(), ['currency', 'merchantId', 'merchantRefundTxnId', 'refundAmount', 'refundType', 'txnReferenceId'], 'refund body keys');
  eq([sent.merchantId, sent.txnReferenceId, sent.refundType, sent.refundAmount, sent.currency], [MERCHANT, TXN_REF, 'OFFLINE', '8856.40', 'INR'], 'refund body');
  assert(/^RF/.test(sent.merchantRefundTxnId) && sent.merchantRefundTxnId.length <= 30, sent.merchantRefundTxnId);

  const again = await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/refund`, {});
  eq(again.status, 400, 'second refund refused');
  eq(hits('POST', REFUND).length, 1, 'refund calls');
});

await test('refund is refused for an issued policy and for more than was collected', async () => {
  const d = await checkout();
  Object.assign(store.rows[0], { status: 'SUCCESS', txn_reference_id: TXN_REF, paid_amount: '8856.40', issue_status: 'POLICY_ISSUED' });
  eq((await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/refund`, {})).status, 400, 'issued');
  store.rows[0].issue_status = 'ISSUE_FAILED';
  eq((await ops('POST', `${BASE}/ops/freecharge/payments/${d.merchantTxnId}/refund`, { refundAmount: 9000 })).status, 400, 'too much');
  eq(hits('POST', REFUND).length, 0, 'refund calls');
});

await test('pay link create and status pass the collection\'s bodies through with the merchant filled in', async () => {
  mockFcToken();
  on('POST', PAYLINK, () => ({
    json: {
      statusCode: 'SPG-0000',
      statusMessage: 'SUCCESS',
      data: {
        entityId: MERCHANT, entityTxnId: 'PL001', payLinkUrl: 'https://sandbox-axispg.freecharge.in/payment/v2/checkout/link?linkId=b1rv55rwsst', expireTime: '2026-08-06 13:43:36',
      },
    },
  }));
  on('POST', PAYLINK_STATUS, () => ({ status: 500, json: { statusCode: 'SPG-0170', statusMessage: 'Link data not found' } }));
  const r = await ops('POST', `${BASE}/ops/freecharge/paylink`, {
    entityTxnId: 'PL001', callbackUrl: 'https://x.example.test/', payLinkName: 'CholaPaylink', amountType: 'VARIABLE', minAmount: 1, maxAmount: '10', linkType: 'PL_LINK',
  });
  eq([r.status, r.json.data.succeeded], [200, true], 'created');
  assert(r.json.data.payLinkUrl.startsWith('https://sandbox-axispg.freecharge.in/'), r.json.data.payLinkUrl);
  const sent = hits('POST', PAYLINK)[0].json;
  eq([sent.entityId, sent.currency, /^\d{10}$/.test(sent.timestamp), sent.entityTxnId], [MERCHANT, 'INR', true, 'PL001'], 'create body');

  const s = await ops('POST', `${BASE}/ops/freecharge/paylink/status`, { entityTxnId: 'PL001' });
  eq([s.status, s.json.data.statusCode], [200, 'SPG-0170'], 'an FCPG answer on HTTP 500 is read, not thrown');
  eq(hits('POST', PAYLINK_STATUS)[0].json, { entityId: MERCHANT, entityTxnId: 'PL001' }, 'status body');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('E. Pure rules');

await test('merchantTxnId: FCPG charset, ≤ 30, unique, proposal readable', () => {
  const ids = new Set(Array.from({ length: 50 }, () => helper.newMerchantTxnId(PROPOSAL)));
  eq(ids.size, 50, 'unique');
  for (const id of ids) assert(/^NC2890476880887-[A-Z0-9]+$/.test(id) && id.length <= 30, id);
  assert(helper.newMerchantTxnId('X'.repeat(40)).length <= 30, 'long proposal truncated');
});

await test('verdicts follow FCPG\'s table; request-level codes and no code are PENDING', () => {
  eq(['SPG-0000', 'SPG-0002', 'SPG-5218', 'SPG-0001', 'SPG-0150', 'SPG-0025', 'SPG-0005', 'SPG-0041', null].map(helper.verdictOf),
    ['SUCCESS', 'PENDING', 'PENDING', 'FAILED', 'FAILED', 'FAILED', 'PENDING', 'PENDING', 'PENDING'], 'verdicts');
});

await test('readEncrypted accepts FCPG\'s envelope, a data wrapper or a bare token — and nothing else', () => {
  eq(helper.readEncrypted({ clientId: 'M', encData: ENC }), { encData: ENC, clientId: 'M' }, 'envelope');
  eq(helper.readEncrypted({ data: { encData: ENC } }).encData, ENC, 'wrapper');
  eq(helper.readEncrypted(ENC).encData, ENC, 'bare');
  for (const bad of [{}, { encData: 'not a token' }, 'Internal error', null]) {
    let threw = false;
    try { helper.readEncrypted(bad); } catch { threw = true; }
    assert(threw, `accepted ${JSON.stringify(bad)}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('F. Logging never leaks a credential');

await test('no Freecharge secret, Basic value or token, and no product secret, was logged', () => {
  const all = logged.join('\n');
  const basic = Buffer.from(`test-fc-client:${SECRETS.fcClientSecret}`).toString('base64');
  for (const [name, value] of [
    ['Freecharge client secret', SECRETS.fcClientSecret], ['Freecharge Basic value', basic], ['issued Basic value', 'aXNzdWVkOmtleQ=='],
    ['Freecharge token', SECRETS.fcToken], ['product secret', SECRETS.clientSecret], ['product token', SECRETS.productToken], ['ops key', SECRETS.opsKey],
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
