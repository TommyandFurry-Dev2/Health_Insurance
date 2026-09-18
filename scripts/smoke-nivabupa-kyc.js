// ─────────────────────────────────────────────────────────────────────────────
// NivaBupa KYC (CKYC OTP flow) — live smoke test against the KYC API in .env.
//
//   npm run smoke:nivabupa-kyc
//
// Runs the real app in-process and calls, through it:
//   1. POST /nivabupa/kyc/otp/send  → GenerateTokenEnc + EKYCOTPDetailEnc
//   2. POST /nivabupa/kyc/otp/verify on that attempt
//   3. POST /nivabupa/uw-decision   with that KYC reference — must be refused
//      BEFORE any uwDecision call.
//
// It deliberately uses a PAN that cannot exist (Z is not a PAN holder type), so
// NivaBupa's answer is real but no OTP can reach anyone's phone. A successful
// OTP needs a real buyer's PAN and phone, and is tested from the UI.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

import config from '../src/config/env.js';
import { createApp } from '../src/app.js';
import db from '../src/db/index.js';
import { missingKycVariables } from '../src/services/nivabupaKyc.service.js';

const IMPOSSIBLE_PAN = 'ZZZZZ9999Z';
const MOBILE = '9000000000';

const missing = missingKycVariables();
if (missing.length) {
  console.error(`❌ KYC not configured — missing ${missing.join(', ')}`);
  process.exit(1);
}

const app = createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

function call(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const started = Date.now();
    const req = http.request({
      host: '127.0.0.1', port, method: 'POST', path,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(data || 'null'), ms: Date.now() - started }));
    });
    req.on('error', reject);
    req.setTimeout(150000, () => req.destroy(new Error('timed out')));
    req.write(payload);
    req.end();
  });
}

let failures = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures += 1;
};

console.log(`\nNivaBupa KYC (CKYC OTP) live smoke — ${config.nivabupa.kyc.baseUrl}\n`);

console.log('1. POST /nivabupa/kyc/otp/send (impossible PAN — no OTP can be delivered)');
const sent = await call('/nivabupa/kyc/otp/send', { pan: IMPOSSIBLE_PAN, mobile: MOBILE });
console.log(`   HTTP ${sent.status} in ${sent.ms}ms`, JSON.stringify(sent.json));
check(sent.status === 422 || sent.status === 200, 'NivaBupa answered the OTP request (its verdict is shown above)');

const row = await db.queryOne(
  'SELECT kyc_reference_id, status, ckyc_status, status_message FROM nivabupa_kyc_requests WHERE pan = ? ORDER BY id DESC LIMIT 1',
  [IMPOSSIBLE_PAN]
).catch(() => null);
console.log('   nivabupa_kyc_requests:', JSON.stringify(row));

if (row) {
  console.log('\n2. POST /nivabupa/kyc/otp/verify on that attempt');
  const verified = await call('/nivabupa/kyc/otp/verify', { referenceId: row.kyc_reference_id, otp: '123456' });
  console.log(`   HTTP ${verified.status} in ${verified.ms}ms`, JSON.stringify(verified.json));
  check(verified.json?.kyc?.verified !== true, 'KYC is not verified');

  console.log('\n3. POST /nivabupa/uw-decision with that KYC reference');
  const uw = await call('/nivabupa/uw-decision', {
    Proposal: { POLICY: { CONTRACT_DETAILS: { SOURCING_APPNO: '000000000000' } }, PROPOSER: { KYC: {} }, MEMBER: [], NOMINEE: {} },
  }, { 'X-NivaBupa-Kyc-Request-Id': row.kyc_reference_id });
  console.log(`   HTTP ${uw.status} in ${uw.ms}ms`, JSON.stringify(uw.json));
  check(uw.status === 400 && uw.json?.code === 'KYC_NOT_VERIFIED', 'underwriting refused before any NivaBupa call');

  const audits = await db.query(
    'SELECT api_name, status, http_status, duration_ms FROM nivabupa_api_transactions WHERE correlation_id = ? ORDER BY id',
    [row.kyc_reference_id]
  );
  console.log('\n   nivabupa_api_transactions:');
  for (const a of audits) console.log(`     ${a.api_name.padEnd(16)} ${a.status.padEnd(8)} HTTP ${a.http_status} ${a.duration_ms}ms`);
  check(!audits.some((a) => a.api_name === 'UW_DECISION'), 'no uwDecision call recorded');
}

server.close();
await db.closePool().catch(() => {});
console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all checks passed'}\n`);
process.exit(failures ? 1 : 0);
