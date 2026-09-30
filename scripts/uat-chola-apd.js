// ─────────────────────────────────────────────────────────────────────────────
// UAT: one Chola Flexi Health case, end to end, with CHOLA_PAYMENT_MODE=APD —
// printing every request and response.
//
//   npm run uat:chola:apd
//
//   1 Token → 2 PremiumComputation → 3 ProposalSave
//           → 4 PolicyGeneration (APD) → 5 PolicySchedule
//
// ⚠️ THIS SPENDS UAT DEPOSIT. It saves a real UAT proposal and, if APD is
// mapped for our intermediary code, debits Chola's UAT Advance Premium Deposit
// and issues a UAT policy. It refuses any base URL that is not a UAT host, and
// PolicyGeneration is sent exactly once (services/cholaPolicyIssuer.service.js).
//
// Needs migration 005 applied (`npm run migrate`): the proposal is claimed in
// health_chola_proposals before PolicyGeneration goes out, and the raw exchange
// is written to health_chola_policy_generation_logs — the same rows the ops
// screen (GET /chola-ms/ops) shows. Step 4 is printed FROM those rows, so what
// appears here is byte for byte what went to Chola.
//
// The customer is the one in Chola's own Flexi Health Postman sample (name, PAN,
// CKYC number, DOB) — their UAT test identity, used so a KYC rule cannot mask
// what this run is for: whether APD is accepted.
//
// A port of the working implementation's scripts/uat-chola-apd.js.
// ─────────────────────────────────────────────────────────────────────────────

// Set before anything reads config. dotenv never overwrites a value already in
// process.env, so this holds whatever .env says. Imports are dynamic for that
// reason — a static import would read config before this line ran.
process.env.CHOLA_PAYMENT_MODE = 'APD';

const { default: config } = await import('../src/config/env.js');
const { getCholaToken } = await import('../src/services/cholaAuth.service.js');
const cholaApi = await import('../src/services/cholaApi.service.js');
const issuer = await import('../src/services/cholaPolicyIssuer.service.js');
const cholaRepository = await import('../src/repositories/chola.repository.js');
const { cholaToday } = await import('../src/helpers/cholaPolicyGeneration.helper.js');
const { default: db } = await import('../src/db/index.js');

const PRODUCT = 'FLEXI_HEALTH';

// Chola's Flexi Health kit sample customer.
const CUSTOMER = {
  title: 'Ms',
  name: 'Roobini Dayalan',
  gender: 'F',
  genderWord: 'Female',
  dob: '05/12/1991',
  pan: 'LODPS1715L',
  ckycNumber: '30092089587992',
  mobile: '8989898989',
  email: 'test@gmail.com',
  address: '2 33 test street test nagar',
  // Nilgiris — Tier 2. InsuredCity 555 and Area 152063 are the Tier 2 rating
  // codes (see CHOLA_TIER_CODES in the frontend's cholaQuote.js); they must
  // agree or the proposal re-prices away from the quote.
  pincode: '643240',
  tierCity: '555',
  tierArea: '152063',
};
const SUM_INSURED = 500000;

function banner(step, title) {
  console.log(`\n${'═'.repeat(78)}\n STEP ${step} — ${title}\n${'═'.repeat(78)}`);
}

function indent(s) {
  return String(s).split('\n').map((l) => `    ${l}`).join('\n');
}

function pretty(value) {
  if (value == null) return '(none)';
  if (typeof value !== 'string') return JSON.stringify(value, null, 2);
  try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
}

/** An exchange as the services return it (Bearer token already masked). */
function printExchange(x) {
  if (!x) {
    console.log('  (no exchange recorded)');
    return;
  }
  console.log(`→ ${x.method} ${x.url}`);
  console.log(`  headers: ${JSON.stringify(x.requestHeaders)}`);
  console.log('  request body:');
  console.log(indent(pretty(x.requestBody)));
  console.log(`← HTTP ${x.responseStatus ?? '(no response)'}`);
  console.log('  response body:');
  console.log(indent(pretty(x.responseBody)));
}

/** A health_chola_policy_generation_logs row — exactly as sent and received. */
function printEvidence(row) {
  console.log(`→ POST ${row.request_url}   [${row.source}, ${row.payment_mode}, ${row.created_at}]`);
  console.log(`  headers: ${row.request_headers}`);
  console.log('  request body (exactly as sent):');
  console.log(indent(pretty(row.request_body)));
  console.log(`← HTTP ${row.http_status ?? '(no response)'} in ${row.duration_ms ?? '?'} ms`);
  if (row.error_message) console.log(`  transport error: ${row.error_code || ''} ${row.error_message}`);
  console.log('  raw response body (exactly as received):');
  console.log(indent(row.response_body ?? '(none)'));
}

/** dd/MM/yyyy on the Indian calendar, `days`/`years` from today. */
function istDate({ days = 0, years = 0 } = {}) {
  const [d, m, y] = cholaToday().split('/').map(Number);
  const t = new Date(Date.UTC(y + years, m - 1, d + days));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()}`;
}

function quoteBody() {
  return {
    product: PRODUCT,
    PolicyType: 'I',
    Tenure: '1',
    NoofFamilyMembers: '1',
    TransactionType: 'N',
    PaymentOption: 'S',
    BasePolicyNo: '',
    Spec_Exclusion_Ref_No: 0,
    InsuredMembers: [{
      Relation: 'Self',
      InsuredDateofBirth: CUSTOMER.dob,
      InsuredCity: CUSTOMER.tierCity,
      SumInsured: String(SUM_INSURED),
      Loading_Percentage: 0,
      Underwriter_Comments: '',
    }],
  };
}

/**
 * ProposalSave, in the shape the website's buildCholaProposalRequest sends and
 * Chola's UAT has accepted: Int64 fields as "0" never "", DebitMandate "Y" with
 * the mandate bounded to the policy period (the only form Chola save), neither
 * delivery format requested.
 */
function proposalBody() {
  // Cover starts tomorrow — Chola refuse a back-dated start — and the mandate
  // runs for exactly the policy period.
  const start = istDate({ days: 1 });
  const end = istDate({ years: 1 });
  const uniqueTransactionId = `${Date.now().toString().slice(-11)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
  return {
    product: PRODUCT,
    UniqueTransactionID: uniqueTransactionId,
    BranchName: '',
    CustomerID: '0',
    Spec_Exclusion_Ref_No: '0',
    TransactionFailureReason: '',
    TransactionStatus: '',
    UMRNInvalidReason: '',
    UMRNNo: '0',
    UMRNStatus: '',
    TransactionType: 'N',
    BasePolicyNo: '',
    POSCode: '',
    POSName: '',
    POSPANNumber: '',
    POSAadharNumber: '',
    Tenure: 1,
    PolicyStartDate: start,
    TypeOfCustomer: 'I',
    CustomerType: 'NEW',
    Title: CUSTOMER.title,
    CustomerName: CUSTOMER.name,
    CustomerAddress: CUSTOMER.address,
    Pincode: CUSTOMER.pincode,
    Area: CUSTOMER.tierArea,
    DateOfBirth: CUSTOMER.dob,
    Gender: CUSTOMER.gender,
    GSTNumber: '',
    ISDNumber: '',
    PanNo: CUSTOMER.pan,
    AADHARCARD: '',
    MobileNumber: CUSTOMER.mobile,
    EmailID: CUSTOMER.email,
    AlternateEmailID: '',
    PolicyType: 'I',
    // The kit sample's mandate account.
    BankName: 'Bank name',
    BankBranch: 'STATE BANK OF INDIA',
    AccountNumber: '1234567890',
    IFSCCode: 'ICIC0909',
    MICRCode: 'ICIC0909',
    NameOfAccountHolder: CUSTOMER.name,
    TypeOfAccount: 'Other',
    DebitType: 'FA',
    DebitPeriodFrom: start,
    DebitPeriodTo: end,
    UntilCancelled: '',
    PaymentMethod: 'Other',
    DebitMandate: 'Y',
    PaymentOption: 'S',
    NoOfFamilyMembers: 1,
    DateOfIncorporation: '',
    CKYCNumber: CUSTOMER.ckycNumber,
    OVDType: '',
    OVDID: '',
    CustomerPANNo: CUSTOMER.pan,
    physicalFormatrequirement: 'N',
    eFormatrequirement: 'N',
    NameofInsuranceRepository: '',
    Einsuranceaccountnumber: '',
    InsuredDetails: [{
      InsuredName: CUSTOMER.name,
      Relation: 'Self',
      Gender: CUSTOMER.genderWord,
      DOB: CUSTOMER.dob,
      HeightInCentimeters: '160',
      HeightInFeet: '0',
      HeightInInches: '0',
      Weight: '60',
      Maritalstatus: 'Married',
      Occupation: '001',
      AnnualIncome: 1000000,
      AdverseHistory: 'No',
      AdverseHistoryDetails: '',
      NomineeName: 'Test Nominee',
      NomineeRelationship: 'Mother',
      NomineeOthersDescription: '',
      NomineeContactNo: '9875789601',
      EmailID: CUSTOMER.email,
      PhoneNumber: CUSTOMER.mobile,
      SumInsured: SUM_INSURED,
      SpecificExclusion: '',
      WhetherPolicyPorted: 'No',
      PortedSI: '0',
      PortedDate: '',
      DateofCommencementofFirstPolicy: '',
      PreviousInsurer: '',
      PreviousPolicySI: '',
      PreviousPolicyNo: '',
      ExpiringPolicyRN_Or_PolicyCopyAttached: 'No',
      PortedCumulativeBonus: '0',
      CustomerReferenceNumber: '',
      AadharNo: '',
      PANNo: '',
      EInsuranceAccountNo: '',
      SpecifiedPersonName: '',
      SPCertificateNo: '',
      SolID: '',
      MarketingOfficerName: '',
      MarketingOfficerID: '',
      Loading_Percentage: '0',
      Underwriter_Comments: '',
      Nominee_Email_ID: '',
      Nominee_Present_Address: CUSTOMER.address,
      Nominee_Permanent_Address: CUSTOMER.address,
      Nominee_DOB: '09/08/1970',
      Name_of_the_Bank_and_Branch: '',
      Account_No: '',
      IFSC_Code: '',
      MICR_Code: '',
      Name_of_the_Appointee: '',
      Relationship_to_Nominee: '',
      Appointee_others_description: '',
      Appointee_Mobile_number: '0',
      Appointee_Present_address: '',
      Appointee_Permanent_address: '',
      Appointee_Email_ID: '',
    }],
  };
}

async function preflight() {
  if (!config.chola.baseUrl) {
    throw new Error('CHOLA_BASE_URL is not set. See .env.example.');
  }
  const host = new URL(config.chola.baseUrl).hostname;
  if (!/uat/i.test(host)) {
    throw new Error(`Refusing to run: CHOLA_BASE_URL host "${host}" is not a UAT host. This script spends deposit.`);
  }
  try {
    await db.query('SELECT 1 FROM health_chola_proposals LIMIT 1');
    await db.query('SELECT 1 FROM health_chola_policy_generation_logs LIMIT 1');
  } catch (error) {
    throw new Error(`The Chola tables are not reachable (${error.message}). Run \`npm run migrate\` first.`);
  }
  console.log(`Chola base URL : ${config.chola.baseUrl}`);
  console.log(`Payment mode   : ${config.chola.paymentMode}`);
  console.log(`Product        : ${PRODUCT}`);
  console.log(`Run at         : ${new Date().toISOString()}`);
}

async function main() {
  await preflight();

  banner(1, 'Token');
  const token = await getCholaToken();
  console.log(`→ POST ${config.chola.baseUrl}${config.chola.paths.token}  (Basic client credentials — masked)`);
  console.log(`← access_token (${String(token).length} chars, value not shown)`);

  banner(2, 'PremiumComputation');
  const quote = await cholaApi.getQuote(quoteBody());
  printExchange(quote.exchange);
  if (!quote.result.data.succeeded) {
    throw new Error(`PremiumComputation did not succeed: ${quote.result.data.message || quote.result.data.status}`);
  }

  banner(3, 'ProposalSave');
  const proposal = await cholaApi.createProposal(proposalBody());
  printExchange(proposal.exchange);
  if (!proposal.result.data.succeeded) {
    throw new Error(`ProposalSave did not succeed: ${proposal.result.data.message || proposal.result.data.status}`);
  }
  const proposalNo = proposal.result.data.genconProposalNumber;
  // Chola re-price on ProposalSave; that figure, not the quote's, is what gets tagged.
  const amount = proposal.result.data.premium ?? quote.result.data.totalPremium;

  banner(4, 'PolicyGeneration (APD)');
  const issued = await issuer.issue({ product: PRODUCT, GenconProposalNumber: proposalNo, Amount: amount });
  const evidence = await cholaRepository.listPolicyGenerationLogs({ genconProposalNumber: proposalNo });
  if (evidence.length === 0) {
    console.log('  (no evidence row — the request never left; see the outcome below)');
  }
  for (const row of evidence.reverse()) printEvidence(row);

  const { data } = issued.result;
  banner(5, 'PolicySchedule');
  if (!data.schedule) {
    console.log('  skipped — PolicyGeneration did not issue a policy.');
  } else {
    console.log(`  schedule URL : ${data.schedule.scheduleUrl || '—'}`);
    console.log(`  CIS URL      : ${data.schedule.customerInformationSheetUrl || '—'}`);
    console.log('  raw response :');
    console.log(indent(pretty(data.schedule.raw)));
  }

  banner('✓', 'Outcome');
  const row = await cholaRepository.findProposal(proposalNo);
  console.log(`Quote premium         : ₹${quote.result.data.totalPremium}`);
  console.log(`Proposal              : ${proposalNo} (re-priced ₹${proposal.result.data.premium}, customer ${proposal.result.data.customerId})`);
  console.log(`PolicyGeneration mode : ${data.paymentMode}`);
  console.log(`Status                : ${data.status}`);
  console.log(`Policy number         : ${data.genconPolicyNumber || '—'}`);
  if (data.message) console.log(`Message               : ${data.message}`);
  if (data.schedule) {
    console.log(`PDF stored            : ${data.schedule.pdfStored ? 'yes' : `no — ${data.schedule.pdfError}`}`);
  }
  console.log(`DB row                : health_chola_proposals status=${row?.status} updated=${row?.updated_at}`);
}

try {
  await main();
} catch (error) {
  console.error(`\nUAT run stopped: ${error.code ? `${error.code} ` : ''}${error.message}`);
  if (error.details) console.error(`details: ${JSON.stringify(error.details, null, 2)}`);
  process.exitCode = 1;
} finally {
  await db.closePool().catch(() => {});
}
