// Replays the local run of 2026-10-31 (application 793429106310) over real HTTP
// against the real Express app, with the local backend's effective settings:
// NODE_ENV=uat from .env, and .env.local's FRONTEND_URL on the old app's dev
// server (localhost:8080). That day the browser came back to
// http://localhost:8080/#/health-insurance/nivabupa-return?..., the old app,
// because the running backend could not send it anywhere else.
//
// Only Niva Bupa's SOAP encrypt/decrypt is replaced, and MySQL is pointed at a
// port nothing listens on, so nothing is sent anywhere and nothing is written
// to a database: every journey write fails into safeSave, as on UAT today.
//
//   npm run test:nivabupa-return
import { after, before, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

const givenDir = process.env.NIVABUPA_RETURN_TARGET_DIR;
const dir = givenDir || mkdtempSync(join(tmpdir(), 'nivabupa-return-local-'));
const existing = new Set(readdirSync(dir));
const writtenByThisRun = (name) => !existing.has(name)
  && (name.includes('.nivabupa-return.json') || /^returnmessage.*\.txt$/.test(name));

// The local backend's effective values: .env.local wins over .env.
process.env.NODE_ENV = 'uat';
process.env.FRONTEND_URL = 'http://localhost:8080/#/health-insurance';
process.env.FRONTEND_RETURN_PATH = '/nivabupa-return';
process.env.NIVABUPA_PAYMENT_RETURN_URL = 'http://localhost:4000/nivabupa/payment/return';
// Unset locally, so the defaults apply. Empty rather than deleted, so a .env
// in the working directory cannot fill it in.
process.env.NIVABUPA_FRONTEND_RETURN_ORIGINS = '';
process.env.NIVABUPA_RETURN_TARGET_DIR = dir;
process.env.NIVABUPA_DB_HOST = '127.0.0.1';
process.env.NIVABUPA_DB_PORT = '1';

const encrypted = [];
let decrypted = null;
mock.module(new URL('../src/services/soap.service.js', import.meta.url).href, {
  namedExports: {
    encryptPaymentParams: async (querystring) => {
      encrypted.push(querystring);
      return 'ENCPARAM';
    },
    decryptPaymentReturn: async () => decrypted,
  },
});

const { default: config } = await import('../src/config/env.js');
const { createApp } = await import('../src/app.js');
const { default: db } = await import('../src/db/index.js');

const APP_NO = '793429106310';
const NEW_UI_PAGE = 'http://localhost:5173/insurance/get-quote/health/nivabupa-return';
// The query string of the redirect reported that day, byte for byte.
const REPORTED_QUERY = 'status=SUCCESS&policyNumber=793429106310&premium=3824&paymentTxnId=31543607837&paymentDate=10%2F31%2F2026+12%3A19%3A15';
// What Niva Bupa's gateway reported for it, in the documented pipe layout.
const GATEWAY_RECORD = (reference) => `MAXBUPA|${reference}|3824|10/31/2026 12:19:15|${reference}|31543607837|M001||N||JUSPAY`;

const logs = [];
const savedConsole = { log: console.log, warn: console.warn, error: console.error };
let server;
let base;

before(async () => {
  // format() as console itself does: req.query has no prototype, so String() on it throws.
  for (const method of Object.keys(savedConsole)) console[method] = (...args) => logs.push(format(...args));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await db.closePool().catch(() => undefined);
  Object.assign(console, savedConsole);
  for (const name of readdirSync(dir)) {
    if (writtenByThisRun(name)) unlinkSync(join(dir, name));
  }
  if (!givenDir) rmSync(dir, { recursive: true, force: true });
});

// The body the New UI sends (services/health/nivabupa/flow.ts), as JSON, with
// the dev server's Origin, to the URL its .env.local points at.
async function initiate(body) {
  const res = await fetch(`${base}/health/nivabupa/payment/initiate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:5173' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json(), allowOrigin: res.headers.get('access-control-allow-origin') };
}

function newUiPaymentBody(unqPolicyNumber, extra = {}) {
  return {
    unqPolicyNumber,
    premiumValue: 3824,
    additionalComment: `${unqPolicyNumber},3824`,
    channel: 'ONLINE',
    subchannel: 'WEB',
    sourcingsystem: 'Novacred',
    productname: 'REASSURE30',
    mobile: '9876543210',
    email: 'asha@example.com',
    suminsured: '500000',
    tenure: 1,
    ...extra,
  };
}

// The gateway's form POST back to NIVABUPA_PAYMENT_RETURN_URL.
async function gatewayReturn(record) {
  decrypted = record;
  // captureCiphertext writes its debugging copies into the working directory.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    const res = await fetch(`${base}/nivabupa/payment/return`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'returnMessage=CIPHERTEXT',
      redirect: 'manual',
    });
    const location = res.headers.get('location');
    // On anything but a redirect, say why: the response and the server's last words.
    const why = location ? '' : `${await res.text()}\n${logs.slice(-12).join('\n')}`;
    return { status: res.status, location, why };
  } finally {
    process.chdir(cwd);
  }
}

test('with the local settings (NODE_ENV=uat, FRONTEND_URL on localhost), the local dev server is an allowed return origin', () => {
  assert.ok(config.nivabupa.payment.frontendReturnOrigins.includes('http://localhost:5173'));
  assert.ok(config.nivabupa.payment.frontendReturnOrigins.includes('https://uat-site.tommyandfurry.com'));
});

test('a payment that names no page comes back exactly as on 31 Oct: the old app on localhost:8080', async () => {
  const started = await initiate(newUiPaymentBody(APP_NO));
  assert.equal(started.status, 200);
  const back = await gatewayReturn(GATEWAY_RECORD(APP_NO));
  assert.equal(back.status, 302, back.why);
  assert.equal(back.location, `http://localhost:8080/#/health-insurance/nivabupa-return?${REPORTED_QUERY}`);
});

test("the New UI's payment comes back to the New UI on localhost:5173, with the same query string", async () => {
  const started = await initiate(newUiPaymentBody(APP_NO, { frontendReturnUrl: NEW_UI_PAGE }));
  assert.equal(started.status, 200);
  assert.equal(started.body.status, 'SUCCESS');
  assert.equal(started.body.encparam, 'ENCPARAM');
  assert.ok(['*', 'http://localhost:5173'].includes(started.allowOrigin), `CORS: ${started.allowOrigin}`);

  // The gateway gets the same querystring as before, its returnPath still the backend.
  const querystring = encrypted.at(-1);
  assert.ok(querystring.includes('returnPath=http://localhost:4000/nivabupa/payment/return'));
  assert.equal(querystring.includes('frontendReturnUrl'), false);
  assert.equal(querystring.includes('localhost:5173'), false);
  assert.equal(querystring, encrypted.at(-2), 'the encrypted querystring differs from the payment that named no page');

  // Kept against the application number, exactly as sent.
  const kept = JSON.parse(readFileSync(join(dir, `${APP_NO}.nivabupa-return.json`), 'utf8'));
  assert.equal(kept.url, NEW_UI_PAGE);
  assert.ok(logs.some((line) => line.includes(`Return page for ${APP_NO}: ${NEW_UI_PAGE}`)));

  const back = await gatewayReturn(GATEWAY_RECORD(APP_NO));
  assert.equal(back.status, 302);
  assert.equal(back.location, `${NEW_UI_PAGE}?${REPORTED_QUERY}`);
});

test('a dev server on a port that is not configured is refused and falls back to the old app', async () => {
  const other = '793429106311';
  const started = await initiate(newUiPaymentBody(other, { frontendReturnUrl: 'http://localhost:5174/insurance/get-quote/health/nivabupa-return' }));
  assert.equal(started.status, 200);
  assert.equal(existsSync(join(dir, `${other}.nivabupa-return.json`)), false);
  const back = await gatewayReturn(GATEWAY_RECORD(other));
  assert.ok(back.location.startsWith('http://localhost:8080/#/health-insurance/nivabupa-return?'), back.location);
});
