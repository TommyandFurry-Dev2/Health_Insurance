// ─────────────────────────────────────────────────────────────────────────────
// NivaBupa hosted KYC (RedirectionLinkEnc) — live smoke test against the KYC API
// in .env.
//
//   npm run smoke:nivabupa-kyc-redirect
//
// Runs the real app in-process and calls, through it:
//   1. POST /nivabupa/kyc/RedirectionLinkEnc  → GenerateTokenEnc + RedirectionLinkEnc,
//      and prints the KYC page link NivaBupa issued for the buyer
//   2. POST /nivabupa/kyc/GetKycStatusEnc    → GetKycStatusEnc on that same attempt,
//      which must report KYC as NOT complete (nobody has opened the link)
//   3. POST /nivabupa/uw-decision   with that KYC reference — must be refused
//      BEFORE any uwDecision call
//
// Unlike the OTP smoke test this one uses plausible details, because
// RedirectionLinkEnc validates them field by field and a deliberately impossible
// PAN would only ever exercise the 400 path. Nothing reaches a real person: the
// link is only issued, never opened, and no OTP is sent by this call.
//
// To finish the KYC for real, open the printed link in a browser, complete the
// page, and run step 2 again with the printed reference:
//   curl -X POST localhost:4000/nivabupa/kyc/GetKycStatusEnc \
//        -H 'Content-Type: application/json' -d '{"referenceId":"<printed>"}'
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

import config from '../src/config/env.js';
import { createApp } from '../src/app.js';
import db from '../src/db/index.js';
import { missingKycVariables } from '../src/services/nivabupaKyc.service.js';

const BUYER = {
  fullName: 'Rahul Sharma',
  dob: '1990-05-15',
  gender: 'Male',
  email: 'rahul.sharma.test@gmail.com',
  mobile: '9876543210',
  pan: 'ABCDE1234F',
  address: 'Test Address',
  city: 'Mumbai',
  pincode: '400001',
};

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

console.log(`\nNivaBupa hosted KYC live smoke — ${config.nivabupa.kyc.baseUrl}`);
console.log(`CallBack_URL sent: ${config.nivabupa.kyc.callbackUrl || '(none)'}\n`);

console.log('1. POST /nivabupa/kyc/RedirectionLinkEnc');
const started = await call('/nivabupa/kyc/RedirectionLinkEnc', BUYER);
console.log(`   HTTP ${started.status} in ${started.ms}ms`, JSON.stringify(started.json));
check(started.status === 200, 'NivaBupa issued a KYC page link');

const kyc = started.json?.kyc;
if (kyc?.referenceId) {
  check(Boolean(kyc.redirectUrl), 'the response carries the link to open');
  console.log(`\n   reference : ${kyc.referenceId}`);
  console.log(`   applicationNo: ${kyc.applicationNo}`);
  console.log(`   KYC page  : ${kyc.redirectUrl}`);

  const row = await db.queryOne(
    `SELECT kyc_reference_id, application_no, partner_request_id, nbhi_reference_no, status, status_message
       FROM nivabupa_kyc_requests WHERE kyc_reference_id = ?`,
    [kyc.referenceId]
  ).catch(() => null);
  console.log('\n   nivabupa_kyc_requests:', JSON.stringify(row));
  check(row?.status === 'LINK_ISSUED', 'the attempt is recorded as LINK_ISSUED');

  console.log('\n2. POST /nivabupa/kyc/GetKycStatusEnc (nobody has opened the link)');
  const status = await call('/nivabupa/kyc/GetKycStatusEnc', { referenceId: kyc.referenceId });
  console.log(`   HTTP ${status.status} in ${status.ms}ms`, JSON.stringify(status.json));
  check(status.status === 200, 'NivaBupa answered the status check');
  check(status.json?.kyc?.verified !== true, 'KYC is not verified');

  console.log('\n3. POST /nivabupa/uw-decision with that KYC reference');
  const uw = await call('/nivabupa/uw-decision', {
    Proposal: { POLICY: { CONTRACT_DETAILS: { SOURCING_APPNO: kyc.applicationNo } }, PROPOSER: { KYC: {} }, MEMBER: [], NOMINEE: {} },
  }, { 'X-NivaBupa-Kyc-Request-Id': kyc.referenceId });
  console.log(`   HTTP ${uw.status} in ${uw.ms}ms`, JSON.stringify(uw.json));
  check(uw.status === 400 && uw.json?.code === 'KYC_NOT_VERIFIED', 'underwriting refused before any NivaBupa call');

  const audits = await db.query(
    'SELECT api_name, status, http_status, duration_ms FROM nivabupa_api_transactions WHERE correlation_id = ? ORDER BY id',
    [kyc.referenceId]
  ).catch(() => []);
  console.log('\n   nivabupa_api_transactions:');
  for (const a of audits) console.log(`     ${a.api_name.padEnd(18)} ${a.status.padEnd(8)} HTTP ${a.http_status} ${a.duration_ms}ms`);
  check(!audits.some((a) => a.api_name === 'UW_DECISION'), 'no uwDecision call recorded');
}

server.close();
await db.closePool().catch(() => {});
console.log(`\n${failures ? `❌ ${failures} check(s) failed` : '✅ all checks passed'}\n`);
process.exit(failures ? 1 : 0);
