import axios from 'axios';
import db from '../src/db/index.js';
import * as paymentRepo from '../src/repositories/payment.repository.js';
import * as journeyRepo from '../src/repositories/journey.repository.js';
import * as journeyService from '../src/services/journey.service.js';
import { parseReturnMessage } from '../src/helpers/payment.helper.js';

// Proves the payment-callback correlation path, which is the one part of resume
// that cannot be exercised end-to-end: NivaBupa's gateway POSTs the real
// callback from its own servers with an encrypted returnMessage we cannot forge.
//
// So: drive payment/initiate over HTTP for real (live SOAP encrypt against UAT),
// then hand recordPaymentCallback a returnMessage in NivaBupa's documented pipe
// format — skipping only the decrypt — and check the journey is recovered from
// the stored unqPolicyNumber alone.

const BASE = `http://localhost:${process.env.PORT || 4000}`;
const api = axios.create({ baseURL: BASE, timeout: 45000, validateStatus: () => true });

let pass = 0;
let fail = 0;
const check = (label, ok, detail) => {
  if (ok) { pass += 1; console.log(`  ✅ ${label}`); } else { fail += 1; console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`); }
};

try {
  const created = await api.post('/nivabupa/journey', { mobile: '9876500777', email: 'pay.probe@example.com', fullName: 'Pay Probe' });
  if (created.status !== 201) throw new Error(`journey create failed: HTTP ${created.status}`);
  const { journeyId } = created.data;
  console.log(`\njourney ${journeyId}`);

  // Our own reference — the value the whole correlation hinges on.
  const unqPolicyNumber = `SMOKE${Date.now()}`;

  console.log('\n1. POST /nivabupa/payment/initiate (live SOAP encrypt)');
  const initiated = await api.post('/nivabupa/payment/initiate', {
    unqPolicyNumber,
    premiumValue: '12500.00',
    additionalComment: 'journey smoke',
    channel: 'WEB',
    subchannel: 'DIRECT',
    sourcingsystem: 'TOMMYANDFURRY',
    productname: 'REASSURE30',
    mobile: '9876500777',
    email: 'pay.probe@example.com',
    suminsured: '1000000',
    tenure: '1',
  }, { headers: { 'X-Journey-Id': journeyId } });

  console.log(`   HTTP ${initiated.status} status=${initiated.data?.status}`);
  check('initiate returned encparam', Boolean(initiated.data?.encparam), JSON.stringify(initiated.data)?.slice(0, 220));
  check('unqPolicyNumber echoed back', initiated.data?.unqPolicyNumber === unqPolicyNumber, initiated.data?.unqPolicyNumber);

  console.log('\n2. journey_payments row persisted at initiate time');
  const journey = await journeyRepo.findByUuid(journeyId);
  const stored = await paymentRepo.findLatestByJourney(journey.id);
  check('row exists', Boolean(stored));
  check('unq_policy_number stored (the correlation key)', stored?.unq_policy_number === unqPolicyNumber, stored?.unq_policy_number);
  check('status INITIATED', stored?.status === 'INITIATED', stored?.status);
  check('attempt_no = 1', Number(stored?.attempt_no) === 1, String(stored?.attempt_no));
  check('plaintext querystring retained for decrypt debugging', Boolean(stored?.plaintext_querystring));
  check('encparam persisted', Boolean(stored?.encparam));
  check('journey advanced to PAYMENT_INITIATED', journey.current_step === 'PAYMENT_INITIATED', journey.current_step);

  console.log('\n3. Correlate a gateway callback carrying no journey identity');
  // Field order per NivaBupa's documented returnMessage format — see
  // helpers/payment.helper.js parseReturnMessage.
  const returnMessage = [
    'NIVABUPA',        // 0 source
    unqPolicyNumber,   // 1 uniqueReferenceId  ← the only link back to the journey
    '12500.00',        // 2 payablePremium
    '30/Jul/2026 15:45:00', // 3 transactionDateTime
    unqPolicyNumber,   // 4 uniqueReferenceNoRepeat
    'JUSPAY-TXN-99001', // 5 paymentTransactionId
    'M001',            // 6 paymentStatus (success)
    '',                // 7 failedReason
    'N',               // 8 standingInstructionTaken
    '',                // 9 standingInstructionNo
    'JUSPAY',          // 10 paymentGatewayUsed
  ].join('|');

  const parsed = parseReturnMessage(returnMessage);
  check('parses as SUCCESS', parsed.paymentStatusDescription === 'SUCCESS', parsed.paymentStatusDescription);

  const result = await journeyService.recordPaymentCallback({
    parsed,
    decrypted: returnMessage,
    rawBody: { returnMessage: '<encrypted-blob>' },
    durationMs: 12,
  });

  check('callback correlated to a journey', Boolean(result?.journey), 'no journey resolved');
  check('correlated to the RIGHT journey', result?.journey?.uuid === journeyId, result?.journey?.uuid);
  check('payment marked SUCCESS', result?.payment?.status === 'SUCCESS', result?.payment?.status);
  check('gateway txn id stored', result?.payment?.payment_transaction_id === 'JUSPAY-TXN-99001', result?.payment?.payment_transaction_id);
  check('journey advanced to PAYMENT_COMPLETED', result?.journey?.current_step === 'PAYMENT_COMPLETED', result?.journey?.current_step);

  console.log('\n4. Policy row created from the successful payment');
  const snapshot = await journeyService.getSnapshotByUuid(journeyId);
  check('policy row exists', Boolean(snapshot?.policy));
  check('policy_number taken from the callback', snapshot?.policy?.policy_number === unqPolicyNumber, snapshot?.policy?.policy_number);
  check('resume route now points at policy status', snapshot?.journey?.resumeRoute === '/policy/status', snapshot?.journey?.resumeRoute);

  console.log('\n5. An unmatched callback is recorded, not silently dropped');
  const orphan = await journeyService.recordPaymentCallback({
    parsed: parseReturnMessage(['NIVABUPA', 'NO-SUCH-REF-12345', '1', 'x', '', 'T', 'M001', '', 'N', '', 'JUSPAY'].join('|')),
    decrypted: 'orphan',
    rawBody: { returnMessage: '<encrypted-blob>' },
  });
  check('returns null for an unknown reference', orphan === null, JSON.stringify(orphan)?.slice(0, 120));
  const orphanRow = await db.queryOne(
    `SELECT error_message FROM nivabupa_api_transactions
     WHERE api_name = 'PAYMENT_CALLBACK' AND correlation_id = ? ORDER BY id DESC LIMIT 1`,
    ['NO-SUCH-REF-12345']
  );
  check('unmatched callback logged for reconciliation', Boolean(orphanRow?.error_message), JSON.stringify(orphanRow));

  console.log('\n═══════════════════════════════════════════');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════════\n');

  await db.closePool();
  if (fail > 0) process.exitCode = 1;
} catch (e) {
  console.error('\n❌ probe crashed:', e.message);
  console.error(e.stack);
  await db.closePool().catch(() => {});
  process.exit(1);
}
