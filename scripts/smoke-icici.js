import config, { missingIciciVariables } from '../src/config/env.js';
import { getIciciToken, getIciciEncKey } from '../src/services/iciciAuth.service.js';
import * as iciciApi from '../src/services/iciciApi.service.js';

// Smoke test for ICICI Lombard "Elevate" — talks to ICICI through this service's
// own service layer, with no HTTP server of ours in between, so the token, the
// transport and the response parsers can be verified in isolation. When this
// passes but POST /icici-lombard/quote fails, the problem is in the router or
// the controller; when both fail, it is ICICI's or the configuration's.
//
// A port of the working implementation's scripts/smoke-elevate.js.
//
// Usage: npm run smoke:icici [step]
//   step = token | zone | quote | status | all      (default: token)
//
// ⚠️ SAFE BY DEFAULT. Every step is a READ: the token, a zone lookup, a premium
// (which mints a TransactionId at ICICI and nothing else), and — for `quote` and
// `all` — a proposal-status read of that fresh TransactionId. Nothing here runs
// CKYC, creates a proposal, syncs a payment or processes an EMI, so it cannot
// verify anyone's identity, create a policy or move money.
//
// If `token` fails, the credential most likely does not match the password mode:
// IL issue the password pre-encrypted (EL_PASSWORD_PRE_ENCRYPTED=true); only a
// plaintext password needs EL_AES_KEY / EL_AES_MODE.

const step = process.argv[2] || 'token';
const steps = new Set(step === 'all' ? ['token', 'zone', 'quote', 'status'] : [step]);
if (step === 'quote') steps.add('status');

function heading(text) {
  console.log(`\n─────────── ${text} ───────────`);
}

function fail(label, error) {
  console.error(`❌ ${label} FAILED`);
  console.error('   code   :', error.code);
  console.error('   message:', error.message);
  if (error.details) console.error('   details:', JSON.stringify(error.details, null, 2));
  process.exit(1);
}

// ── configuration ───────────────────────────────────────────────────────────
heading('Configuration');
const missing = missingIciciVariables();
console.log('Base URL        :', config.icici.baseUrl || '(not set)');
console.log('Password        :', config.icici.passwordPreEncrypted ? 'pre-encrypted (sent verbatim)' : `encrypted here with ${config.icici.aesMode}`);
console.log('EL_CLIENT_NAME  :', config.icici.clientName ? 'set' : 'NOT SET — COI will fail');
console.log('Retries/timeout :', `${config.icici.maxRetries} retries, ${config.timeouts.icici}ms per attempt`);

if (missing.length) {
  console.error(`\n❌ ICICI Lombard is not configured. Missing: ${missing.join(', ')}`);
  console.error('   Set them in .env — see .env.example.');
  process.exit(1);
}

// ── token ───────────────────────────────────────────────────────────────────
heading('Token');
try {
  const token = await getIciciToken();
  // Never the token itself — only that one exists.
  console.log('token acquired  :', `yes (${token.length} chars, value not shown)`);
  console.log('encKey present  :', Boolean(getIciciEncKey()));
} catch (error) {
  fail('TOKEN', error);
}

// ── zone ────────────────────────────────────────────────────────────────────
if (steps.has('zone')) {
  heading('Zone lookup');
  try {
    const { result } = await iciciApi.zone({ PinCode: '400069', IssuanceSystem: 'Artemis', ProductCode: '4225' });
    const { raw, ...summary } = result.data;
    console.log('zone            :', JSON.stringify(summary));
  } catch (error) {
    fail('ZONE', error);
  }
}

// ── premium ─────────────────────────────────────────────────────────────────
let transactionId = null;
if (steps.has('quote')) {
  heading('Premium (quote)');
  try {
    const { result } = await iciciApi.getQuote({
      RequestId: `SMOKE${Date.now()}`,
      SumInsured: 500000,
      Tenure: 1,
      PinCode: 560062,
      PaymentOption: 0,
      Insured: [{
        InsuredType: 'Adult', Name: 'Sam', DateOfBirth: '30-Aug-1989', Gender: 'Female',
        IsPED: false, RelationshipWithApplicant: 'SELF',
        // Required in practice: omitting AddOns fails every quote with
        // errorCode -1 (verified on UAT 2026-08-18).
        AddOns: [],
      }],
    });
    transactionId = result.data?.transactionId ?? null;
    console.log('TransactionId   :', transactionId);
    console.log('TotalPremium    :', result.data?.totalPremium);
    console.log('ZoneName        :', result.data?.zoneName);
    console.log('CorelationId    :', result.meta?.corelationId);
  } catch (error) {
    fail('PREMIUM', error);
  }
}

// ── proposal status (read of the fresh TransactionId) ───────────────────────
if (steps.has('status')) {
  heading('Proposal status (read)');
  if (!transactionId) {
    console.log('Skipped — needs the TransactionId a quote mints. Run `npm run smoke:icici quote`.');
  } else {
    try {
      const { result } = await iciciApi.policyStatus({ TransactionId: transactionId, RequestId: `SMOKE${Date.now()}` });
      const { raw, ...summary } = result.data;
      console.log('status          :', JSON.stringify(summary));
    } catch (error) {
      // A quote with no proposal behind it is expected to have no status yet;
      // ICICI's answer is shown so it can be read, but it does not fail the smoke.
      console.log('ICICI answered  :', `[${error.code}] ${error.message}`);
      console.log('(expected for a quote that has no proposal — the call itself reached ICICI)');
    }
  }
}

console.log('\nDone. No CKYC, proposal, payment sync or EMI was run.\n');
