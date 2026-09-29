// ─────────────────────────────────────────────────────────────────────────────
// NivaBupa KYC (CKYC OTP flow) — offline test suite.
//
//   npm run test:nivabupa-kyc             no database (closed port)
//   npm run test:nivabupa-kyc -- --db     full OTP flow against the MySQL in
//                                         .env (needs migration 003; test rows
//                                         are removed afterwards)
//
// Drives /nivabupa/kyc/{EKYCOTPDetailEnc,EKYCDetailEnc,ReSendOTPEnc},
// /nivabupa/uw-decision and /nivabupa/datapush
// through the REAL Express app against a local mock speaking NivaBupa's wire
// format: encrypted { payload } KYC envelopes, the generic OAuth token,
// uwDecision and datapush. No request leaves this machine.
//
// What it proves:
//   * the KYC APIs are called with PartnerName / AthorizationToken and an
//     encrypted body carrying the documented fields
//   * `verified` comes only from NivaBupa's EKYCDetailEnc response — a wrong
//     OTP, a rejected PAN or a pending OTP never verifies
//   * CYCRequestId / CKYCTransactionID stay server-side
//   * underwriting is refused before any upstream call unless KYC is verified
//     for the same application number, and forwarded unchanged when it is
//   * Data Push is never blocked; with verified KYC it carries the CKYC number
//     and PAN in PROPOSER.KYC and is otherwise identical
//   * no credential, token or OTP is logged or audited
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

const WITH_DB = process.argv.includes('--db');

// ── 1. Mock NivaBupa ────────────────────────────────────────────────────────

const received = [];
const handlers = new Map();
const on = (path, handler) => handlers.set(path, handler);
const hits = (path) => received.filter((r) => r.path === path);

const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const path = req.url.split('?')[0];
    let json = null;
    try { json = raw ? JSON.parse(raw) : null; } catch { json = null; }
    const entry = { path, headers: req.headers, raw, json };
    received.push(entry);
    const handler = handlers.get(path);
    if (!handler) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ mock: `no handler for ${path}` }));
      return;
    }
    const out = await handler(entry);
    res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.json ?? {}));
  });
});
await new Promise((resolve) => mock.listen(0, '127.0.0.1', resolve));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const KYC = '/kyc/t/api/KYCNew';

// ── 2. Pin the environment BEFORE config is imported ────────────────────────

const TEST = {
  partnerName: 'test-partner-name-4b1e',
  username: 'test-kyc-user',
  password: 'test-kyc-password-8d2f',
  key: 'test-kyc-key-0123456789abcdef',
  token: 'test-kyc-token-7a9c',
  otp: '482913',
};

Object.assign(process.env, {
  NIVABUPA_KYC_BASE_URL: `${MOCK}${KYC}`,
  NIVABUPA_KYC_PARTNER_NAME: TEST.partnerName,
  NIVABUPA_KYC_USERNAME: TEST.username,
  NIVABUPA_KYC_PASSWORD: TEST.password,
  NIVABUPA_KYC_ENCRYPTION_KEY: TEST.key,
  NIVABUPA_KYC_TIMEOUT_MS: '5000',
  NIVABUPA_TOKEN_URL: `${MOCK}/api/generic/token`,
  NIVABUPA_UW_DECISION_URL: `${MOCK}/api/generic/uwDecision`,
  NIVABUPA_DATAPUSH_URL: `${MOCK}/api/generic/datapush`,
  NIVABUPA_API_TIMEOUT_MS: '5000',
  NIVABUPA_DATAPUSH_TIMEOUT_MS: '5000',
  NIVABUPA_DEBUG: '0',
  NIVABUPA_ALIAS_PREFIX: '/health',
  NIVABUPA_CORS_ORIGINS: '*',
});
if (!WITH_DB) {
  Object.assign(process.env, {
    NIVABUPA_DB_HOST: '127.0.0.1',
    NIVABUPA_DB_PORT: '1',
    NIVABUPA_DB_CONNECT_TIMEOUT_MS: '500',
  });
}

// ── 3. Capture logs, to prove nothing secret is printed ─────────────────────

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
const { default: db } = await import('../src/db/index.js');
const { encryptKycPayload, decryptKycPayload } = await import('../src/helpers/nivabupaKycCrypto.helper.js');
const kycService = await import('../src/services/nivabupaKyc.service.js');

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const APP_PORT = server.address().port;

function call(method, path, body, headers = {}) {
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
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch { json = null; }
        resolve({ status: res.statusCode, json, raw: data });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timed out')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// ── 5. Mock behaviour ───────────────────────────────────────────────────────

const enc = (value) => ({ payload: encryptKycPayload(JSON.stringify(value), TEST.key) });
const decryptBody = (entry) => JSON.parse(decryptKycPayload(entry.json?.payload, TEST.key));
const authorised = (entry) => entry.headers.partnername === TEST.partnerName && entry.headers.athorizationtoken === TEST.token;

let tokenResponse = { access_token: TEST.token, token_type: 'bearer', expires_in: 0, Status: '200', Message: 'Success' };
const REJECTED_PAN = 'REJCT1234X';
const issued = new Map();   // "CYCRequestId|CKYCTransactionID" → true
let sequence = 0;

on(`${KYC}/GenerateTokenEnc`, (entry) => {
  const creds = decryptBody(entry);
  if (entry.headers.partnername !== TEST.partnerName || creds.Username !== TEST.username || creds.Password !== TEST.password) {
    return { json: enc({ access_token: null, Status: '400', Message: 'Invalid partner or credentials' }) };
  }
  return { json: enc(tokenResponse) };
});
on(`${KYC}/EKYCOTPDetailEnc`, (entry) => {
  if (!authorised(entry)) return { status: 401, json: { Message: 'unauthorised' } };
  const { Pan, MobileNumber } = decryptBody(entry);
  if (Pan === REJECTED_PAN) {
    return { json: enc({ Status: 'Failed', Remarks: 'The remote server returned an error: (404) Not Found.', CKYCStatus: 'CKYCRejected' }) };
  }
  sequence += 1;
  const requestId = `req${sequence}ab`;
  const transactionId = String(80000 + sequence);
  issued.set(`${requestId}|${transactionId}`, true);
  const remarks = `OTP has been sent to the registered mobile numberXXXXXX${String(MobileNumber).slice(-4)}`;
  return {
    json: enc({
      Status: 'Success', Remarks: remarks, CKYCSuccessDescription: remarks, Type: 'SendOTP',
      CKYCTransactionID: transactionId, CYCRequestId: requestId, CKYCStatus: 'OTPTriggeredByCKYC',
    }),
  };
});
on(`${KYC}/ReSendOTPEnc`, (entry) => {
  if (!authorised(entry)) return { status: 401, json: { Message: 'unauthorised' } };
  const { CYCRequestId, CKYCTransactionID } = decryptBody(entry);
  if (!issued.has(`${CYCRequestId}|${CKYCTransactionID}`)) return { json: enc({ Status: 'Failed', CKYCStatus: 'CKYCRejected' }) };
  const remarks = 'Resend OTP Sent successfully to registered Mobile number XXXXXX7081 remaining attempts =2';
  return { json: enc({ Status: 'Success', Remarks: remarks, CKYCSuccessDescription: remarks, CKYCStatus: 'OTPReTriggeredByCKYC' }) };
});
// NivaBupa's documented EKYCDetailEnc success response (sample values from the document).
on(`${KYC}/EKYCDetailEnc`, (entry) => {
  if (!authorised(entry)) return { status: 401, json: { Message: 'unauthorised' } };
  const { CYCRequestId, CKYCTransactionID, OtpData } = decryptBody(entry);
  if (!issued.has(`${CYCRequestId}|${CKYCTransactionID}`) || OtpData !== TEST.otp) {
    return { json: enc({ Status: 'Failed', Remarks: 'Invalid OTP', CKYCID: null, CKYCStatus: 'CKYCRejected' }) };
  }
  return {
    json: enc({
      Status: 'Success', Remarks: '', Name: 'Deepak Singh ', Gender: 'M', City: 'Mumbai', State: 'MH', PinCode: '400001',
      Address1: 'Business park 13 ', FirstName: 'Deepak', LastName: 'Singha', IsIdentity: true, IsAddress: false,
      CKYCID: '40057472799120', PAN: null, Type: 'PANValidation', Photo: 'iVBORw0KGgo'.repeat(500),
    }),
  };
});
on('/api/generic/token', () => ({ json: { access_token: 'generic-oauth-token', expires_in: 3600 } }));
on('/api/generic/uwDecision', (entry) => ({
  json: { APPLICATION_FORM: { STATUS: 'Success', UWDECISION: 'STP', SOURCING_APPNO: entry.json?.Proposal?.POLICY?.CONTRACT_DETAILS?.SOURCING_APPNO } },
}));
on('/api/generic/datapush', () => ({ json: { Response: { STATUS: 'SUCCESS', POLICY_NO: 'TESTPOLICY001' } } }));

// ── 6. Test harness ─────────────────────────────────────────────────────────

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    out(`  ✅ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message });
    out(`  ❌ ${name}\n       ${error.message}`);
  }
}
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const eq = (actual, expected, what) => {
  if (actual !== expected) throw new Error(`${what}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};

const TYPED_KYC = {
  PAN_NUMBER: 'TYPED1234X', AADHAR_NUMBER: '123412341234', ID_PROOF: 'PAN', CKYC_NUMBER: null,
  CKYC_CONSENT: 'Yes', CKYC_CONSENT_DATE: '01/01/2026 10:00:00',
  KYC_ADDRESS_MASTER_FLAG: null, KYC_ADDRESS_RECORD_NUMBER: null,
  KYC_IDENTITY_MASTER_FLAG: null, KYC_IDENTITY_RECORD_NUMBER: null, PASSPORT: null,
};
function proposal(sourcingAppNo) {
  return {
    Proposal: {
      POLICY: {
        CONTRACT_DETAILS: { SOURCING_APPNO: sourcingAppNo, PRODUCT_CODE: 'RS3', PRODUCT_VARIANT: 'Gold' },
        PAYMENT_INFO: { TRANSACTION_NUMBER: 'TXN-TEST-1', PAYMENT_DATE: '17/09/2026' },
        POLICY_OTHER_DETAILS: {},
        SOURCING_INFO: { AGENT_INFO: {} },
        ADJUSTMENT_DETAILS: [],
      },
      PROPOSER: { KYC: { ...TYPED_KYC }, CONTACT_DETAILS: { MOBILE: '8269667081' }, BANK_DETAILS: {} },
      MEMBER: [],
      NOMINEE: {},
    },
  };
}
const kycHeader = (referenceId) => ({ 'X-NivaBupa-Kyc-Request-Id': referenceId });
const BUYER = { pan: 'bzgpp3232d', mobile: '8269667081' };
const createdReferences = [];

out(`\nNivaBupa KYC (CKYC OTP) — offline tests (${WITH_DB ? `MySQL ${config.db.host}:${config.db.port}/${config.db.database}` : 'no database'})\n`);

// ── 7. Pure logic ───────────────────────────────────────────────────────────

await test('encryption round-trips under the document scheme (AES-128-CBC, key = IV)', async () => {
  const cipher = encryptKycPayload('{"a":1}', TEST.key);
  eq(decryptKycPayload(cipher, TEST.key), '{"a":1}', 'round trip');
  eq(Buffer.from(cipher, 'base64').length % 16, 0, 'CBC block length');
});

await test('verification requires Status "Success" AND a CKYCID from NivaBupa', async () => {
  eq(kycService.isKycVerified({ Status: 'Success', CKYCID: '40057472799120' }), true, 'documented success');
  eq(kycService.isKycVerified({ Status: 'Success', CKYCID: null }), false, 'Success without CKYCID');
  eq(kycService.isKycVerified({ Status: 'Failed', CKYCID: '400' }), false, 'Failed with CKYCID');
  eq(kycService.isOtpSent({ Status: 'Success', CYCRequestId: 'a' }), false, 'OTP sent without transaction id');
  eq(kycService.isOtpSent({ Status: 'Failed', CYCRequestId: 'a', CKYCTransactionID: '1' }), false, 'Failed OTP send');
});

// ── 8. Configuration + validation ───────────────────────────────────────────

await test('unconfigured KYC answers 503 and underwriting is refused without calling NivaBupa', async () => {
  const saved = config.nivabupa.kyc.password;
  config.nivabupa.kyc.password = undefined;
  try {
    const send = await call('POST', '/nivabupa/kyc/EKYCOTPDetailEnc', BUYER);
    eq(send.status, 503, 'send status');
    assert(send.json.message.includes('NIVABUPA_KYC_PASSWORD'), 'message names the missing variable');
    const before = hits('/api/generic/uwDecision').length;
    const uw = await call('POST', '/nivabupa/uw-decision', proposal('1'), kycHeader('x'));
    eq(uw.status, 503, 'uw status');
    eq(hits('/api/generic/uwDecision').length, before, 'uwDecision calls');
  } finally {
    config.nivabupa.kyc.password = saved;
  }
});

await test('send validates PAN and mobile before any upstream call', async () => {
  const res = await call('POST', '/nivabupa/kyc/EKYCOTPDetailEnc', { pan: 'NOTAPAN', mobile: '12' });
  eq(res.status, 400, 'status');
  eq(hits(`${KYC}/GenerateTokenEnc`).length, 0, 'no token call');
  eq(hits(`${KYC}/EKYCOTPDetailEnc`).length, 0, 'no OTP call');
});

await test('underwriting without a KYC reference is refused before any upstream call', async () => {
  const before = hits('/api/generic/uwDecision').length;
  const res = await call('POST', '/nivabupa/uw-decision', proposal('1'));
  eq(res.status, 400, 'status');
  eq(res.json.code, 'KYC_NOT_VERIFIED', 'code');
  eq(hits('/api/generic/uwDecision').length, before, 'uwDecision calls');
});

await test('Data Push without a KYC reference is never blocked and is sent exactly as before', async () => {
  const res = await call('POST', '/nivabupa/datapush', proposal('1'));
  eq(res.status, 200, 'status');
  eq(res.json.data.Response.POLICY_NO, 'TESTPOLICY001', 'policy number returned');
  eq(JSON.stringify(hits('/api/generic/datapush').at(-1).json.Proposal.PROPOSER.KYC), JSON.stringify(TYPED_KYC), 'PROPOSER.KYC');
});

if (!WITH_DB) {
  await test('without a database, send answers 503 BEFORE an OTP is requested (no OTP wasted)', async () => {
    const res = await call('POST', '/nivabupa/kyc/EKYCOTPDetailEnc', BUYER);
    eq(res.status, 503, 'status');
    eq(hits(`${KYC}/EKYCOTPDetailEnc`).length, 0, 'no OTP call');
  });

  await test('without a database, underwriting with a KYC reference is refused (503), never forwarded', async () => {
    const before = hits('/api/generic/uwDecision').length;
    const res = await call('POST', '/nivabupa/uw-decision', proposal('1'), kycHeader('123'));
    eq(res.status, 503, 'status');
    eq(hits('/api/generic/uwDecision').length, before, 'uwDecision calls');
  });

  await test('without a database, Data Push with a KYC reference is still sent unchanged', async () => {
    const res = await call('POST', '/nivabupa/datapush', proposal('1'), kycHeader('123'));
    eq(res.status, 200, 'status');
    eq(JSON.stringify(hits('/api/generic/datapush').at(-1).json.Proposal.PROPOSER.KYC), JSON.stringify(TYPED_KYC), 'PROPOSER.KYC');
  });
}

// ── 9. Full OTP flow (database run) ─────────────────────────────────────────

if (WITH_DB) {
  let kyc;

  await test('a PAN NivaBupa rejects answers 422 with NivaBupa\'s message', async () => {
    const res = await call('POST', '/nivabupa/kyc/EKYCOTPDetailEnc', { ...BUYER, pan: REJECTED_PAN });
    eq(res.status, 422, 'status');
    assert(res.json.message.includes('(404) Not Found'), res.json.message);
    const row = await db.queryOne(
      "SELECT status FROM nivabupa_kyc_requests WHERE pan = ? ORDER BY id DESC LIMIT 1", [REJECTED_PAN]
    );
    eq(row?.status, 'FAILED', 'row status');
    const ref = await db.queryOne('SELECT kyc_reference_id FROM nivabupa_kyc_requests WHERE pan = ? ORDER BY id DESC LIMIT 1', [REJECTED_PAN]);
    createdReferences.push(ref.kyc_reference_id);
  });

  await test('send calls GenerateTokenEnc + EKYCOTPDetailEnc with the documented headers and body', async () => {
    const res = await call('POST', '/nivabupa/kyc/EKYCOTPDetailEnc', BUYER);
    eq(res.status, 200, 'status');
    kyc = res.json.kyc;
    createdReferences.push(kyc.referenceId);
    assert(/^\d{15}$/.test(kyc.referenceId), `referenceId ${kyc.referenceId}`);
    assert(/^\d{12}$/.test(kyc.applicationNo), `applicationNo ${kyc.applicationNo}`);
    eq(kyc.message, 'OTP has been sent to the registered mobile numberXXXXXX7081', 'NivaBupa message');
    assert(!res.raw.includes('req') && !res.raw.includes('8000'), 'CYCRequestId / CKYCTransactionID not sent to the browser');

    const tokenCall = hits(`${KYC}/GenerateTokenEnc`).at(-1);
    eq(tokenCall.headers.partnername, TEST.partnerName, 'PartnerName on token call');
    assert(!tokenCall.raw.includes(TEST.password), 'password not sent in clear');
    const otpCall = hits(`${KYC}/EKYCOTPDetailEnc`).at(-1);
    eq(otpCall.headers.athorizationtoken, TEST.token, 'AthorizationToken header');
    assert(!otpCall.raw.includes('BZGPP'), 'body encrypted');
    const sent = decryptBody(otpCall);
    eq(sent.Pan, 'BZGPP3232D', 'Pan upper-cased');
    eq(sent.MobileNumber, BUYER.mobile, 'MobileNumber');
    eq(Object.keys(sent).length, 2, 'only the two documented fields');
  });

  await test('send reuses a supplied applicationNo (sending again keeps the number)', async () => {
    const res = await call('POST', '/health/nivabupa/kyc/EKYCOTPDetailEnc', { ...BUYER, applicationNo: kyc.applicationNo });
    eq(res.status, 200, 'status (via /health alias)');
    createdReferences.push(res.json.kyc.referenceId);
    eq(res.json.kyc.applicationNo, kyc.applicationNo, 'applicationNo');
  });

  await test('a wrong OTP is not verified, and NivaBupa\'s message is returned', async () => {
    const res = await call('POST', '/nivabupa/kyc/EKYCDetailEnc', { referenceId: kyc.referenceId, otp: '000000' });
    eq(res.status, 200, 'status');
    eq(res.json.kyc.verified, false, 'verified');
    eq(res.json.kyc.message, 'Invalid OTP', 'message');
    const row = await db.queryOne('SELECT status, verify_attempts FROM nivabupa_kyc_requests WHERE kyc_reference_id = ?', [kyc.referenceId]);
    eq(row.status, 'OTP_SENT', 'still open for another attempt');
    eq(Number(row.verify_attempts), 1, 'attempt counted');
  });

  await test('underwriting while the OTP is still pending is refused before any upstream call', async () => {
    const before = hits('/api/generic/uwDecision').length;
    const res = await call('POST', '/nivabupa/uw-decision', proposal(kyc.applicationNo), kycHeader(kyc.referenceId));
    eq(res.status, 400, 'status');
    eq(res.json.code, 'KYC_NOT_VERIFIED', 'code');
    eq(hits('/api/generic/uwDecision').length, before, 'uwDecision calls');
  });

  await test('resend uses the stored CKYC identifiers, not anything from the browser', async () => {
    const res = await call('POST', '/nivabupa/kyc/ReSendOTPEnc', { referenceId: kyc.referenceId, CYCRequestId: 'forged' });
    eq(res.status, 200, 'status');
    assert(res.json.kyc.message.includes('remaining attempts'), res.json.kyc.message);
    const sent = decryptBody(hits(`${KYC}/ReSendOTPEnc`).at(-1));
    assert(sent.CYCRequestId !== 'forged' && issued.has(`${sent.CYCRequestId}|${sent.CKYCTransactionID}`), 'stored identifiers sent');
  });

  await test('verify with an unknown reference answers 404 without calling NivaBupa', async () => {
    const before = hits(`${KYC}/EKYCDetailEnc`).length;
    const res = await call('POST', '/nivabupa/kyc/EKYCDetailEnc', { referenceId: '999999999999999', otp: TEST.otp });
    eq(res.status, 404, 'status');
    eq(hits(`${KYC}/EKYCDetailEnc`).length, before, 'EKYCDetailEnc calls');
  });

  await test('the correct OTP is verified by NivaBupa; the browser gets a masked summary only', async () => {
    const res = await call('POST', '/nivabupa/kyc/EKYCDetailEnc', { referenceId: kyc.referenceId, otp: TEST.otp });
    eq(res.status, 200, 'status');
    eq(res.json.kyc.verified, true, 'verified');
    eq(res.json.kyc.name, 'Deepak Singh', 'name');
    eq(res.json.kyc.ckycNumberMasked, 'XXXXXXXXXX9120', 'ckycNumberMasked');
    assert(!res.raw.includes('40057472799120') && !res.raw.includes('Business park'), 'no CKYC number or address in response');
    const sent = decryptBody(hits(`${KYC}/EKYCDetailEnc`).at(-1));
    eq(sent.OtpData, TEST.otp, 'OtpData sent to NivaBupa');
  });

  await test('verifying again is answered from the stored result without another NivaBupa call', async () => {
    const before = hits(`${KYC}/EKYCDetailEnc`).length;
    const res = await call('POST', '/nivabupa/kyc/EKYCDetailEnc', { referenceId: kyc.referenceId, otp: '111111' });
    eq(res.status, 200, 'status');
    eq(res.json.kyc.verified, true, 'verified');
    eq(hits(`${KYC}/EKYCDetailEnc`).length, before, 'EKYCDetailEnc calls');
  });

  await test('underwriting for a different application number than KYC is refused', async () => {
    const before = hits('/api/generic/uwDecision').length;
    const res = await call('POST', '/nivabupa/uw-decision', proposal('999999999999'), kycHeader(kyc.referenceId));
    eq(res.status, 400, 'status');
    eq(hits('/api/generic/uwDecision').length, before, 'uwDecision calls');
  });

  await test('underwriting with verified KYC proceeds, and the body reaches NivaBupa unchanged', async () => {
    const before = hits('/api/generic/uwDecision').length;
    const res = await call('POST', '/nivabupa/uw-decision', proposal(kyc.applicationNo), kycHeader(kyc.referenceId));
    eq(res.status, 200, 'status');
    eq(res.json.data.APPLICATION_FORM.STATUS, 'Success', 'NivaBupa response returned');
    eq(hits('/api/generic/uwDecision').length, before + 1, 'uwDecision calls');
    eq(JSON.stringify(hits('/api/generic/uwDecision').at(-1).json.Proposal.PROPOSER.KYC), JSON.stringify(TYPED_KYC), 'PROPOSER.KYC (check only)');
  });

  await test('Data Push with verified KYC carries the verified CKYC number and PAN; everything else identical', async () => {
    await call('POST', '/nivabupa/datapush', proposal(kyc.applicationNo));
    const baseline = hits('/api/generic/datapush').at(-1).json;
    const res = await call('POST', '/nivabupa/datapush', proposal(kyc.applicationNo), kycHeader(kyc.referenceId));
    eq(res.status, 200, 'status');
    const sent = hits('/api/generic/datapush').at(-1).json;
    const sentKyc = sent.Proposal.PROPOSER.KYC;
    eq(sentKyc.CKYC_NUMBER, '40057472799120', 'CKYC_NUMBER from NivaBupa');
    eq(sentKyc.PAN_NUMBER, 'BZGPP3232D', 'PAN_NUMBER = the PAN NivaBupa verified, not the typed one');
    for (const field of ['AADHAR_NUMBER', 'ID_PROOF', 'CKYC_CONSENT', 'CKYC_CONSENT_DATE', 'KYC_IDENTITY_MASTER_FLAG', 'PASSPORT']) {
      eq(sentKyc[field], TYPED_KYC[field], `${field} untouched`);
    }
    eq(JSON.stringify(baseline.Proposal.PROPOSER.KYC), JSON.stringify(TYPED_KYC), 'baseline without KYC reference is unchanged');
    const withoutKyc = (body) => JSON.stringify({ ...body, Proposal: { ...body.Proposal, PROPOSER: { ...body.Proposal.PROPOSER, KYC: null } } });
    eq(withoutKyc(sent), withoutKyc(baseline), 'every non-KYC field identical to the same Data Push without KYC');
  });

  await test('the stored row and audit rows hold NivaBupa\'s answer; OTP, password and token are not stored', async () => {
    const row = await db.queryOne('SELECT * FROM nivabupa_kyc_requests WHERE kyc_reference_id = ?', [kyc.referenceId]);
    eq(row.status, 'VERIFIED', 'status');
    eq(row.application_no, kyc.applicationNo, 'application_no');
    eq(row.ckyc_number, '40057472799120', 'ckyc_number');
    eq(row.pan, 'BZGPP3232D', 'pan');
    assert(!('Photo' in db.fromJson(row.verified_response)), 'photo not stored');
    const audits = await db.query(
      'SELECT api_name, request_payload FROM nivabupa_api_transactions WHERE correlation_id = ?', [kyc.referenceId]
    );
    const names = new Set(audits.map((a) => a.api_name));
    for (const name of ['KYC_TOKEN', 'KYC_OTP_SEND', 'KYC_OTP_RESEND', 'KYC_OTP_VERIFY']) assert(names.has(name), `audit ${name}`);
    const dump = JSON.stringify(audits);
    for (const [label, value] of Object.entries({ password: TEST.password, token: TEST.token, otp: TEST.otp })) {
      assert(!dump.includes(value), `${label} found in audit rows`);
    }
  });
}

// ── 10. Nothing secret logged; other insurers still mounted ─────────────────

await test('no KYC password, key, token or OTP appears in any log line', async () => {
  const all = logged.join('\n');
  for (const [name, value] of Object.entries({ password: TEST.password, key: TEST.key, token: TEST.token, otp: TEST.otp })) {
    assert(!all.includes(value), `${name} was logged`);
  }
});

await test('other insurer routers still answer on their own prefixes', async () => {
  for (const path of ['/iffcotokio/config/test', '/icici-lombard/config/test']) {
    const res = await call('GET', path);
    assert(res.status !== 404, `${path} → ${res.status}`);
  }
});

// ── 11. Cleanup + summary ───────────────────────────────────────────────────

if (WITH_DB) {
  try {
    if (createdReferences.length) {
      const placeholders = createdReferences.map(() => '?').join(',');
      await db.query(`DELETE FROM nivabupa_kyc_requests WHERE kyc_reference_id IN (${placeholders})`, createdReferences);
    }
    await db.query('DELETE FROM nivabupa_api_transactions WHERE endpoint_url LIKE ?', [`${MOCK}%`]);
  } catch (error) {
    out(`  ⚠️  cleanup failed: ${error.message}`);
  }
}

server.close();
mock.close();
await db.closePool().catch(() => {});

const failed = results.filter((r) => !r.ok);
out(`\n${results.length - failed.length} passed, ${failed.length} failed\n`);
process.exit(failed.length ? 1 : 0);
