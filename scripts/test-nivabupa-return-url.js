// Proves the Niva Bupa per-payment return page (payment/initiate's
// frontendReturnUrl) through the real payment controller, with the only two
// things a test cannot do replaced: Niva Bupa's SOAP encrypt/decrypt and MySQL.
// No network, no database, no payment, nothing sent to Niva Bupa.
//
//   npm run test:nivabupa-return
//
// Needs Node's --experimental-test-module-mocks (Node 22.3+), which the npm
// script passes. The store writes into a fresh temporary directory, or into an
// existing one named by NIVABUPA_RETURN_TARGET_DIR. Either way only files this
// run created, and only of the two kinds it writes, are removed at the end, so
// a shared directory loses nothing else.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

const givenDir = process.env.NIVABUPA_RETURN_TARGET_DIR;
const dir = givenDir || mkdtempSync(join(tmpdir(), 'nivabupa-return-test-'));
const existing = new Set(readdirSync(dir));
// The store's own files, and captureCiphertext's debugging copies of the callback.
const writtenByThisRun = (name) => !existing.has(name)
  && (name.includes('.nivabupa-return.json') || /^returnmessage.*\.txt$/.test(name));

// The old app's documented UAT value (.env.example), hash route and all.
const FRONTEND_URL = 'https://insurance.tommyandfurry.com/tommyandfurryuat/#/health-insurance';
const OLD_APP_RETURN = `${FRONTEND_URL}/nivabupa-return`;
const PAGE = 'https://uat-site.tommyandfurry.com/insurance/get-quote/health/nivabupa-return';

process.env.NIVABUPA_RETURN_TARGET_DIR = dir;
process.env.FRONTEND_URL = FRONTEND_URL;
process.env.FRONTEND_RETURN_PATH = '/nivabupa-return';
// A trailing slash and a space, as a hand-edited .env would have them.
process.env.NIVABUPA_FRONTEND_RETURN_ORIGINS = 'https://uat-site.tommyandfurry.com, https://www.tommyandfurry.com/';

// For the pruning test: an expired record of the store's own and someone else's
// old file, both in place before this run's first save runs the hourly prune.
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
const expiredOwn = join(dir, 'NB100012.nivabupa-return.json');
const foreign = join(dir, 'NB100011-not-ours.json');
writeFileSync(expiredOwn, JSON.stringify({ referenceId: 'NB100012', url: PAGE, savedAt: THIRTY_DAYS_AGO.toISOString() }), 'utf8');
writeFileSync(foreign, '{}', 'utf8');
utimesSync(expiredOwn, THIRTY_DAYS_AGO, THIRTY_DAYS_AGO);
utimesSync(foreign, THIRTY_DAYS_AGO, THIRTY_DAYS_AGO);

const encrypted = [];
let decryptResult = null;

mock.module(new URL('../src/services/soap.service.js', import.meta.url).href, {
  namedExports: {
    encryptPaymentParams: async (querystring) => {
      encrypted.push(querystring);
      return 'ENCPARAM';
    },
    decryptPaymentReturn: async () => {
      if (decryptResult instanceof Error) throw decryptResult;
      return decryptResult;
    },
  },
});
mock.module(new URL('../src/services/journey.service.js', import.meta.url).href, {
  namedExports: {
    safeSave: async (_name, fn) => fn(),
    recordPaymentInitiate: async () => null,
    recordPaymentCallback: async () => null,
    recordPaymentCallbackFailure: async () => null,
  },
});
mock.module(new URL('../src/repositories/log.repository.js', import.meta.url).href, {
  namedExports: { recordError: async () => null },
});

const { initiatePayment, handlePaymentReturn } = await import('../src/controllers/payment.controller.js');

after(() => {
  if (existsSync(foreign)) unlinkSync(foreign);
  for (const name of readdirSync(dir)) {
    if (writtenByThisRun(name)) unlinkSync(join(dir, name));
  }
  if (!givenDir) rmSync(dir, { recursive: true, force: true });
});

function fakeRes() {
  const res = { statusCode: 200, body: undefined, location: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  res.redirect = (code, url) => { res.statusCode = code; res.location = url; return res; };
  return res;
}

// The controller logs every step; keep them, but off the test output.
async function quietly(fn) {
  const logs = [];
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const method of Object.keys(saved)) console[method] = (...args) => logs.push(format(...args));
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return logs;
}

// The body the new site sends (services/health/nivabupa/flow.ts).
function paymentBody(unqPolicyNumber, extra = {}) {
  return {
    unqPolicyNumber,
    premiumValue: 12500,
    additionalComment: `${unqPolicyNumber},12500`,
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

async function initiate(body) {
  const req = { body, journeyId: null, journey: null, journeyContext: {} };
  const res = fakeRes();
  const logs = await quietly(() => initiatePayment(req, res));
  return { req, res, logs, querystring: encrypted.at(-1) };
}

// Niva Bupa's documented pipe layout, M001 = success.
function returnMessage(reference, { status = 'M001', failedReason = '' } = {}) {
  return `MAXBUPA|${reference}|12500.00|31-10-2026 11:25:01|${reference}|TXN-${reference}|${status}|${failedReason}|N||JUSPAY`;
}

// What handlePaymentReturn puts on the redirect, in its order.
function outcomeQuery(reference, { status = 'SUCCESS', message } = {}) {
  const query = new URLSearchParams({
    status,
    policyNumber: reference,
    premium: '12500.00',
    paymentTxnId: `TXN-${reference}`,
    paymentDate: '31-10-2026 11:25:01',
  });
  if (message) query.set('message', message);
  return query.toString();
}

async function callback(decrypted) {
  decryptResult = decrypted;
  const req = {
    body: { returnMessage: 'CIPHERTEXT' },
    query: {},
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    originalUrl: '/nivabupa/payment/return',
    method: 'POST',
    ip: '127.0.0.1',
  };
  const res = fakeRes();
  // captureCiphertext writes its debugging copies into the working directory.
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    res.logs = await quietly(() => handlePaymentReturn(req, res));
  } finally {
    process.chdir(cwd);
  }
  return res;
}

const kept = (reference) => join(dir, `${reference}.nivabupa-return.json`);

function keepByHand(reference, url, savedAt = new Date()) {
  writeFileSync(kept(reference), JSON.stringify({ referenceId: reference, url, savedAt: savedAt.toISOString() }), 'utf8');
}

test('a payment that names no page returns to FRONTEND_URL, exactly as before', async () => {
  const { res } = await initiate(paymentBody('NB100001'));
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'SUCCESS');
  assert.equal(existsSync(kept('NB100001')), false);

  const back = await callback(returnMessage('NB100001'));
  assert.equal(back.statusCode, 302);
  assert.equal(back.location, `${OLD_APP_RETURN}?${outcomeQuery('NB100001')}`);
});

test("the new site's page is kept and used, and the encrypted querystring is byte-identical", async () => {
  const { querystring: plain } = await initiate(paymentBody('NB100002'));
  const { req, res, querystring: named } = await initiate(paymentBody('NB100002', { frontendReturnUrl: PAGE }));
  assert.equal(res.statusCode, 200);
  assert.equal(named, plain);
  assert.equal(named.includes('frontendReturnUrl'), false);
  assert.equal(named.includes('uat-site'), false);
  assert.equal(Object.hasOwn(req.body, 'frontendReturnUrl'), false);
  assert.equal(existsSync(kept('NB100002')), true);

  const back = await callback(returnMessage('NB100002'));
  assert.equal(back.statusCode, 302);
  assert.equal(back.location, `${PAGE}?${outcomeQuery('NB100002')}`);
});

test('a failed payment returns to the page it named, with the same status and reason as before', async () => {
  await initiate(paymentBody('NB100003', { frontendReturnUrl: PAGE }));
  const back = await callback(returnMessage('NB100003', { status: 'M002', failedReason: 'Declined by bank' }));
  assert.equal(back.location, `${PAGE}?${outcomeQuery('NB100003', { status: 'FAILED_OR_OTHER', message: 'Declined by bank' })}`);
});

test('a page that is not allowed is ignored with a warning, and the payment still goes ahead', async () => {
  const refused = [
    'https://evil.example/insurance/get-quote/health/nivabupa-return',
    'https://uat-site.tommyandfurry.com/insurance/get-quote/health/fg-return',
    `${PAGE}?next=https://evil.example`,
    `${PAGE}#top`,
    'https://user:pw@uat-site.tommyandfurry.com/insurance/get-quote/health/nivabupa-return',
    '/insurance/get-quote/health/nivabupa-return',
    'javascript:alert(1)//nivabupa-return',
    { url: PAGE },
    // A deployed backend (FRONTEND_URL not on localhost) never sends a buyer to localhost.
    'http://localhost:5173/insurance/get-quote/health/nivabupa-return',
  ];
  for (const [index, value] of refused.entries()) {
    const reference = `NB10004${index}`;
    const { res, logs, querystring } = await initiate(paymentBody(reference, { frontendReturnUrl: value }));
    assert.equal(res.statusCode, 200, `payment refused for ${JSON.stringify(value)}`);
    assert.equal(querystring.includes('frontendReturnUrl'), false);
    assert.ok(logs.some((line) => line.includes('frontendReturnUrl ignored')), `no warning for ${JSON.stringify(value)}`);
    assert.equal(existsSync(kept(reference)), false, `kept ${JSON.stringify(value)}`);
    const back = await callback(returnMessage(reference));
    assert.equal(back.location, `${OLD_APP_RETURN}?${outcomeQuery(reference)}`);
  }
});

test('an undecryptable callback still goes to FRONTEND_URL with status=ERROR, unchanged', async () => {
  await initiate(paymentBody('NB100005', { frontendReturnUrl: PAGE }));
  const back = await callback(new Error('decResp HTTP 500'));
  assert.equal(back.statusCode, 302);
  assert.ok(back.location.startsWith(`${OLD_APP_RETURN}?status=ERROR&message=`), back.location);
});

test('the page lives on disk, not in this process: a record written outside it is honoured', async () => {
  keepByHand('NB100006', PAGE);
  const back = await callback(returnMessage('NB100006'));
  assert.equal(back.location, `${PAGE}?${outcomeQuery('NB100006')}`);
});

test('an expired record, or one whose origin is no longer allowed, falls back to FRONTEND_URL', async () => {
  keepByHand('NB100007', PAGE, new Date(Date.now() - 73 * 60 * 60 * 1000));
  const expired = await callback(returnMessage('NB100007'));
  assert.equal(expired.location, `${OLD_APP_RETURN}?${outcomeQuery('NB100007')}`);

  keepByHand('NB100008', 'https://evil.example/insurance/get-quote/health/nivabupa-return');
  const tampered = await callback(returnMessage('NB100008'));
  assert.equal(tampered.location, `${OLD_APP_RETURN}?${outcomeQuery('NB100008')}`);
  assert.ok(tampered.logs.some((line) => line.includes('no longer allowed')));
});

test('a repeated initiate for the same number replaces the page; a configured trailing slash still matches', async () => {
  const www = 'https://www.tommyandfurry.com/insurance/get-quote/health/nivabupa-return';
  await initiate(paymentBody('NB100009', { frontendReturnUrl: www }));
  assert.equal((await callback(returnMessage('NB100009'))).location, `${www}?${outcomeQuery('NB100009')}`);
  await initiate(paymentBody('NB100009', { frontendReturnUrl: PAGE }));
  assert.equal((await callback(returnMessage('NB100009'))).location, `${PAGE}?${outcomeQuery('NB100009')}`);
});

test('a reference that could climb out of the directory is never used as a file name', async () => {
  const { res, logs } = await initiate(paymentBody('../NB100010', { frontendReturnUrl: PAGE }));
  assert.equal(res.statusCode, 200);
  assert.ok(logs.some((line) => line.includes('not a usable reference')));
  assert.equal(existsSync(join(dir, '..', 'NB100010.nivabupa-return.json')), false);
  assert.equal(existsSync(join(dir, '..NB100010.nivabupa-return.json')), false);
});

test("pruning removes the store's own expired records and never touches anything else", () => {
  // Both were seeded before this run's first save, which ran the hourly prune.
  assert.equal(existsSync(expiredOwn), false, 'an expired record of ours survived the prune');
  assert.equal(existsSync(foreign), true, "the prune deleted a file that was not the store's");
});
