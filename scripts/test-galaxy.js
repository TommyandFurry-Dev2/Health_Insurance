// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health (GHI, CBOS-GX V2) — offline test suite.
//
//   npm run test:galaxy
//
// Exercises every /galaxy-health route through the REAL Express app against a
// local mock of GHI's gateway that speaks GHI's actual wire format: it holds a
// "GHI" RSA keypair, RSA-OAEP-decrypts the apiKey header, verifies the checkSum,
// AES-256-GCM-decrypts requestData.encryptedData, and answers with a fresh
// apiKey wrapped in OUR public key, its checkSum, and an encrypted result —
// the same scheme GHI UAT answered with on 24–25 Nov 2026. No request leaves
// this machine: GX_BASE_URL points at the mock before any module reads config,
// the key store is a temporary directory, and the database is a closed port.
//
// Carries over what the working implementation's Jest suites proved
// (test/galaxy/gxAdapter, gxCrypto, gxKeyScheduler, gxMask, gxRoutes,
// gxDataDictionary in novacred-insurance-integrations) and adds what the
// migration itself must prove:
//
//   * the envelopes are the ones the SPA reads; GHI's names and the short
//     names reach the same handler; the /health alias serves them too
//   * an unconfigured deployment answers 503 naming the variables
//   * today's-key gate, the 3-a-day key-fetch quota, the ops-key guard
//   * no appKey, ops key, private key, PAN, mobile or e-mail is ever logged
//   * the other insurers' routers are still mounted and answering
//
// No test framework: this service has none. Exit 0 = all passed.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import nodeCrypto from 'node:crypto';

// ── 1. GHI's keypair and the mock gateway (before any config is read) ───────

const ghiKeys = nodeCrypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const handlers = new Map(); // path → (request) => reply
const received = [];        // every request the mock decrypted

function onGhi(opPath, handler) { handlers.set(opPath, handler); }

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const entry = { path: req.url, headers: req.headers, raw };
    received.push(entry);
    const handler = handlers.get(req.url);
    if (!handler) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{}'); return; }
    try {
      const reply = await handler(entry);
      res.writeHead(reply.status ?? 200, { 'Content-Type': 'application/json', ...(reply.headers || {}) });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    } catch (error) {
      res.writeHead(599, { 'Content-Type': 'text/plain' });
      res.end(`mock failure: ${error.message}`);
    }
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ── 2. Environment ──────────────────────────────────────────────────────────

const KEY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-keys-'));
const PAY_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'galaxy-payments-'));
const SECRETS = {
  appKey: 'TEST-APPKEY-6f1d0c2b9a8e7d6c5b4a',
  opsKey: 'test-gx-ops-key-1234',
  payClientId: 'GHI-PAYMENT-TEST',
  payClientSecret: 'test-pay-secret-9f8e7d6c5b4a3210',
};
const PERSON = { pan: 'ABCDE1234F', mobile: '9876543210', email: 'asha.rao@example.com' };

Object.assign(process.env, {
  NODE_ENV: 'test',
  GX_BASE_URL: MOCK,
  GX_CHANNEL_ID: '2522',
  GX_APP_KEY: SECRETS.appKey,
  GX_GHI_STATIC_PUBLIC_KEY: ghiKeys.publicKey,
  GX_PRODUCER_CODE: 'PRODUCER-TEST',
  GX_CLIENT_IP: '203.0.113.7',
  GX_KEY_STORE_DIR: KEY_DIR,
  GX_KEY_SCHEDULER: 'false',
  // 00:00, so "today's key" does not depend on the hour the suite runs at.
  GX_KEY_REFRESH_AT: '00:00',
  GX_OPS_KEY: SECRETS.opsKey,
  GX_PAYMENT_CLIENT_ID: SECRETS.payClientId,
  GX_PAYMENT_CLIENT_SECRET: SECRETS.payClientSecret,
  GX_PAYMENT_AES_KEY: '',
  GX_PAYMENT_STORE_DIR: PAY_DIR,
  GX_PAYMENT_FRONTEND_RETURN_URL: 'https://uat-site.tommyandfurry.com/insurance/get-quote/health/galaxy-return',
  GX_PAYMENT_FRONTEND_RETURN_ORIGINS: 'https://uat-site.tommyandfurry.com',
  GX_MAX_RETRIES: '2',
  GX_RETRY_BASE_DELAY_MS: '1',
  GX_API_TIMEOUT_MS: '3000',
  GX_DEBUG: '0',
  GX_CORS_ORIGINS: '*',
  NIVABUPA_ALIAS_PREFIX: '/health',
  // A closed port: audit writes fail fast and are swallowed, and nothing can
  // reach a developer's real MySQL.
  NIVABUPA_DB_HOST: '127.0.0.1',
  NIVABUPA_DB_PORT: '1',
  NIVABUPA_DB_CONNECT_TIMEOUT_MS: '500',
});

// ── 3. Capture everything logged, to prove no secret or personal datum is printed

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

// ── 4. The application ──────────────────────────────────────────────────────

const { default: config } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { GxCrypto } = await import('../src/helpers/galaxyCrypto.helper.js');
const { GxKeyStore, pemBody, normalizePem } = await import('../src/services/galaxyKeyStore.service.js');
const { galaxyClient } = await import('../src/services/galaxyClient.service.js');
const { isTransient, startGxKeyScheduler } = await import('../src/services/galaxyKeyScheduler.service.js');
const { maskPersonalData, MASK } = await import('../src/helpers/galaxyMask.helper.js');
const dictionary = await import('../src/helpers/galaxyDictionary.helper.js');
const { istDate, istTime } = await import('../src/helpers/galaxyKeyDay.helper.js');
const { default: db } = await import('../src/db/index.js');

const gx = new GxCrypto();
const keyStore = new GxKeyStore(KEY_DIR);

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP = `http://127.0.0.1:${server.address().port}`;

async function call(method, urlPath, body, headers = {}) {
  const res = await fetch(`${APP}${urlPath}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, text, json };
}

// ── 5. GHI's side of the wire ───────────────────────────────────────────────

/** Opens a request the way GHI does: unwrap apiKey, verify checkSum, decrypt. */
function openRequest(entry, ghiPrivateKey = ghiKeys.privateKey) {
  const body = JSON.parse(entry.raw);
  const encData = body.requestData.encryptedData;
  const rawApiKey = gx.rsaDecryptApiKey(entry.headers.apikey, ghiPrivateKey);
  if (!gx.verifyChecksum(rawApiKey, encData, entry.headers.checksum)) throw new Error('request checkSum mismatch');
  return gx.aesDecrypt(encData, rawApiKey);
}

/** GHI's encrypted answer: fresh apiKey wrapped with OUR current public key. */
function ghiReply(plaintext, { statusCode = '200', statusDescription = 'OK', requestUID = 'ghi-uid', tamper, ncPublicKey } = {}) {
  const respApiKey = gx.generateApiKey();
  const encryptedData = gx.aesEncrypt(typeof plaintext === 'string' ? plaintext : JSON.stringify(plaintext), respApiKey);
  const headers = {
    apiKey: gx.rsaEncryptApiKey(respApiKey, ncPublicKey || keyStore.ncCurrent().publicKey),
    checkSum: gx.checksum(respApiKey, encryptedData),
  };
  if (tamper) tamper(headers);
  return { status: 200, headers, body: { statusCode, statusDescription, requestUID, results: [{ encryptedData }] } };
}

/** Today's GHI key in the store, received now (the mock's public key). */
function seedTodaysKey() {
  keyStore.setGhiCurrent(ghiKeys.publicKey, new Date());
}

// ── 6. Runner ───────────────────────────────────────────────────────────────

const results = [];
let section = '';
function heading(name) {
  section = name;
  out(`\n── ${name} ${'─'.repeat(Math.max(0, 62 - name.length))}`);
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}
function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected ${e}\n  got      ${a}`);
}
async function test(name, fn) {
  try {
    const note = await fn();
    results.push({ section, name, ok: true });
    out(`  ✓ ${name}${note ? `  (${note})` : ''}`);
  } catch (error) {
    results.push({ section, name, ok: false, error: error.stack || String(error) });
    out(`  ✗ ${name}\n      ${String(error.message).split('\n').join('\n      ')}`);
  }
}
const sentSince = (n) => received.slice(n);

const QUOTE_BODY = {
  applicationNumber: '17640000000000123',
  basicDetails: {
    proposerPinCode: '600019', intermediaryName: 'NovaCred', plan: 'STANDARD', planType: 'IND', policyTenure: '1Y',
    premiumFrequency: 'B', sourceCode: 'SLLRPORT', typeOfBusiness: 'NB', quoteStartDate: '2026-11-25',
    numberOfMembers: '1', policyStartDate: '2026-11-25', quoteExpiryDate: '2027-11-24', pedBuyBack: 'NA',
  },
  members: [{
    memberDetails: {
      memberId: '0', age: '34', applicableSumInsured: '500000', gender: 'F', relationship: '24',
      dateOfBirth: '1992-04-15', whetherAnNRI: 'N', deductibleOptions: 'NA', deductiblePerClaim: 'NA',
    },
    covers: [{ coverCode: 'PPN', coverName: null, coverAttribute: null }],
  }],
};
const QUOTE_ANSWER = [{
  planCode: 'STANDARD', premiumFrequency: 'B', sourceName: 'SLLRPORT', policyStatus: 'QUOTE',
  quotePremiumDetails: {
    tenureOptions: [{
      policyTenure: '1Y',
      premiumOptions: [
        { frequency: 'E', basePremium: '3436.44', tax: '618.56', premiumAfterTax: '4055.00' },
        { frequency: 'B', basePremium: '3436.44', tax: '618.56', premiumAfterTax: '4055.00' },
      ],
    }],
  },
}];

// ═════════════════════════════════════════════════════════════════════════════
heading('A. Crypto primitives (unchanged from the working implementation)');

await test('AES-256-GCM packs [32][IV(32)][ciphertext][tag(16)] and round-trips', () => {
  const key = gx.generateApiKey();
  assert(key.length === 32, 'apiKey is 32 characters');
  const enc = gx.aesEncrypt('{"a":"ü ₹"}', key);
  const buf = Buffer.from(enc, 'base64');
  eq(buf[0], 32, 'first byte is the IV length');
  eq(buf.length, 1 + 32 + Buffer.byteLength('{"a":"ü ₹"}') + 16, 'packed length');
  eq(gx.aesDecrypt(enc, key), '{"a":"ü ₹"}', 'round trip');
});

await test('a tampered ciphertext fails the GCM tag (CRYPTO_ERROR)', () => {
  const key = gx.generateApiKey();
  const buf = Buffer.from(gx.aesEncrypt('payload', key), 'base64');
  buf[40] ^= 0xff;
  try { gx.aesDecrypt(buf.toString('base64'), key); } catch (e) { eq(e.code, 'CRYPTO_ERROR', 'code'); return; }
  throw new Error('decrypted a tampered payload');
});

await test('RSA-OAEP-SHA256 wraps the apiKey for GHI and only GHI\'s private key opens it', () => {
  const key = gx.generateApiKey();
  const wrapped = gx.rsaEncryptApiKey(key, ghiKeys.publicKey);
  eq(nodeCrypto.privateDecrypt({ key: ghiKeys.privateKey, padding: nodeCrypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(wrapped, 'base64')).toString(), key, 'OAEP SHA-256 / MGF1-SHA256');
});

await test('checkSum = SHA-256(rawApiKey + encryptedData), verified in constant time', () => {
  const sum = gx.checksum('K'.repeat(32), 'DATA');
  eq(sum, nodeCrypto.createHash('sha256').update(`${'K'.repeat(32)}DATA`).digest('hex'), 'hash');
  assert(gx.verifyChecksum('K'.repeat(32), 'DATA', sum), 'verifies');
  assert(!gx.verifyChecksum('K'.repeat(32), 'DATA', `${sum.slice(0, -1)}0`), 'rejects a changed sum');
  assert(!gx.verifyChecksum('K'.repeat(32), 'DATA', undefined), 'rejects a missing sum');
});

await test('GH-CLIENT-CONTEXT is base64(ROT47(base64(JSON))) and decodes back', () => {
  const ctx = { requestUID: '2522-x', channelID: '2522' };
  eq(gx.decodeClientContext(gx.buildClientContext(ctx)), ctx, 'round trip');
  eq(GxCrypto.rot47(GxCrypto.rot47('abcXYZ019+/=')), 'abcXYZ019+/=', 'ROT47 is its own inverse');
});

await test('pemBody gives the bare one-line SPKI body GHI wants; normalizePem wraps it back', () => {
  const body = pemBody(ghiKeys.publicKey);
  assert(!body.includes('BEGIN') && !/\s/.test(body), 'bare base64');
  eq(nodeCrypto.createPublicKey(normalizePem(body)).export({ type: 'spki', format: 'pem' }), ghiKeys.publicKey, 'same key');
});

await test('IST key day: 05:05 IST on 25 Nov is 23:35 UTC on 24 Nov', () => {
  eq(istTime('05:05', new Date('2026-11-25T06:00:00Z')).toISOString(), '2026-11-24T23:35:00.000Z', 'instant');
  eq(istDate(new Date('2026-11-24T19:00:00Z')), '2026-11-25', 'IST date after 18:30 UTC');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('B. Today\'s-key gate (GHI mail, 29 Oct 2026)');

await test('no key received today → 503 CONFIG_ERROR and nothing is sent to GHI', async () => {
  keyStore.setGhiCurrent(ghiKeys.publicKey, new Date(Date.now() - 2 * 86400000));
  const before = received.length;
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 503, 'status');
  eq(r.json?.error?.code, 'CONFIG_ERROR', 'code');
  assert(/has not been fetched yet/.test(r.json.error.message), r.json.error.message);
  eq(sentSince(before).length, 0, 'requests sent');
});

await test('config/test reports the missing key as 503, with dates and counts only', async () => {
  const r = await call('GET', '/galaxy-health/config/test');
  eq(r.status, 503, 'status');
  eq(r.json.configured, true, 'configured');
  eq(r.json.keys.todaysGhiKey, false, 'today\'s key');
  assert(!r.text.includes(SECRETS.appKey) && !r.text.includes(SECRETS.opsKey), 'no secret in the body');
  assert(!r.text.includes('BEGIN'), 'no key material in the body');
});

seedTodaysKey();

// ═════════════════════════════════════════════════════════════════════════════
heading('C. quickQuote');

let quoteEntry = null;
onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => {
  quoteEntry = { ...entry, plaintext: openRequest(entry) };
  return ghiReply(QUOTE_ANSWER, { requestUID: entry.headers.requestuid });
});

await test('POST /galaxy-health/quickQuote → 200, the working implementation\'s envelope', async () => {
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 200, `status ${r.text.slice(0, 300)}`);
  eq([r.json.ok, r.json.provider, r.json.operation], [true, 'galaxy', 'getQuote'], 'envelope');
  eq(r.json.data.summary.options.map((o) => [o.policyTenure, o.frequency, o.premiumAfterTax]), [['1Y', 'E', 4055], ['1Y', 'B', 4055]], 'summary');
  eq(r.json.data.planCode, 'STANDARD', 'the decrypted quote is kept beside the summary');
  assert(/^2522-[0-9a-f-]{36}$/.test(r.json.meta.requestUID), `meta.requestUID ${r.json.meta.requestUID}`);
});

await test('GHI received the caller\'s body, with productCode and GX_PRODUCER_CODE filled in', () => {
  const sent = JSON.parse(quoteEntry.plaintext);
  eq(sent.productCode, 'GXGLXYMRVL', 'productCode default');
  eq(sent.basicDetails.producerCode, 'PRODUCER-TEST', 'producerCode from GX_PRODUCER_CODE');
  eq(sent.members, QUOTE_BODY.members, 'members verbatim');
  eq(sent.applicationNumber, QUOTE_BODY.applicationNumber, 'applicationNumber verbatim');
});

await test('headers: Basic appKey, Galaxy-NovaCred, requestUID, GH-CLIENT-CONTEXT', () => {
  const h = quoteEntry.headers;
  eq(h.authorization, `Basic ${SECRETS.appKey}`, 'Authorization');
  eq(h['user-agent'], 'Galaxy-NovaCred', 'User-Agent');
  const ctx = gx.decodeClientContext(h['gh-client-context']);
  eq([ctx.channelID, ctx.clientIp, ctx.srcSystemName, ctx.requestUID], ['2522', '203.0.113.7', 'NovaCred', h.requestuid], 'context');
});

await test('GHI\'s bare success body (no requestUID) → meta.requestUID is the one we sent', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => {
    quoteEntry = { ...entry, plaintext: openRequest(entry) };
    const reply = ghiReply(QUOTE_ANSWER);
    return { ...reply, body: { results: reply.body.results } };
  });
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 200, 'status');
  eq(r.json.meta.requestUID, quoteEntry.headers.requestuid, 'meta.requestUID');
  onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => {
    quoteEntry = { ...entry, plaintext: openRequest(entry) };
    return ghiReply(QUOTE_ANSWER, { requestUID: entry.headers.requestuid });
  });
});

await test('a producerCode the caller sent is kept', async () => {
  await call('POST', '/galaxy-health/quickQuote', { ...QUOTE_BODY, basicDetails: { ...QUOTE_BODY.basicDetails, producerCode: 'CALLER-CODE' } });
  eq(JSON.parse(quoteEntry.plaintext).basicDetails.producerCode, 'CALLER-CODE', 'producerCode');
});

await test('the short name and the /health alias reach the same handler', async () => {
  for (const p of ['/galaxy-health/quote', '/health/galaxy-health/quickQuote', '/health/galaxy-health/quote']) {
    const r = await call('POST', p, QUOTE_BODY);
    eq([r.status, r.json?.operation], [200, 'getQuote'], p);
  }
});

await test('journeyId / resumeToken are stripped before the body is encrypted for GHI', async () => {
  await call('POST', '/galaxy-health/quickQuote', { ...QUOTE_BODY, journeyId: 'j-1', resumeToken: 'r-1' });
  const sent = JSON.parse(quoteEntry.plaintext);
  assert(!('journeyId' in sent) && !('resumeToken' in sent), 'journey fields reached GHI');
});

await test('a body without members → 400 VALIDATION_ERROR naming it, nothing sent', async () => {
  const before = received.length;
  const r = await call('POST', '/galaxy-health/quickQuote', { applicationNumber: '1', basicDetails: {} });
  eq(r.status, 400, 'status');
  eq(r.json.error.code, 'VALIDATION_ERROR', 'code');
  eq(r.json.error.details.missing, ['members'], 'missing');
  eq(sentSince(before).length, 0, 'requests sent');
});

await test('GHI\'s 25 Nov 500: statusCode "500" with an encrypted [{"members":[]}] → 502, detail decrypted', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => ghiReply([{ members: [] }], {
    statusCode: '500', statusDescription: 'Internal Server Error', requestUID: entry.headers.requestuid,
  }));
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 502, 'status');
  eq(r.json.error.code, 'UPSTREAM_ERROR', 'code');
  eq(r.json.error.message, 'GX quickQuote failed: Internal Server Error', 'message');
  eq(r.json.error.details.ghiResponse, [{ members: [] }], 'decrypted GHI detail');
  assert(/^2522-/.test(r.json.error.details.requestUID), 'requestUID for GHI support');
});

await test('GHI\'s decrypted error detail is masked before it reaches the caller', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => ghiReply(
    { message: `PAN ${PERSON.pan} invalid`, mobileNo: PERSON.mobile, emailId: PERSON.email, code: 'CBOS-GXQUT-5001' },
    { statusCode: 'CBOS-GXQUT-5001', statusDescription: `Bad request for ${PERSON.email}` },
  ));
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 502, 'status');
  const d = r.json.error.details.ghiResponse;
  eq([d.mobileNo, d.emailId, d.code], [MASK, MASK, 'CBOS-GXQUT-5001'], 'masked keys, codes kept');
  eq(d.message, `PAN ${MASK} invalid`, 'PAN in free text masked');
  assert(!r.text.includes(PERSON.pan) && !r.text.includes(PERSON.email), 'personal data in the response');
});

await test('a response checkSum that does not match → 502 PARSE_ERROR', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => ghiReply(QUOTE_ANSWER, { tamper: (h) => { h.checkSum = '0'.repeat(64); } }));
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq([r.status, r.json.error.code], [502, 'PARSE_ERROR'], 'status/code');
  assert(/checkSum does not match/.test(r.json.error.message), r.json.error.message);
});

await test('a response apiKey wrapped for someone else\'s key → 502 PARSE_ERROR', async () => {
  const stranger = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => ghiReply(QUOTE_ANSWER, { ncPublicKey: stranger.publicKey }));
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq([r.status, r.json.error.code], [502, 'PARSE_ERROR'], 'status/code');
});

await test('GHI HTTP 500 → 502 with httpStatus, not retried', async () => {
  let hits = 0;
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => { hits += 1; return { status: 500, body: { message: 'boom' } }; });
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq([r.status, r.json.error.code, r.json.error.details.httpStatus, hits], [502, 'UPSTREAM_ERROR', 500, 1], 'status/code/httpStatus/hits');
});

await test('GHI 503 is retried (GX_MAX_RETRIES=2 → 3 attempts), then 502', async () => {
  let hits = 0;
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => { hits += 1; return { status: 503, body: {} }; });
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq([r.status, r.json.error.code, hits], [502, 'UPSTREAM_ERROR', 3], 'status/code/hits');
});

await test('a 503 that recovers on the retry → 200', async () => {
  let hits = 0;
  onGhi('/cbosgx-quote/api/v2/quickQuote', () => { hits += 1; return hits === 1 ? { status: 503, body: {} } : ghiReply(QUOTE_ANSWER); });
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq([r.status, hits], [200, 2], 'status/hits');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('D. saveFullProposal and createOrder');

const PROPOSAL_BODY = {
  refId: '', flag: 'C', productCode: 'GALMARVEL', policyBranch: '33501',
  basicdetailAttribute: [{ producerCode: 'GHI00000001', hniCustomer: 'N', applicationNumberEntry1: '17640000000000999' }],
  relations: [{ party: { partyDetails: [{ panNo: PERSON.pan, fatherName: 'Test Father' }] } }],
  members: [{ riskid: 0, memberDetails: [{ relationship: '24' }] }],
};
let proposalPlain = null;
onGhi('/cbosgx-rpolicy/api/v2/saveFullProposal', (entry) => {
  proposalPlain = openRequest(entry);
  return ghiReply([{ proposalNumber: 'Q1127', refId: 'REF-1', proposerPartyCode: 'PHI1', pemiumDetails: { premiumDetails: [{ netPremium: '4055.0' }] } }]);
});

await test('POST /galaxy-health/saveFullProposal → 200, GHI\'s decrypted answer as data', async () => {
  const r = await call('POST', '/galaxy-health/saveFullProposal', PROPOSAL_BODY);
  eq([r.status, r.json.operation], [200, 'createProposal'], `status ${r.text.slice(0, 200)}`);
  eq(r.json.data[0].proposalNumber, 'Q1127', 'proposal number');
  // { productCode: default, ...body }, as the working implementation built it: same content, productCode first.
  eq(JSON.parse(proposalPlain), { productCode: 'GALMARVEL', ...PROPOSAL_BODY }, 'body reached GHI verbatim (GALMARVEL kept)');
});

await test('/galaxy-health/proposal is the same handler', async () => {
  const r = await call('POST', '/galaxy-health/proposal', PROPOSAL_BODY);
  eq([r.status, r.json.operation], [200, 'createProposal'], 'status/operation');
});

const ORDER_BODY = {
  refId: 'REF-1', txnAmount: '405500', txnCurr: 'INR', referenceNo: 'Q1127', firstName: 'Asha', lastName: 'Rao',
  mobileNo: `+91${PERSON.mobile}`, emailId: PERSON.email, orderType: '01', partyCode: '', partyType: '', customerId: 'PHI1',
};
let orderPlain = null;
onGhi('/cbosgx-rpolicy/api/v2/createOrder', (entry) => {
  orderPlain = openRequest(entry);
  return ghiReply([{ returnUrl: 'https://uat-pay.example/cbospay-collections/order?orderid=abc', orderId: 'ORDER-1', expireDateTime: '2026-11-26 10:00:00' }]);
});

await test('POST /galaxy-health/createOrder → 200 with returnUrl and orderId (extractOrder)', async () => {
  const r = await call('POST', '/galaxy-health/createOrder', ORDER_BODY);
  eq([r.status, r.json.operation], [200, 'issuePolicy'], `status ${r.text.slice(0, 200)}`);
  eq([r.json.data.returnUrl, r.json.data.orderId], ['https://uat-pay.example/cbospay-collections/order?orderid=abc', 'ORDER-1'], 'order');
  eq(JSON.parse(orderPlain), ORDER_BODY, 'body reached GHI verbatim');
});

await test('/galaxy-health/issue is the same handler', async () => {
  const r = await call('POST', '/galaxy-health/issue', ORDER_BODY);
  eq([r.status, r.json.operation], [200, 'issuePolicy'], 'status/operation');
});

await test('createOrder without refId / txnAmount → 400 naming them, nothing sent', async () => {
  const before = received.length;
  const r = await call('POST', '/galaxy-health/createOrder', { txnCurr: 'INR', firstName: 'A', orderType: '01' });
  eq([r.status, r.json.error.code], [400, 'VALIDATION_ERROR'], 'status/code');
  eq(r.json.error.details.missing, ['refId', 'txnAmount'], 'missing');
  eq(sentSince(before).length, 0, 'requests sent');
});

await test('documents: upload / download / search reach GHI\'s utils paths', async () => {
  for (const [route, op] of [['uploadDocument', 'uploadDocument'], ['downloadDocument', 'downloadDocument'], ['searchDocument', 'searchDocument']]) {
    onGhi(`/cbosgx-utils/api/v2/${op}`, () => ghiReply([{ ok: op }]));
    const r = await call('POST', `/galaxy-health/${route}`, { documentId: 'D1' });
    eq([r.status, r.json.operation, r.json.data[0].ok], [200, op, op], route);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
heading('E. Ops: key rotation (X-Ops-Key, 3 fetches a day)');

const nextGhiKeys = nodeCrypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
let keyFetchPlain = null;
onGhi('/cbosgx-sec/api/v2/getCurrentPubKey', (entry) => {
  keyFetchPlain = openRequest(entry);
  // GHI UAT answered with our CURRENT key A (28 Oct 2026), bare: results only.
  const reply = ghiReply(pemBody(nextGhiKeys.publicKey));
  return { ...reply, body: { results: reply.body.results } };
});

for (const route of ['getCurrentPubKey', 'getNextPubKey', 'rotateKeys']) {
  await test(`ops/${route} without the key → 401, nothing sent`, async () => {
    const before = received.length;
    const r = await call('POST', `/galaxy-health/ops/${route}`, {});
    eq([r.status, r.json.error.code], [401, 'UNAUTHORIZED'], 'status/code');
    eq(sentSince(before).length, 0, 'requests sent');
  });
}

await test('a wrong key → 401', async () => {
  const r = await call('POST', '/galaxy-health/ops/getCurrentPubKey', {}, { 'X-Ops-Key': `${SECRETS.opsKey.slice(0, -1)}X` });
  eq(r.status, 401, 'status');
});

await test('switched off (503) while GX_OPS_KEY is unset', async () => {
  config.galaxy.opsKey = '';
  try {
    const r = await call('POST', '/galaxy-health/ops/getCurrentPubKey', {}, { 'X-Ops-Key': 'anything' });
    eq(r.status, 503, 'status');
    assert(/GX_OPS_KEY is not set/.test(r.json.error.message), r.json.error.message);
  } finally {
    config.galaxy.opsKey = SECRETS.opsKey;
  }
});

await test('getCurrentPubKey sends our NEW key B (bare SPKI), stores GHI\'s key, rotates ours, counts 1', async () => {
  const oldNc = keyStore.ncCurrent();
  const r = await call('POST', '/galaxy-health/ops/getCurrentPubKey', {}, { 'X-Ops-Key': SECRETS.opsKey });
  eq([r.status, r.json.operation], [200, 'refreshCurrentKey'], `status ${r.text.slice(0, 300)}`);
  assert(!keyFetchPlain.includes('BEGIN') && !/\s/.test(keyFetchPlain), 'payload is bare base64');
  const nowNc = keyStore.ncCurrent();
  eq(pemBody(nowNc.publicKey), keyFetchPlain, 'the key sent became our current key');
  eq(keyStore.ncPrev().publicKey, oldNc.publicKey, 'the replaced key is kept as nc-prev');
  eq(pemBody(keyStore.ghiCurrent()), pemBody(nextGhiKeys.publicKey), 'GHI\'s returned key stored');
  eq(keyStore.keyFetchesOn(), 1, 'fetches counted');
  assert(keyStore.hasGhiKeyFor(new Date(), '00:00'), 'today\'s key present');
});

await test('business calls then use GHI\'s new key', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => { openRequest(entry, nextGhiKeys.privateKey); return ghiReply(QUOTE_ANSWER); });
  const r = await call('POST', '/galaxy-health/quickQuote', QUOTE_BODY);
  eq(r.status, 200, `status ${r.text.slice(0, 200)}`);
});

await test('the 4th key fetch of the IST day → 503, nothing sent', async () => {
  fs.writeFileSync(path.join(KEY_DIR, 'key-fetches.json'), JSON.stringify({ istDate: istDate(), count: 3 }));
  const before = received.length;
  const r = await call('POST', '/galaxy-health/ops/getCurrentPubKey', {}, { 'X-Ops-Key': SECRETS.opsKey });
  eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], 'status/code');
  assert(/key fetches .* are used/.test(r.json.error.message), r.json.error.message);
  eq(sentSince(before).length, 0, 'requests sent');
});

await test('a key fetch is never retried, even on a 503', async () => {
  fs.writeFileSync(path.join(KEY_DIR, 'key-fetches.json'), JSON.stringify({ istDate: istDate(), count: 1 }));
  let hits = 0;
  onGhi('/cbosgx-sec/api/v2/getCurrentPubKey', () => { hits += 1; return { status: 503, body: {} }; });
  const r = await call('POST', '/galaxy-health/ops/getCurrentPubKey', {}, { 'X-Ops-Key': SECRETS.opsKey });
  eq([r.status, hits, keyStore.keyFetchesOn()], [502, 1, 2], 'status/hits/counted');
});

await test('rotateKeys with no ghi-next → promoted false', async () => {
  const r = await call('POST', '/galaxy-health/ops/rotateKeys', {}, { 'X-Ops-Key': SECRETS.opsKey });
  eq([r.status, r.json.data.promoted], [200, false], 'status/promoted');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('F. Key scheduler');

await test('isTransient: timeout, network failure and 5xx yes; GHI error envelope and 4xx no', () => {
  eq(isTransient({ code: 'TIMEOUT_ERROR' }), true, 'timeout');
  eq(isTransient({ code: 'UPSTREAM_ERROR', details: { errorCode: 'ECONNRESET' } }), true, 'network');
  eq(isTransient({ code: 'UPSTREAM_ERROR', details: { status: 503 } }), true, 'exhausted 503');
  eq(isTransient({ code: 'UPSTREAM_ERROR', details: { httpStatus: 500 } }), true, 'HTTP 500');
  eq(isTransient({ code: 'UPSTREAM_ERROR', details: { statusCode: 'CBOS-GXSEC-401' } }), false, 'GHI envelope');
  eq(isTransient({ code: 'UPSTREAM_ERROR', details: { httpStatus: 401 } }), false, '401');
  eq(isTransient({ code: 'PARSE_ERROR' }), false, 'parse');
});

await test('with today\'s key present it fetches nothing and waits for tomorrow', async () => {
  seedTodaysKey();
  const before = received.length;
  const s = startGxKeyScheduler(galaxyClient(), { at: '00:00', retryMinutes: 15 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  s.stop();
  eq(sentSince(before).length, 0, 'requests sent');
});

await test('a bad GX_KEY_REFRESH_AT fails at start-up', () => {
  try { startGxKeyScheduler(galaxyClient(), { at: '5:5' }); } catch (e) { eq(e.code, 'CONFIG_ERROR', 'code'); return; }
  throw new Error('started with a bad time');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('G. GHI\'s Marvel data dictionary (GALMARVEL_Data_Dictionary.ods)');

await test('the transcription is GHI\'s file (sha256 recorded) and indexes Marvel\'s codes', () => {
  eq(dictionary.SOURCE.sha256, '24226773686124c9925b0c9d4c9d30353f447e04be06c3cefd43d157d7b5c8e7', 'source sha256');
  eq(dictionary.codes('applicableSumInsured'), ['500000', '750000', '1000000', '1500000', '2000000', '2500000', '10000000', '20000000'], 'sum insured');
  eq(dictionary.codes('familySize').sort(), ['1A+1C', '1A+2C', '1A+3C', '2A', '2A+1C', '2A+2C', '2A+3C'], 'family sizes');
  eq(dictionary.find('memberRelationship', '24').name, 'Self', 'Self = 24');
  eq(dictionary.find('nomineeRelationship', '13').name, 'Spouse', 'nominee Spouse = 13');
  eq(dictionary.find('occupation', '1045').name, 'Private Sector - Service', 'occupation 1045');
  eq(dictionary.find('cover', 'PPN').name, 'Preferred Partner Network', 'cover code from Attribute Name');
});

await test('checkQuickQuote: the SPA\'s body is clean; missing deductibles and unlisted codes are reported', () => {
  eq(dictionary.checkQuickQuote({ productCode: 'GXGLXYMRVL', ...QUOTE_BODY }), { missing: [], notInDictionary: [] }, 'clean body');
  const m = { ...QUOTE_BODY.members[0], memberDetails: { ...QUOTE_BODY.members[0].memberDetails, relationship: '99' } };
  delete m.memberDetails.deductibleOptions;
  const r = dictionary.checkQuickQuote({ productCode: 'GXGLXYMRVL', ...QUOTE_BODY, members: [m] });
  eq(r.missing, ['members[0].memberDetails.deductibleOptions'], 'missing');
  eq(r.notInDictionary.map((x) => [x.field, x.value]), [['members[0].memberDetails.relationship', '99']], 'not in dictionary');
});

await test('the pre-flight is information only: an unlisted code is still sent to GHI', async () => {
  onGhi('/cbosgx-quote/api/v2/quickQuote', (entry) => { quoteEntry = { plaintext: openRequest(entry, nextGhiKeys.privateKey) }; return ghiReply(QUOTE_ANSWER); });
  keyStore.setGhiCurrent(nextGhiKeys.publicKey, new Date());
  const body = { ...QUOTE_BODY, basicDetails: { ...QUOTE_BODY.basicDetails, planType: 'ODD' } };
  const r = await call('POST', '/galaxy-health/quickQuote', body);
  eq(r.status, 200, 'status');
  eq(JSON.parse(quoteEntry.plaintext).basicDetails.planType, 'ODD', 'sent as given');
  assert(logged.some((l) => l.includes('quickQuote pre-flight')), 'pre-flight logged');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('H. Masking, configuration and the other insurers');

await test('maskPersonalData keeps codes and structure, replaces personal data', () => {
  const masked = maskPersonalData({ firstName: 'Asha', panNo: PERSON.pan, statusCode: '200', nested: [{ mobileNo: PERSON.mobile, addressLine1: 'x' }], note: `call ${PERSON.mobile}` });
  eq(masked, { firstName: MASK, panNo: MASK, statusCode: '200', nested: [{ mobileNo: MASK, addressLine1: MASK }], note: `call ${MASK}` }, 'masked');
});

await test('config/test → 200 when configured with today\'s key; no values in it', async () => {
  const r = await call('GET', '/galaxy-health/config/test');
  eq([r.status, r.json.ok, r.json.keys.todaysGhiKey, r.json.opsRoutesEnabled], [200, true, true, true], 'status/ok/key/ops');
  for (const v of [SECRETS.appKey, SECRETS.opsKey, 'BEGIN', 'PRODUCER-TEST']) assert(!r.text.includes(v), `${v} appeared`);
});

await test('unconfigured → every business route answers 503 naming the variables', async () => {
  const saved = { ...config.galaxy };
  Object.assign(config.galaxy, { baseUrl: null, channelId: null, appKey: null, ghiStaticPublicKey: null });
  try {
    for (const p of ['quickQuote', 'saveFullProposal', 'createOrder', 'searchDocument']) {
      const r = await call('POST', `/galaxy-health/${p}`, {});
      eq([r.status, r.json.error.code], [503, 'CONFIG_ERROR'], p);
      eq(r.json.error.details.missing, ['GX_BASE_URL', 'GX_CHANNEL_ID', 'GX_APP_KEY', 'GX_GHI_STATIC_PUBLIC_KEY'], `${p} missing`);
    }
  } finally {
    Object.assign(config.galaxy, saved);
  }
});

await test('an unknown /galaxy-health path → 404 envelope, not another router', async () => {
  const r = await call('POST', '/galaxy-health/getDomain', {});
  eq(r.status, 404, 'status');
  assert(/Route not found/.test(r.text), r.text);
});

await test('the other insurers\' routers are still mounted', async () => {
  for (const p of ['/chola-ms/config/test', '/icici-lombard/config/test', '/future-generali/config/test', '/iffcotokio/config/test']) {
    const r = await call('GET', p);
    assert(r.status !== 404, `${p} answered 404`);
  }
  eq((await call('GET', '/healthz')).status, 200, '/healthz');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('P. Payment: token API, callback, redirect, status');

const FRONT = 'https://uat-site.tommyandfurry.com/insurance/get-quote/health/galaxy-return';
let orderSeq = 0;
let lastOrderPlain = null;
onGhi('/cbosgx-rpolicy/api/v2/createOrder', (entry) => {
  lastOrderPlain = JSON.parse(openRequest(entry, nextGhiKeys.privateKey));
  orderSeq += 1;
  return ghiReply([{ returnUrl: `https://uat-pay.example/cbospay-collections/order?orderid=x${orderSeq}`, orderId: `2522261125TEST${orderSeq}`, expireDateTime: '2026-11-26 10:00:00' }]);
});
const newOrder = async (extra = {}) => {
  const r = await call('POST', '/galaxy-health/createOrder', { ...ORDER_BODY, referenceNo: `Q-PAY-${orderSeq + 1}`, frontendReturnUrl: FRONT, ...extra });
  assert(r.status === 200, `createOrder ${r.status} ${r.text.slice(0, 200)}`);
  return r.json.data.orderId;
};
/** GHI's result as an API-style envelope: AES with a fresh key wrapped for OUR public key. */
const envelopeOf = (fields) => {
  const key = gx.generateApiKey();
  const encryptedData = gx.aesEncrypt(JSON.stringify(fields), key);
  return { encryptedData, apiKey: gx.rsaEncryptApiKey(key, keyStore.ncCurrent().publicKey), checkSum: gx.checksum(key, encryptedData) };
};
const resultFor = (orderId, status, extra = {}) => ({
  proposalNo: 'Q1127', payment_id: 'PAY-1', currency: 'INR', datetime: '2026-11-25 16:20:00.000',
  order_id: orderId, status, amount: '4055.00', bank_ref_no: 'RRN-1', ...extra,
});
const statusOf = async (orderId) => (await call('GET', `/galaxy-health/payment/status/${orderId}`)).json?.data;
const captures = () => (fs.existsSync(path.join(PAY_DIR, 'captures')) ? fs.readdirSync(path.join(PAY_DIR, 'captures')).sort() : []);
let token = null;

await test('token API: JSON client credentials → Bearer token (1 h)', async () => {
  const r = await call('POST', '/galaxy-health/payment/token', { clientId: SECRETS.payClientId, clientSecret: SECRETS.payClientSecret });
  eq([r.status, r.json.token_type, r.json.expires_in], [200, 'Bearer', 3600], `token ${r.text.slice(0, 200)}`);
  token = r.json.access_token;
  assert(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), 'token shape');
});

await test('token API: Basic auth and OAuth2 form (client_id / client_secret) also work', async () => {
  const basic = Buffer.from(`${SECRETS.payClientId}:${SECRETS.payClientSecret}`).toString('base64');
  eq((await call('POST', '/galaxy-health/payment/token', {}, { Authorization: `Basic ${basic}` })).status, 200, 'Basic');
  const form = await fetch(`${APP}/galaxy-health/payment/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${SECRETS.payClientId}&client_secret=${SECRETS.payClientSecret}`,
  });
  eq(form.status, 200, 'form');
});

await test('token API: a wrong secret → 401; switched off (503) without GX_PAYMENT_CLIENT_*', async () => {
  eq((await call('POST', '/galaxy-health/payment/token', { clientId: SECRETS.payClientId, clientSecret: 'wrong' })).status, 401, 'wrong secret');
  const saved = config.galaxy.payment.clientSecret;
  config.galaxy.payment.clientSecret = null;
  try {
    eq((await call('POST', '/galaxy-health/payment/token', { clientId: SECRETS.payClientId, clientSecret: saved })).status, 503, 'off');
  } finally {
    config.galaxy.payment.clientSecret = saved;
  }
});

let orderA = null;
await test('createOrder keeps frontendReturnUrl with the order and never sends it to GHI', async () => {
  orderA = await newOrder();
  assert(!('frontendReturnUrl' in lastOrderPlain), 'frontendReturnUrl reached GHI');
  const s = await statusOf(orderA);
  eq([s.status, s.proposalNumber], ['CREATED', lastOrderPlain.referenceNo], 'order recorded');
  const rec = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'orders', `${orderA}.json`), 'utf8'));
  eq(rec.frontendReturnUrl, FRONT, 'page kept');
});

await test('a frontendReturnUrl on another origin is dropped; the payment still goes ahead', async () => {
  const id = await newOrder({ frontendReturnUrl: 'https://evil.example/insurance/get-quote/health/galaxy-return' });
  const rec = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'orders', `${id}.json`), 'utf8'));
  eq(rec.frontendReturnUrl, null, 'page dropped');
});

await test('callback without a token → 401, but captured', async () => {
  const before = captures().length;
  const r = await call('POST', '/galaxy-health/payment/callback', envelopeOf(resultFor(orderA, 'CHARGED')));
  eq([r.status, r.json.error.code], [401, 'UNAUTHORIZED'], 'status/code');
  eq(captures().length, before + 1, 'captured');
  eq((await statusOf(orderA)).status, 'CREATED', 'not applied');
});

await test('callback with a forged or expired token → 401', async () => {
  const [body] = token.split('.');
  const forged = `${body}.${Buffer.from('x'.repeat(32)).toString('base64url')}`;
  eq((await call('POST', '/galaxy-health/payment/callback', {}, { Authorization: `Bearer ${forged}` })).status, 401, 'forged');
  const expired = Buffer.from(JSON.stringify({ sub: SECRETS.payClientId, iat: 1, exp: 2, jti: 'x' })).toString('base64url');
  const key = nodeCrypto.createHash('sha256').update(`galaxy-payment-token|${SECRETS.payClientSecret}`).digest();
  const sig = nodeCrypto.createHmac('sha256', key).update(expired).digest('base64url');
  eq((await call('POST', '/galaxy-health/payment/callback', {}, { Authorization: `Bearer ${expired}.${sig}` })).status, 401, 'expired');
});

await test('callback with the token and GHI\'s encrypted envelope → 200 SUCCESS, order CHARGED', async () => {
  const r = await call('POST', '/galaxy-health/payment/callback', envelopeOf(resultFor(orderA, 'CHARGED')), { Authorization: `Bearer ${token}` });
  eq([r.status, r.json.status], [200, 'SUCCESS'], `status ${r.text}`);
  const s = await statusOf(orderA);
  eq([s.status, s.payment.paymentId, s.payment.bankRefNo, s.payment.scheme], ['CHARGED', 'PAY-1', 'RRN-1', 'gx-envelope'], 'applied');
});

await test('a later failure never overwrites CHARGED', async () => {
  await call('POST', '/galaxy-health/payment/callback', envelopeOf(resultFor(orderA, 'AUTHORIZATION_FAILED')), { Authorization: `Bearer ${token}` });
  eq((await statusOf(orderA)).status, 'CHARGED', 'still CHARGED');
});

await test('callback with plain fields is trusted (token-authenticated)', async () => {
  const id = await newOrder();
  const r = await call('POST', '/galaxy-health/payment/callback', resultFor(id, 'PENDING_VBV'), { Authorization: `Bearer ${token}` });
  eq(r.status, 200, 'status');
  eq((await statusOf(id)).status, 'PENDING_VBV', 'applied');
});

await test('callback encrypted with a static AES key (GX_PAYMENT_AES_KEY) → applied', async () => {
  const id = await newOrder();
  config.galaxy.payment.aesKey = 'K3y-For-Static-AES-0123456789abc';
  try {
    const enc = gx.aesEncrypt(JSON.stringify(resultFor(id, 'CHARGED')), config.galaxy.payment.aesKey);
    const r = await call('POST', '/galaxy-health/payment/callback', { encData: enc }, { Authorization: `Bearer ${token}` });
    eq(r.status, 200, 'status');
    const s = await statusOf(id);
    eq([s.status, s.payment.scheme], ['CHARGED', 'static-aes'], 'applied');
  } finally {
    config.galaxy.payment.aesKey = null;
  }
});

await test('redirect with GHI\'s encrypted envelope (form POST) → 303 to the order\'s page, status applied', async () => {
  const id = await newOrder();
  const res = await fetch(`${APP}/health/galaxy-health/payment/return`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(envelopeOf(resultFor(id, 'AUTHENTICATION_FAILED'))).toString(),
  });
  eq([res.status, res.headers.get('location')], [303, `${FRONT}?ref=${id}`], 'redirect');
  eq((await statusOf(id)).status, 'AUTHENTICATION_FAILED', 'applied');
});

await test('redirect with plain query fields → routed to the page, status NOT applied (unverified)', async () => {
  const id = await newOrder();
  const res = await fetch(`${APP}/galaxy-health/payment/return?order_id=${id}&status=CHARGED`, { redirect: 'manual' });
  eq([res.status, res.headers.get('location')], [303, `${FRONT}?ref=${id}`], 'redirect');
  eq((await statusOf(id)).status, 'CREATED', 'not applied');
});

await test('redirect nothing can read → 303 to GX_PAYMENT_FRONTEND_RETURN_URL, captured as received', async () => {
  const res = await fetch(`${APP}/galaxy-health/payment/return`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'text/plain' }, body: 'opaque-ciphertext-AAAA' });
  eq([res.status, res.headers.get('location')], [303, FRONT], 'redirect');
  const cap = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'captures', captures().pop()), 'utf8'));
  eq([cap.via, cap.rawBody], ['return', 'opaque-ciphertext-AAAA'], 'captured');
});

await test('captures keep no credential values', () => {
  const all = captures().map((f) => fs.readFileSync(path.join(PAY_DIR, 'captures', f), 'utf8')).join('\n');
  assert(!all.includes(token), 'Bearer token in a capture');
  assert(!all.includes(SECRETS.payClientSecret), 'client secret in a capture');
});

await test('callback with malformed JSON → 400 MALFORMED_JSON, captured byte for byte, never 200', async () => {
  const r = await call('POST', '/galaxy-health/payment/callback', undefined, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` });
  // (call() sends no body when given undefined; send the malformed body directly)
  const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{"order_id": "X", bad' });
  const j = await res.json();
  eq([res.status, j.error.code, j.error.details.stored], [400, 'MALFORMED_JSON', true], 'status/code/stored');
  const cap = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'captures', captures().pop()), 'utf8'));
  eq([cap.rawBody, cap.bodyProblem], ['{"order_id": "X", bad', 'malformed-json'], 'captured as received');
  eq(r.status, 400, 'an empty JSON body is refused too (EMPTY_PAYLOAD)');
});

await test('callback with an unsupported Content-Type (XML) → 415, captured, never 200', async () => {
  const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { 'Content-Type': 'application/xml', Authorization: `Bearer ${token}` }, body: '<order_id>X</order_id>' });
  const j = await res.json();
  eq([res.status, j.error.code, j.error.details.stored], [415, 'UNSUPPORTED_CONTENT_TYPE', true], 'status/code/stored');
  const cap = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'captures', captures().pop()), 'utf8'));
  eq(cap.rawBody, '<order_id>X</order_id>', 'captured as received');
});

await test('callback with NO Content-Type header → 415, body still captured', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Length': 9 } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end('raw-bytes');
  });
  eq(status, 415, 'status');
  const cap = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'captures', captures().pop()), 'utf8'));
  eq([cap.rawBody, cap.headers['content-type']], ['raw-bytes', null], 'captured');
});

await test('callback with neither body nor query → 400 EMPTY_PAYLOAD', async () => {
  const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  eq([res.status, (await res.json()).error.code], [400, 'EMPTY_PAYLOAD'], 'status/code');
});

await test('callback that cannot be stored → 500 NOT_STORED, never acknowledged', async () => {
  const blocker = path.join(os.tmpdir(), `gx-not-a-dir-${process.pid}`);
  fs.writeFileSync(blocker, 'x');
  const saved = config.galaxy.payment.storeDir;
  config.galaxy.payment.storeDir = blocker;
  try {
    const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(resultFor(orderA, 'CHARGED')) });
    const j = await res.json();
    eq([res.status, j.error.code, j.error.details.stored], [500, 'NOT_STORED', false], 'status/code/stored');
  } finally {
    config.galaxy.payment.storeDir = saved;
    fs.rmSync(blocker, { force: true });
  }
});

await test('callback larger than GX_JSON_BODY_LIMIT → 413 PAYLOAD_TOO_LARGE, never 200', async () => {
  const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }, body: 'x'.repeat(5 * 1024 * 1024 + 10) });
  const j = await res.json();
  eq([res.status, j.error.code, j.error.details.stored], [413, 'PAYLOAD_TOO_LARGE', false], 'status/code/stored');
});

await test('redirect with malformed JSON or XML still sends the buyer on, and is captured', async () => {
  for (const [type, body] of [['application/json', '{bad'], ['application/xml', '<x/>']]) {
    const res = await fetch(`${APP}/galaxy-health/payment/return`, { method: 'POST', redirect: 'manual', headers: { 'Content-Type': type }, body });
    eq([res.status, res.headers.get('location')], [303, FRONT], type);
    const cap = JSON.parse(fs.readFileSync(path.join(PAY_DIR, 'captures', captures().pop()), 'utf8'));
    eq(cap.rawBody, body, `${type} captured`);
  }
});

await test('no return page known → a neutral page that claims no payment outcome', async () => {
  const saved = config.galaxy.payment.frontendReturnUrl;
  config.galaxy.payment.frontendReturnUrl = null;
  try {
    for (const p of ['/galaxy-health/payment/return', '/galaxy-health/payment/return?order_id=UNKNOWN&status=CHARGED']) {
      const res = await fetch(`${APP}${p}`, { redirect: 'manual' });
      const text = await res.text();
      eq(res.status, 200, `${p} status`);
      assert(/could not confirm the status/i.test(text), `neutral wording: ${text}`);
      assert(!/received|success|successful|paid|confirmed\b/i.test(text.replace(/could not confirm/i, '')), `claims an outcome: ${text}`);
    }
  } finally {
    config.galaxy.payment.frontendReturnUrl = saved;
  }
});

await test('a fallback page on a disallowed origin is ignored → neutral page', async () => {
  const saved = config.galaxy.payment.frontendReturnUrl;
  config.galaxy.payment.frontendReturnUrl = 'https://evil.example/insurance/get-quote/health/galaxy-return';
  try {
    const res = await fetch(`${APP}/galaxy-health/payment/return`, { redirect: 'manual' });
    eq([res.status, res.headers.get('location')], [200, null], 'not redirected off-site');
  } finally {
    config.galaxy.payment.frontendReturnUrl = saved;
  }
});

await test('the JSON/form parsers do not re-read a payment body (raw reader first)', async () => {
  const id = await newOrder();
  const res = await fetch(`${APP}/galaxy-health/payment/callback`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Bearer ${token}` }, body: new URLSearchParams(envelopeOf(resultFor(id, 'CHARGED'))).toString() });
  eq(res.status, 200, 'status');
  eq((await statusOf(id)).status, 'CHARGED', 'form envelope decoded from the raw body');
});

await test('status of an unknown order → 404', async () => {
  const r = await call('GET', '/galaxy-health/payment/status/NOPE-1');
  eq([r.status, r.json.error.code], [404, 'NOT_FOUND'], 'status/code');
});

// ═════════════════════════════════════════════════════════════════════════════
heading('L. Logging never leaks a credential or personal data');

await test('no appKey, ops key, private key, PAN, mobile or e-mail was logged', () => {
  const all = logged.join('\n');
  const privateKeys = fs.readdirSync(KEY_DIR).filter((f) => f.endsWith('.key')).map((f) => fs.readFileSync(path.join(KEY_DIR, f), 'utf8'));
  for (const [name, value] of [
    ['appKey', SECRETS.appKey], ['ops key', SECRETS.opsKey], ['payment client secret', SECRETS.payClientSecret], ['PAN', PERSON.pan], ['mobile', PERSON.mobile], ['e-mail', PERSON.email],
    ['GHI private key', ghiKeys.privateKey.split('\n')[1]],
    ...privateKeys.map((k, i) => [`NovaCred private key ${i}`, k.split('\n')[1]]),
  ]) {
    assert(!all.includes(value), `${name} appeared in the log`);
  }
  assert(!all.includes('PRIVATE KEY'), 'a private key appeared in the log');
  return `${logged.length} log lines checked`;
});

// ── Done ────────────────────────────────────────────────────────────────────

server.close();
mock.close();
await db.closePool().catch(() => {});
fs.rmSync(KEY_DIR, { recursive: true, force: true });
fs.rmSync(PAY_DIR, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  out('\nFailed:');
  for (const f of failed) out(`  ✗ [${f.section}] ${f.name}\n      ${f.error.split('\n').join('\n      ')}`);
}
process.exit(failed.length ? 1 : 0);
