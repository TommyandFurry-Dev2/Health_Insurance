import config, {
  missingFgVariables, missingFgPaymentVariables, fgCkycFlavour,
} from '../src/config/env.js';
import * as fgApi from '../src/services/fgApi.service.js';
import * as fgCkyc from '../src/services/fgCkyc.service.js';
import { buildPaymentRequest } from '../src/helpers/fgPayment.helper.js';

// Smoke test for Future Generali — talks to FG through this service's own
// service layer, with no HTTP server of ours in between, so the SOAP envelope,
// the <Root> payload and the response parser can be verified in isolation.
// When this passes but POST /future-generali/quote fails, the problem is in the
// router or the controller; when both fail, it is FG's or the configuration's.
//
// Usage: npm run smoke:fg
//
// ⚠️ SAFE BY DEFAULT. It runs the QUOTE leg (ENQ — a pure read that creates
// nothing at FG), the CKYC leg, and BUILDS the payment form without submitting
// it. It never calls issuance, so it cannot create a policy or move money.
//
// Pass --proposal to additionally run HealthPreCRTValidate. That still issues
// nothing, but it DOES create a client record at FG through their handshake, so
// it is opt-in.

const runProposal = process.argv.includes('--proposal');

function heading(text) {
  console.log(`\n─────────── ${text} ───────────`);
}

// A PAN and surname unique to this run.
//
// UAT is a SHARED tenant, and Future Generali key a client record on the PAN. A
// fixed sample PAN therefore works exactly once and then answers "PAN Number
// already exists for different client." on every later run — a data collision
// with a previous tester that reads like an integration fault. Randomising it
// keeps the proposal leg testing the CRT path rather than the tenant's history.
//
// Format is PAN's own: five letters, four digits, one letter.
function uniqueIdentity() {
  const letter = () => String.fromCharCode(65 + Math.floor(Math.random() * 26));
  const digits = String(Math.floor(1000 + Math.random() * 9000));
  return {
    pan: `${letter()}${letter()}${letter()}P${letter()}${digits}${letter()}`,
    surname: `Test${digits}`,
  };
}

// A minimal, valid Health Absolute risk: two members, both with the height and
// weight FG derive BMI from. Dates are generated so the policy always starts
// tomorrow — FG reject a start date in the past.
//
// ⚠️ The coded fields below are FG's own vocabulary, not free text, and the
// quote leg does NOT check them — only the proposal does. Getting one wrong is
// answered with a bare sentence naming the field and nothing else
// ("Occupation is incorrect."), so the values here are taken from payloads FG
// have actually accepted rather than invented:
//
//   salutation  MR
//   occupation  four-letter codes — COME, OTHR
//   relation    SELF, SPOU, SON, …
//   nomineeRelation  four-letter codes — MOTH, …
//
// FG hold the full masters; ask them before using a value not seen here.
function samplePayload() {
  const identity = uniqueIdentity();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const end = new Date(start);
  end.setFullYear(end.getFullYear() + 1);
  end.setDate(end.getDate() - 1);

  return {
    product: 'HEALTH_ABSOLUTE',
    policy: { startDate: fmt(start), endDate: fmt(end) },
    client: {
      salutation: 'MR',
      firstName: 'Smoke',
      lastName: identity.surname,
      dob: '06/09/1992',
      gender: 'M',
      maritalStatus: 'M',
      occupation: 'COME',
      pan: identity.pan,
      address1: {
        line1: '12 MG Road',
        line2: 'Indiranagar',
        pincode: '560038',
        city: 'Bengaluru',
        state: 'Karnataka',
        mobileNo: '9876543210',
        email: 'smoke@example.test',
      },
    },
    risk: {
      members: [
        {
          memberId: 1,
          insuredName: `Smoke ${identity.surname}`,
          insuredDob: '06/09/1992',
          insuredGender: 'M',
          insuredOccupation: 'COME',
          coverType: 'Classic',
          sumInsured: 500000,
          relation: 'SELF',
          nomineeName: 'Kiran Devi',
          nomineeRelation: 'MOTH',
          height: 172,
          weight: 70,
        },
        {
          memberId: 2,
          insuredName: `Spouse ${identity.surname}`,
          insuredDob: '11/02/1994',
          insuredGender: 'F',
          insuredOccupation: 'COME',
          coverType: 'Classic',
          sumInsured: 500000,
          relation: 'SPOU',
          height: 160,
          weight: 55,
        },
      ],
    },
  };
}

// ── configuration ───────────────────────────────────────────────────────────
heading('Configuration');
const missing = missingFgVariables();
const paymentMissing = missingFgPaymentVariables();

console.log('BO service     :', config.fg.boBaseUrl ? `${config.fg.boBaseUrl}${config.fg.paths.boService}` : '(not set)');
console.log('Document svc   :', config.fg.pdfBaseUrl ? `${config.fg.pdfBaseUrl}${config.fg.paths.pdfService}` : '(not set)');
console.log('CKYC service   :', fgCkycFlavour());
console.log('Payment gateway:', config.fg.payment.gatewayUrl || '(not set)');
console.log('BancaChannel   :', config.fg.bancaChannel ? 'set' : 'NOT SET — proposals will fail');

if (missing.length) {
  console.error(`\n❌ Future Generali is not configured. Missing: ${missing.join(', ')}`);
  console.error('   Set them in .env — see .env.example.');
  process.exit(1);
}

// ── quote (ENQ) — a pure read ───────────────────────────────────────────────
const payload = samplePayload();
let premium = null;

heading('Quote (CreatePolicy / METHOD=ENQ)');
try {
  const { data, httpStatus } = await fgApi.getQuote(payload);
  console.log('HTTP           :', httpStatus);
  console.log('Status         :', data.status);
  console.log('ok             :', data.ok);
  console.log('PremiumAmt     :', data.totalPremium);
  console.log('PremWithServTax:', data.premiumWithServiceTax);
  console.log('Members priced :', data.members.length);
  if (data.errorMessage) console.log('FG said        :', data.errorMessage);
  premium = data.premiumWithServiceTax ?? data.totalPremium;

  if (!data.ok) {
    console.error('\n⚠️  Future Generali did not price this cover. Their message above is the');
    console.error('    reason — it is usually a sum insured, cover type or product rule.');
  }
} catch (error) {
  console.error('❌ QUOTE FAILED');
  console.error('   code   :', error.code);
  console.error('   message:', error.message);
  if (error.details) console.error('   details:', JSON.stringify(error.details, null, 2));
  process.exit(1);
}

// ── CKYC ────────────────────────────────────────────────────────────────────
heading(`CKYC (${fgCkycFlavour()})`);
if (fgCkycFlavour() === 'none') {
  console.log('Not configured — skipped. Set FG_GCKYC_* (preferred) or FG_CKYC_BASE_URL.');
} else {
  try {
    const { data } = await fgCkyc.createCKYC({
      reqId: `SMOKE-${Date.now()}`,
      idType: 'PAN',
      idNum: payload.client.pan,
      fullName: `${payload.client.firstName} ${payload.client.lastName}`,
      gender: payload.client.gender,
      dob: '06-09-1992', // CKYC wants dd-mm-yyyy; the SOAP side wants dd/mm/yyyy
      mobile: payload.client.address1.mobileNo,
    });
    console.log('ok          :', data.ok);
    console.log('proposalId  :', data.proposalId);
    console.log('finalStatus :', data.finalStatus);
    console.log('ckycNumber  :', data.ckycNumber || '(none — send the customer to uploadUrl)');
    console.log('uploadUrl   :', data.uploadUrl ? 'issued' : '(none)');
    if (data.ckycRemarks) console.log('remarks     :', data.ckycRemarks);
    if (data.errorMessage) console.log('error       :', data.errorMessage);
  } catch (error) {
    console.error('⚠️  CKYC FAILED (the quote leg above is unaffected)');
    console.error('   code   :', error.code);
    console.error('   message:', error.message);
  }
}

// ── proposal (CRT) — opt-in, creates a client record at FG ──────────────────
heading('Proposal (HealthPreCRTValidate / METHOD=CRT)');
if (!runProposal) {
  console.log('Skipped. Pass --proposal to run it.');
  console.log('It issues nothing, but FG\'s client handshake DOES create a client record.');
} else if (!config.fg.bancaChannel) {
  console.log('Skipped: FG_BANCA_CHANNEL is not set, so this would fail with');
  console.log('"BancaChannel Value INVALID". Ask Future Generali to issue the value.');
} else {
  try {
    const { data, clientId } = await fgApi.createProposal({
      ...payload,
      // Required on ANY CRT call, not just issuance: FG answer an empty
      // <Amount> with "Fail_Ex", a token that names nothing.
      receipt: { amount: premium },
    });
    console.log('Status       :', data.status);
    console.log('ok           :', data.ok);
    console.log('preCrtTranId :', data.preCrtTranId);
    console.log('clientId     :', clientId || '(none issued)');
    if (data.errorMessage) console.log('FG said      :', data.errorMessage);
  } catch (error) {
    console.error('❌ PROPOSAL FAILED');
    console.error('   code   :', error.code);
    console.error('   message:', error.message);
  }
}

// ── payment form — built, never submitted ───────────────────────────────────
heading('Payment form (built, NOT submitted)');
if (paymentMissing.length) {
  console.log(`Not configured — missing ${paymentMissing.join(', ')}.`);
} else {
  try {
    const form = buildPaymentRequest({
      transactionId: `SMOKE-${Date.now()}`,
      paymentOption: '3', // PayU — the only one of the three working on FG's UAT
      proposalNumber: 'SMOKE-PROPOSAL',
      premiumAmount: premium || 1,
      customer: {
        firstName: payload.client.firstName,
        lastName: payload.client.lastName,
        mobile: payload.client.address1.mobileNo,
        email: payload.client.address1.email,
      },
    });
    console.log('Gateway    :', form.url);
    console.log('Fields     :', form.fields.length, `(${form.fields.map((f) => f.name).join(', ')})`);
    const checksum = form.fields.find((f) => f.name === 'CheckSum');
    console.log('CheckSum   :', `${checksum.value.slice(0, 16)}… (${checksum.value.length} chars)`);
    const responseUrl = form.fields.find((f) => f.name === 'ResponseURL').value;
    console.log('ResponseURL:', responseUrl);
    if (!responseUrl.endsWith('/future-generali/payment/return')) {
      console.error('   ❌ That is not a route this service serves. A completed payment will');
      console.error('      404 and the buyer\'s WS_P_ID and PGID will be lost.');
    }
  } catch (error) {
    console.error('❌ PAYMENT FORM FAILED');
    console.error('   code   :', error.code);
    console.error('   message:', error.message);
  }
}

console.log('\nDone. Nothing was issued and no money was moved.\n');
