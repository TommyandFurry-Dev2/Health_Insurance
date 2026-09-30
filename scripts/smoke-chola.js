import config, { missingCholaVariables } from '../src/config/env.js';
import { getCholaToken } from '../src/services/cholaAuth.service.js';
import * as cholaApi from '../src/services/cholaApi.service.js';

// Smoke test for Chola MS — talks to Chola through this service's own service
// layer, with no HTTP server of ours in between, so the token, the transport
// and the response parsers can be verified in isolation. When this passes but
// POST /chola-ms/quote fails, the problem is in the router or the controller;
// when both fail, it is Chola's or the configuration's.
//
// A port of the working implementation's scripts/smoke-chola.js.
//
// Usage: npm run smoke:chola [step]
//   step = token | quote | all      (default: token)
//
// ⚠️ SAFE BY DEFAULT. Both steps are READS: the OAuth2 token, and a Flexi
// Health PremiumComputation (pricing only — nothing is created at Chola).
// Nothing here runs CKYC, saves a proposal or calls PolicyGeneration, so it
// cannot verify anyone's identity, create a policy or spend the deposit. For the
// full APD journey see `npm run uat:chola:apd`, which DOES.

const step = process.argv[2] || 'token';
const steps = new Set(step === 'all' ? ['token', 'quote'] : [step]);

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
const missing = missingCholaVariables();
console.log('Base URL        :', config.chola.baseUrl || '(not set)');
console.log('Payment mode    :', config.chola.paymentMode);
console.log('Retries/timeout :', `${config.chola.maxRetries} retries, ${config.timeouts.chola}ms per attempt`);

if (missing.length) {
  console.error(`\n❌ Chola MS is not configured. Missing: ${missing.join(', ')}`);
  console.error('   Set them in .env — see .env.example.');
  process.exit(1);
}

// ── token ───────────────────────────────────────────────────────────────────
heading('Token');
try {
  const token = await getCholaToken();
  // Never the token itself — only that one exists.
  console.log('token acquired  :', `yes (${token.length} chars, value not shown)`);
} catch (error) {
  fail('TOKEN', error);
}

// ── premium ─────────────────────────────────────────────────────────────────
if (steps.has('quote')) {
  heading('Flexi Health PremiumComputation');
  try {
    // Every field below is REQUIRED by Chola's WCF data contract, including the
    // ones with empty or zero values. A missing member is not defaulted — the
    // service answers HTTP 400 with an ASP.NET "Request Error" HTML page naming
    // it, e.g. (hit on 2026-09-18 with Underwriter_Comments left out):
    //   The data contract type 'WebPortalUtility.ClsInsuredDetails' cannot be
    //   deserialized because the required data member 'Underwriter_Comments'
    //   was not found.
    // which reads as "Chola is broken" from a smoke run, when the payload was.
    // PolicyType 'I' rather than 'F': a floater needs at least two members, and
    // this quote carries one.
    const { result } = await cholaApi.getQuote({
      product: 'FLEXI_HEALTH',
      PolicyType: 'I',
      Tenure: '1',
      NoofFamilyMembers: '1',
      TransactionType: 'N',
      PaymentOption: 'S',
      BasePolicyNo: '',
      // Int64 in the contract — 0, never '' (an empty string is a 400 here too).
      Spec_Exclusion_Ref_No: 0,
      InsuredMembers: [{
        Relation: 'Self', InsuredDateofBirth: '05/12/1991', InsuredCity: '540',
        SumInsured: '500000', Loading_Percentage: 0, Underwriter_Comments: '',
      }],
    });
    const { raw, ...summary } = result.data;
    console.log('premium         :', JSON.stringify(summary, null, 2));
  } catch (error) {
    fail('PREMIUM', error);
  }
}

console.log('\nDone. No CKYC, ProposalSave or PolicyGeneration was run.\n');
