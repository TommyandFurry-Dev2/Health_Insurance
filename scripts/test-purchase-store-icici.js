// ─────────────────────────────────────────────────────────────────────────────
// Health purchase store + ICICI Lombard — integration test.
//
//   npm run test:purchase-store
//
// Drives the REAL Express app's /icici-lombard routes against a local mock of
// ICICI's gateway (no request leaves this machine) and checks what lands in the
// health_* tables of a LOCAL MySQL/MariaDB that has migrations 008–014 applied.
//
// It refuses to run unless the database host is 127.0.0.1 / localhost and the
// health tables exist, and it deletes every row it created when it finishes —
// including the rows the existing audit writes to nivabupa_api_transactions for
// the mock's 127.0.0.1 endpoints during the run.
//
// No test framework, like scripts/test-icici.js. Exit 0 = all passed.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import crypto from 'node:crypto';

// ── 1. The mock ICICI gateway ───────────────────────────────────────────────

const handlers = new Map();
function on(method, path, fn) { handlers.set(`${method} ${path}`, fn); }
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const path = decodeURIComponent(req.url.split('?')[0]);
    let json = null;
    try { json = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { json = null; }
    const fn = handlers.get(`${req.method} ${path}`);
    if (!fn) { res.writeHead(599, { 'Content-Type': 'application/json' }); res.end('{"mock":"no handler"}'); return; }
    const out = await fn({ json });
    if (out.buffer) { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(out.buffer); return; }
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ── 2. Environment, pinned before config is read ────────────────────────────

const ENC_KEY_1 = crypto.randomBytes(32).toString('base64');
const HASH_KEY = crypto.randomBytes(32).toString('base64');
Object.assign(process.env, {
  NODE_ENV: 'uat',
  EL_PRODUCTION_ENABLED: 'false',
  EL_BASE_URL: MOCK,
  EL_LOGIN: 'test-login',
  EL_PASSWORD: 'test-password',
  EL_AES_KEY: Buffer.from('0123456789abcdef', 'utf8').toString('base64'),
  EL_AES_MODE: 'aes-128-ecb',
  EL_AES_IV: '',
  EL_PASSWORD_PRE_ENCRYPTED: 'false',
  EL_CLIENT_NAME: 'novacred',
  EL_MAX_RETRIES: '0',
  EL_RETRY_BASE_DELAY_MS: '1',
  EL_API_TIMEOUT_MS: '3000',
  EL_DEBUG: '0',
  EL_CORS_ORIGINS: '*',
  HEALTH_DATA_ENC_KEYS: `1:${ENC_KEY_1}`,
  HEALTH_DATA_HASH_KEY: HASH_KEY,
  HEALTH_STORE_WAIT_MS: '5000',
});
for (const name of [
  'EL_TOKEN_PATH', 'EL_PREMIUM_PATH', 'EL_PROPOSAL_PATH', 'EL_POLICY_SYNC_PATH', 'EL_POLICY_STATUS_PATH',
  'EL_EMI_DUE_PATH', 'EL_EMI_PROCESS_PATH', 'EL_COI_PATH', 'EL_ZONE_PATH', 'EL_CKYC_PATH', 'EL_OVD_INITIATE_PATH',
]) { process.env[name] = ''; }

const VERBOSE = process.env.TEST_VERBOSE === '1';
const original = { log: console.log, warn: console.warn, error: console.error };
const logged = [];
for (const level of ['log', 'warn', 'error']) {
  console[level] = (...args) => { logged.push(args.map(String).join(' ')); if (VERBOSE) original[level](...args); };
}
const out = (...args) => original.log(...args);

// ── 3. The application ──────────────────────────────────────────────────────

const { default: config } = await import('../src/config/env.js');
if (!['127.0.0.1', 'localhost', '::1'].includes(config.db.host)) {
  out(`Refusing to run: database host is ${config.db.host}, not a local database.`);
  process.exit(2);
}
const { createApp } = await import('../src/app.js');
const { default: db } = await import('../src/db/index.js');
const store = await import('../src/services/healthPurchase.service.js');
const { recordIciciCall } = await import('../src/services/iciciPurchaseStore.service.js');
const { runInIciciEnvironment } = await import('../src/helpers/iciciEnvironment.helper.js');
const hc = await import('../src/utils/healthCrypto.js');
const { maskForStore } = await import('../src/helpers/healthMask.helper.js');
const { resetIciciToken } = await import('../src/services/iciciAuth.service.js');

const status = await store.checkPurchaseStoreSchema();
if (!status.enabled) {
  out(`Refusing to run: purchase store is off — ${status.reason}`);
  process.exit(2);
}

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP = server.address().port;

function call(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: APP, method, path,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch { json = null; } resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ── 4. Runner ───────────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  resetIciciToken();
  try {
    const detail = await fn();
    results.push(true);
    out(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push(false);
    out(`  ❌ ${name}\n       ${String(error.stack || error.message).split('\n').slice(0, 4).join('\n       ')}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m); }
function eq(a, e, what) { const x = JSON.stringify(a); const y = JSON.stringify(e); if (x !== y) throw new Error(`${what}\n  expected: ${y}\n  actual:   ${x}`); }
const q = (sql, params = []) => db.query(sql, params);
const one = (sql, params = []) => db.queryOne(sql, params);
// IN (?) with an array needs the text protocol (pool.query), not a prepared statement.
const raw = async (sql, params = []) => (await db.getPool().query(sql, params))[0];

const RUN = Date.now().toString(36);
const RUN_START = new Date(Date.now() - 1000);
const txn = (tag) => `bnc_t${RUN}${tag}`;
const createdPurchaseIds = new Set();
async function track(purchaseRef) {
  const row = await one('SELECT id FROM health_purchases WHERE purchase_ref = ?', [purchaseRef]);
  if (row) createdPurchaseIds.add(row.id);
  return row?.id;
}
async function purchaseOfTxn(t) {
  const row = await one(
    `SELECT p.* FROM health_purchases p JOIN health_icici_kyc k ON k.purchase_id = p.id WHERE k.kyc_transaction_id = ?
     UNION SELECT p.* FROM health_purchases p JOIN health_icici_proposals pr ON pr.purchase_id = p.id WHERE pr.transaction_id = ?
     LIMIT 1`, [t, t]);
  if (row) createdPurchaseIds.add(row.id);
  return row;
}

function mockToken() {
  on('POST', '/auth-api/access/token', () => ({
    json: {
      token: `jwt-${crypto.randomBytes(8).toString('hex')}`,
      expiry: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      encKey: Buffer.from('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', 'utf8').toString('base64'),
      success: true, errorMessage: '',
    },
  }));
}
mockToken();

const PAN = 'ABCDE1234F';
const quoteBody = (t) => ({
  RequestId: 'r1', SumInsured: 500000, Tenure: 1, Pincode: '560062',
  Insured: [{ InsuredType: 'Adult', Name: 'Sam Test', DateOfBirth: '30-Aug-1989', Gender: 'Female', IsPED: false, RelationshipWithApplicant: 'SELF' }],
});
const proposalBody = (t) => ({
  RequestId: 'r2', TransactionId: t, SumInsured: 500000, Tenure: 1,
  NomineeName: 'Kashish More', NomineeDOB: '01-Jan-1970', RelationshipWithInsured: 'MOTHER',
  SuccessUrl: 'https://example.test/elevate-return', FailureUrl: 'https://example.test/elevate-return',
  Proposer: { EmailId: 'ramesh@example.test', MobileNo: '9876543210', Name: 'Ramesh Kumar', DateOfBirth: '10-Oct-1989', PinCode: 122001, Gender: 'Male' },
  Insured: [
    { Name: 'Ramesh Kumar', Gender: 'Male', InsuredType: 'Adult', RelationshipWithProposer: 'SELF', DateOfBirth: '10-Oct-1989', Weight: 70, HeightsInFeets: 5, HeightsInInches: 9, IsPED: false },
    { Name: 'Asha Kumar', Gender: 'Female', InsuredType: 'Adult', RelationshipWithProposer: 'SPOUSE', DateOfBirth: '12-Dec-1991', Weight: 58, HeightsInFeets: 5, HeightsInInches: 3, IsPED: true },
  ],
  PaymentDetails: [{ PaymentDate: '26-Nov-2026', PaymentTransactionId: 'x', Amount: 6359 }],
});
function mockQuote(t) {
  on('POST', '/health-fresh/elevate/generic/premium', () => ({ json: { BasicPremium: 5988, TotalPremium: 7065, TransactionId: t, Success: true, ErrorCode: 0 } }));
}
function mockCkyc(ok = true) {
  on('POST', '/generic/common/ckyc/generic/health/ckyc', () => ({
    json: ok
      ? { Name: 'R***', DOB: '10-Oct-1989', KycID: 'kyc_abc123', Success: true, isKycSuccess: true, StatusCode: 0, CorelationId: 'cid' }
      : { Success: true, isKycSuccess: false, StatusCode: 1, DisplayMessage: 'Not found in CKYC registry', CorelationId: 'cid' },
  }));
}
function mockProposal(t) {
  on('POST', '/health-fresh/elevate/generic/proposal-payment', () => ({
    json: {
      TransactionId: t, PaymentUrl: 'https://pay.example.test/x?session=SECRET123', ProposalId: '3200909705', RequestId: 'r2',
      BasicPremium: 5389, Gst: 970, TotalPremium: 6359, Status: 'NCCN', PfPolicyNo: '4001/4323/5675/0000',
      PolicyStartDate: '27-Nov-2026', PolicyEndDate: '26-Nov-2027', Success: true, ErrorCode: 0,
    },
  }));
}
function mockStatus(t, fields) {
  on('POST', '/health-servicing/proposal/generic/status', () => ({ json: { TransactionId: t, Success: true, ...fields } }));
}

out('\n── A. Building blocks ─────────────────────────────────────────────');

await test('encrypt/decrypt round-trip; rotation keeps old rows readable', async () => {
  const c1 = hc.encrypt('ABCDE1234F');
  eq(hc.decryptText(c1), 'ABCDE1234F', 'v1 round trip');
  eq(c1.readUInt16BE(1), 1, 'key version stamped');
  const k2 = crypto.randomBytes(32).toString('base64');
  config.healthStore.encKeys = `1:${ENC_KEY_1},2:${k2}`;
  hc.resetHealthCryptoForTests();
  try {
    const c2 = hc.encrypt('x');
    eq(c2.readUInt16BE(1), 2, 'new rows use the highest version');
    eq(hc.decryptText(c1), 'ABCDE1234F', 'v1 row still decrypts');
  } finally {
    config.healthStore.encKeys = `1:${ENC_KEY_1}`;
    hc.resetHealthCryptoForTests();
  }
  let failed = false;
  const tampered = Buffer.from(c1); tampered[tampered.length - 1] ^= 1;
  try { hc.decrypt(tampered); } catch { failed = true; }
  assert(failed, 'tampered ciphertext decrypted');
});

await test('bad key settings turn the store off with a reason, never throw', async () => {
  eq(hc.parseKeyring('', '').ok, false, 'unset');
  assert(/32 bytes/.test(hc.parseKeyring('1:abc', HASH_KEY).problem), 'short key reason');
  assert(/differ/.test(hc.parseKeyring(`1:${ENC_KEY_1}`, ENC_KEY_1).problem), 'same key reason');
  eq(hc.parseKeyring(`1:${ENC_KEY_1}`, HASH_KEY).ok, true, 'valid');
});

await test('masks: PAN XXXXX1234F, mobile 98XXXXXX10, URL query dropped, nested address masked whole', async () => {
  eq([hc.mask.pan('abcde1234f'), hc.mask.mobile('+91 98765 43210'), hc.mask.name('Ramesh Kumar')], ['XXXXX1234F', '98XXXXXX10', 'R***** K****'], 'masks');
  const m = maskForStore({
    Proposer: { Name: 'Ramesh', MobileNo: '9876543210', Address: { Line1: '12 MG Road', City: 'Pune' }, Gender: 'Male' },
    NomineeDOB: '01-Jan-1970', paymentUrl: 'https://pay.example.test/x?session=SECRET', message: 'PAN ABCDE1234F invalid',
    TotalPremium: 6359, TransactionId: 'bnc_1',
  });
  eq(m.Proposer, { Name: '***', MobileNo: '***', Address: '***', Gender: 'Male' }, 'proposer');
  eq([m.NomineeDOB, m.paymentUrl, m.message, m.TotalPremium, m.TransactionId],
    ['***', 'https://pay.example.test/x?***', 'PAN *** invalid', 6359, 'bnc_1'], 'values');
});

await test('status rules: forward applies, stale is ignored, contradictions are conflicts', async () => {
  const cases = [
    ['status', 'STARTED', 'KYC_DONE', 'apply'], ['status', 'PAID', 'KYC_PENDING', 'stale'],
    ['status', 'PAID', 'PAYMENT_FAILED', 'conflict'], ['status', 'PAYMENT_FAILED', 'PAYMENT_PENDING', 'apply'],
    ['status', 'ISSUED', 'PAID', 'stale'], ['kyc_status', 'VERIFIED', 'REJECTED', 'stale'],
    ['payment_status', 'SUCCESS', 'FAILED', 'conflict'], ['payment_status', 'FAILED', 'INITIATED', 'apply'],
    ['payment_row', 'FAILED', 'SUCCESS', 'apply'], ['proposal_status', 'SUBMITTED', 'FAILED', 'stale'],
    ['policy_status', 'ISSUED', 'PENDING', 'stale'], ['policy_status', 'ISSUED', 'REJECTED', 'conflict'],
  ];
  for (const [col, from, to, want] of cases) eq(store.decideTransition(col, from, to), want, `${col} ${from}→${to}`);
  return `${cases.length} cases`;
});

out('\n── B. One ICICI purchase, end to end ──────────────────────────────');

const T1 = txn('a');
let ref1 = null;

await test('quote: logged (masked + encrypted), no purchase, no X-Purchase-Id', async () => {
  mockQuote(T1);
  const res = await call('POST', '/icici-lombard/quote', quoteBody(T1));
  eq(res.status, 200, 'status');
  assert(!res.headers['x-purchase-id'], 'quote must not create a purchase');
  const log = await one(`SELECT * FROM health_icici_api_logs WHERE api_name = 'ICICI_PREMIUM' AND correlation_id = ? ORDER BY id DESC LIMIT 1`, [T1]);
  assert(log, 'no log row');
  eq([log.purchase_id, log.outcome, log.insurer_env, log.is_test], [null, 'SUCCESS', 'UAT', 1], 'log columns');
  const masked = JSON.parse(log.request_masked);
  eq(masked.Insured[0].Name, '***', 'masked name');
  eq(JSON.parse(hc.decryptText(log.request_enc)).Insured[0].Name, 'Sam Test', 'exact request decrypts');
});

await test('CKYC verified: creates the purchase, KYC row, customer by PAN; header set', async () => {
  mockCkyc(true);
  const res = await call('POST', '/icici-lombard/ckyc', { transactionId: T1, dateOfBirth: '10-Oct-1989', panNumber: PAN });
  eq(res.status, 200, 'status');
  ref1 = res.headers['x-purchase-id'];
  assert(hc.isUlid(ref1), `X-Purchase-Id missing or not a ULID: ${ref1}`);
  await track(ref1);
  const p = await one('SELECT * FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  eq([p.insurer_code, p.insurer_env, p.status, p.kyc_status], ['ICICI_LOMBARD', 'UAT', 'KYC_DONE', 'VERIFIED'], 'purchase');
  const k = await one('SELECT * FROM health_icici_kyc WHERE purchase_id = ?', [p.id]);
  eq([k.method, k.status, k.kyc_transaction_id, k.ovd_reference], ['CKYC', 'VERIFIED', T1, 'kyc_abc123'], 'kyc row');
  const c = await one('SELECT * FROM health_customers WHERE id = ?', [p.customer_id]);
  eq([c.pan_hash, c.pan_masked, hc.decryptText(c.pan_enc)], [hc.lookupHash('pan', PAN), 'XXXXX1234F', PAN], 'customer PAN');
  const log = await one(`SELECT * FROM health_icici_api_logs WHERE api_name = 'ICICI_CKYC' AND correlation_id = ? ORDER BY id DESC LIMIT 1`, [T1]);
  eq(log.purchase_id, p.id, 'log linked to purchase');
  eq(log.insurer_status, 'VERIFIED', 'insurer verdict kept apart from outcome');
  assert(!JSON.stringify(log.request_masked).includes(PAN) && !hc.decryptText(log.request_enc).includes(PAN), 'PAN reached the log');
});

await test('proposal: proposal row, proposer + 2 insured + nominee, payment attempt; same Purchase ID', async () => {
  mockProposal(T1);
  const res = await call('POST', '/icici-lombard/proposal', proposalBody(T1));
  eq(res.status, 200, 'status');
  eq(res.headers['x-purchase-id'], ref1, 'same purchase');
  eq(res.json.data.paymentUrl, 'https://pay.example.test/x?session=SECRET123', 'response body unchanged');
  const p = await one('SELECT * FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  eq([p.status, p.proposal_status, p.payment_status, p.proposal_number, Number(p.final_premium), Number(p.gst_amount), p.adults, p.policy_start_date],
    ['PAYMENT_PENDING', 'SUBMITTED', 'INITIATED', '3200909705', 6359, 970, 2, '2026-11-27'], 'purchase');
  const pr = await one('SELECT * FROM health_icici_proposals WHERE purchase_id = ?', [p.id]);
  eq([pr.transaction_id, pr.proposal_id, Number(pr.total_premium), hc.decryptText(pr.payment_url_enc)],
    [T1, '3200909705', 6359, 'https://pay.example.test/x?session=SECRET123'], 'proposal row');
  const members = await q('SELECT role, member_seq, relation, age_at_purchase, full_name_enc, medical_enc FROM health_purchase_members WHERE purchase_id = ? ORDER BY role, member_seq', [p.id]);
  eq(members.map((m) => [m.role, m.member_seq, m.relation]), [['INSURED', 1, 'SELF'], ['INSURED', 2, 'SPOUSE'], ['NOMINEE', 1, 'MOTHER']], 'members');
  eq(hc.decryptText(members[1].full_name_enc), 'Asha Kumar', 'member name decrypts');
  eq(JSON.parse(hc.decryptText(members[1].medical_enc)).IsPED, true, 'medical answers encrypted, kept');
  const c = await one('SELECT * FROM health_customers WHERE id = ?', [p.customer_id]);
  eq([c.pan_masked, c.mobile_masked, c.name_masked, hc.decryptText(c.email_enc)], ['XXXXX1234F', '98XXXXXX10', 'R***** K****', 'ramesh@example.test'], 'one customer, now complete');
  const pay = await one('SELECT * FROM health_payments WHERE purchase_id = ?', [p.id]);
  eq([pay.payment_ref, pay.attempt_no, pay.gateway, pay.status, Number(pay.amount)], [T1, 1, 'ICICI_PG', 'INITIATED', 6359], 'health_payments');
  const ip = await one('SELECT * FROM health_icici_payments WHERE transaction_id = ?', [T1]);
  eq(ip.health_payment_id, pay.id, 'insurer payment paired 1:1');
  const log = await one(`SELECT response_masked FROM health_icici_api_logs WHERE api_name = 'ICICI_PROPOSAL' AND correlation_id = ? ORDER BY id DESC LIMIT 1`, [T1]);
  assert(!log.response_masked.includes('SECRET123'), 'payment-page token in the masked log');
});

await test('policy/status Pending: payment PENDING; an identical second poll is counted, not re-logged', async () => {
  mockStatus(T1, { ProposalStatus: 'NCCN', PolicyStatus: 'DRAFT', PaymentStatus: 'Pending' });
  await call('POST', '/icici-lombard/policy/status', { TransactionId: T1, RequestId: 'r3' });
  await call('POST', '/icici-lombard/policy/status', { TransactionId: T1, RequestId: 'r3' });
  const ip = await one('SELECT * FROM health_icici_payments WHERE transaction_id = ?', [T1]);
  eq([ip.icici_payment_status, ip.poll_count], ['Pending', 2], 'poll count');
  const logs = await one(`SELECT COUNT(*) n FROM health_icici_api_logs WHERE api_name = 'ICICI_POLICY_STATUS' AND correlation_id = ?`, [T1]);
  eq(Number(logs.n), 1, 'unchanged answer logged once');
  const pay = await one('SELECT status FROM health_payments WHERE payment_ref = ?', [T1]);
  eq(pay.status, 'PENDING', 'payment row');
});

await test('policy/status Paid (DRAFT): payment SUCCESS via STATUS_API, purchase PAID, policy PENDING', async () => {
  mockStatus(T1, { ProposalStatus: 'NC', PolicyStatus: 'DRAFT', PaymentStatus: 'Paid' });
  await call('POST', '/icici-lombard/policy/status', { TransactionId: T1, RequestId: 'r4' });
  const p = await one('SELECT * FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  eq([p.status, p.payment_status, p.policy_status, p.needs_review], ['PAID', 'SUCCESS', 'PENDING', 0], 'purchase');
  const pay = await one('SELECT * FROM health_payments WHERE payment_ref = ?', [T1]);
  eq([pay.status, pay.verified_via], ['SUCCESS', 'STATUS_API'], 'payment');
  assert(pay.verified_at && pay.completed_at, 'verified/completed timestamps');
});

await test('a later "Failed" never overwrites the SUCCESS: CONFLICT event + needs_review', async () => {
  mockStatus(T1, { ProposalStatus: 'NC', PolicyStatus: 'DRAFT', PaymentStatus: 'Failed' });
  await call('POST', '/icici-lombard/policy/status', { TransactionId: T1, RequestId: 'r5' });
  const p = await one('SELECT * FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  eq([p.status, p.payment_status, p.needs_review], ['PAID', 'SUCCESS', 1], 'purchase kept, flagged');
  eq((await one('SELECT status FROM health_payments WHERE payment_ref = ?', [T1])).status, 'SUCCESS', 'payment kept');
  const conflicts = await one(`SELECT COUNT(*) n FROM health_purchase_events WHERE purchase_id = ? AND event_type = 'CONFLICT'`, [p.id]);
  assert(Number(conflicts.n) >= 1, 'no CONFLICT event');
});

await test('policy/status ACTIVE + PolicyNo: policy ISSUED with number and dates; purchase ISSUED', async () => {
  mockStatus(T1, { PolicyNo: '4128/X/2026', ProposalStatus: 'NC', PolicyStatus: 'ACTIVE', PaymentStatus: 'Paid', StartDate: '2026-11-27T00:00:00', EndDate: '2027-11-26T00:00:00' });
  await call('POST', '/icici-lombard/policy/status', { TransactionId: T1, RequestId: 'r6' });
  const p = await one('SELECT * FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  eq([p.status, p.policy_status, p.policy_number, p.policy_start_date, p.policy_end_date], ['ISSUED', 'ISSUED', '4128/X/2026', '2026-11-27', '2027-11-26'], 'purchase');
  assert(p.completed_at, 'completed_at');
  const pol = await one('SELECT * FROM health_icici_policies WHERE purchase_id = ?', [p.id]);
  eq([pol.status, pol.policy_no, pol.policy_status], ['ISSUED', '4128/X/2026', 'ACTIVE'], 'policy row');
});

await test('COI: certificate stored encrypted once, linked to the policy', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), crypto.randomBytes(4096)]);
  on('GET', `/generic/common/customer/novacred/certificate/health/${T1}`, () => ({ buffer: pdf }));
  await call('GET', `/icici-lombard/coi/${T1}`);
  await call('GET', `/icici-lombard/coi/${T1}`);
  const p = await one('SELECT id FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  const docs = await q('SELECT * FROM health_policy_documents WHERE purchase_id = ?', [p.id]);
  eq(docs.length, 1, 'same certificate stored once');
  assert(hc.decrypt(docs[0].content_enc).equals(pdf), 'stored bytes differ from the certificate');
  eq([docs[0].document_type, docs[0].status, docs[0].size_bytes, docs[0].policy_number], ['COI', 'STORED', pdf.length, '4128/X/2026'], 'document row');
  eq((await one('SELECT document_id FROM health_icici_policies WHERE purchase_id = ?', [p.id])).document_id, docs[0].id, 'linked');
  const log = await one(`SELECT response_masked, response_enc FROM health_icici_api_logs WHERE api_name = 'ICICI_COI' AND correlation_id = ? LIMIT 1`, [T1]);
  assert(log.response_masked.length < 500 && hc.decryptText(log.response_enc).length < 500, 'the document reached the log');
});

await test('the history reads in order', async () => {
  const p = await one('SELECT id FROM health_purchases WHERE purchase_ref = ?', [ref1]);
  const ev = await q(`SELECT event_type, to_status FROM health_purchase_events WHERE purchase_id = ? ORDER BY id`, [p.id]);
  const statusTrail = ev.filter((e) => e.event_type === 'STATUS_CHANGED' && ['KYC_DONE', 'PAYMENT_PENDING', 'PENDING', 'SUCCESS', 'PAID', 'ISSUED'].includes(e.to_status)).map((e) => e.to_status);
  assert(ev[0].event_type === 'PURCHASE_CREATED', 'first event is the creation');
  for (const s of ['KYC_DONE', 'PAYMENT_PENDING', 'PAID', 'ISSUED']) assert(statusTrail.includes(s), `trail lacks ${s}: ${statusTrail}`);
  return `${ev.length} events`;
});

out('\n── C. Edge cases ──────────────────────────────────────────────────');

await test('two simultaneous first calls for one TransactionId create ONE purchase', async () => {
  const T2 = txn('b');
  mockCkyc(true);
  const [a, b] = await Promise.all([
    call('POST', '/icici-lombard/ckyc', { transactionId: T2, dateOfBirth: '01-Jan-1990', panNumber: 'PQRSX6789K' }),
    call('POST', '/icici-lombard/ckyc', { transactionId: T2, dateOfBirth: '01-Jan-1990', panNumber: 'PQRSX6789K' }),
  ]);
  eq(a.headers['x-purchase-id'], b.headers['x-purchase-id'], 'both calls got the same Purchase ID');
  await track(a.headers['x-purchase-id']);
  const n = await one('SELECT COUNT(DISTINCT purchase_id) n FROM health_icici_kyc WHERE kyc_transaction_id = ?', [T2]);
  eq(Number(n.n), 1, 'purchases for one TransactionId');
});

await test('X-Purchase-Id naming a purchase with ANOTHER TransactionId is not trusted', async () => {
  const T3 = txn('c');
  mockCkyc(true);
  const res = await call('POST', '/icici-lombard/ckyc', { transactionId: T3, dateOfBirth: '01-Jan-1990', panNumber: 'LMNOP1111Z' }, { 'X-Purchase-Id': ref1 });
  assert(res.headers['x-purchase-id'] && res.headers['x-purchase-id'] !== ref1, 'mismatched header was trusted');
  await track(res.headers['x-purchase-id']);
});

await test('a failed proposal is recorded FAILED; the resubmission that succeeds moves it to SUBMITTED', async () => {
  const T4 = txn('d');
  on('POST', '/health-fresh/elevate/generic/proposal-payment', () => ({ json: { Success: false, ErrorCode: 458, ErrorMessage: 'KYC PENDING' } }));
  const bad = await call('POST', '/icici-lombard/proposal', proposalBody(T4));
  assert(bad.status >= 400, `expected an error, got ${bad.status}`);
  const p = await purchaseOfTxn(T4);
  assert(p, 'failed proposal did not record a purchase');
  eq([p.proposal_status, (await one('SELECT status FROM health_icici_proposals WHERE purchase_id = ?', [p.id])).status], ['FAILED', 'FAILED'], 'failed');
  mockProposal(T4);
  await call('POST', '/icici-lombard/proposal', proposalBody(T4));
  const after = await one('SELECT proposal_status FROM health_purchases WHERE id = ?', [p.id]);
  eq(after.proposal_status, 'SUBMITTED', 'resubmitted');
});

await test('a call in the production environment is stored as PROD', async () => {
  const T5 = txn('e');
  const stored = await runInIciciEnvironment('production', () => recordIciciCall({
    req: { get: () => null }, apiName: 'ICICI_CKYC', httpStatus: 200, endpointUrl: 'http://127.0.0.1/prod-ckyc',
    durationMs: 5, requestBody: { transactionId: T5, panNumber: 'PRODX2222Y' }, requestForLog: { transactionId: T5, idType: 'PAN' },
    responseData: { isKycSuccess: true, kycId: 'k' }, responseForLog: { isKycSuccess: true }, correlationId: T5,
  }));
  await track(stored.purchaseRef);
  const p = await one('SELECT insurer_env FROM health_purchases WHERE purchase_ref = ?', [stored.purchaseRef]);
  eq(p.insurer_env, 'PROD', 'environment');
});

await test('store OFF (keys unset): same response body, no header, no rows', async () => {
  const T6 = txn('f');
  mockProposal(T6);
  const on1 = await call('POST', '/icici-lombard/proposal', proposalBody(T6));
  await purchaseOfTxn(T6);
  const T7 = txn('g');
  mockProposal(T7);
  config.healthStore.encKeys = '';
  hc.resetHealthCryptoForTests();
  try {
    const off = await call('POST', '/icici-lombard/proposal', proposalBody(T7));
    assert(!off.headers['x-purchase-id'], 'header while off');
    // The two calls use different TransactionIds by design; everything else must match.
    const sameShape = (r) => ({ ...r.json, data: { ...r.json.data, transactionId: null, raw: { ...r.json.data.raw, TransactionId: null } }, iciciRequest: undefined, meta: undefined });
    eq(sameShape(off), sameShape(on1), 'body with the store on vs off');
    eq(await purchaseOfTxn(T7), null, 'rows written while off');
  } finally {
    config.healthStore.encKeys = `1:${ENC_KEY_1}`;
    hc.resetHealthCryptoForTests();
  }
});

await test('nothing secret in the console: no PAN, mobile, key or payment token', async () => {
  const text = logged.join('\n');
  for (const secret of [PAN, '9876543210', ENC_KEY_1, HASH_KEY, 'SECRET123']) assert(!text.includes(secret), `console carried ${secret.slice(0, 4)}…`);
  return `${logged.length} lines checked`;
});

// ── 5. Clean up every row this run created ──────────────────────────────────

const ids = [...createdPurchaseIds];
let removed = 0;
try {
  const inIds = ids.length ? ids : [0];
  const del = async (sql, params) => { const r = await raw(sql, params); removed += r.affectedRows; };
  await del(`DELETE FROM health_icici_policies WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_icici_payments WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_icici_kyc WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_icici_proposals WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_policy_documents WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_payments WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_purchase_events WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_purchase_members WHERE purchase_id IN (?)`, [inIds]);
  await del(`DELETE FROM health_icici_api_logs WHERE purchase_id IN (?) OR (is_test = 1 AND endpoint LIKE 'http://127.0.0.1%' AND created_at >= ?)`, [inIds, RUN_START]);
  const customers = (await raw(`SELECT DISTINCT customer_id FROM health_purchases WHERE id IN (?) AND customer_id IS NOT NULL`, [inIds])).map((r) => r.customer_id);
  await del(`DELETE FROM health_purchases WHERE id IN (?)`, [inIds]);
  if (customers.length) {
    await del(`DELETE FROM health_customers WHERE id IN (?) AND id NOT IN (SELECT customer_id FROM health_purchases WHERE customer_id IS NOT NULL)`, [customers]);
  }
  await del(`DELETE FROM nivabupa_api_transactions WHERE api_name LIKE 'ICICI\\_%' AND endpoint_url LIKE 'http://127.0.0.1%' AND created_at >= ?`, [RUN_START]);
  out(`\n  🧹 removed ${removed} test rows (${ids.length} purchases)`);
} catch (error) {
  out(`\n  ⚠️  cleanup failed: ${error.message}`);
  results.push(false);
}

const passed = results.filter(Boolean).length;
const failed = results.length - passed;
out(`\n═══════════════════════════════════════════════════════════════════\n  ${passed} passed, ${failed} failed\n═══════════════════════════════════════════════════════════════════`);
server.close();
mock.close();
await db.closePool();
process.exit(failed ? 1 : 0);
