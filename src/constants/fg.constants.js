// ─────────────────────────────────────────────────────────────────────────────
// Future Generali — the vocabulary of the TCS "BO" SOAP service, the two CKYC
// services and the web-aggregator payment gateway.
//
// Everything here is CONTRACT, not configuration: SOAP operation names, the
// <METHOD> tokens, the product catalogue, the request paths appended to a base
// URL, the gateway's field order. None of it differs between UAT and
// production, so none of it is env-driven — the same reason
// itgi.constants.js holds ITGI's masters rather than config/env.js.
//
// Ported from the working NovaCred implementation
// (src/providers/future-generali/constants.js and its siblings). Names,
// spellings and orderings are reproduced EXACTLY, including FG's own
// misspellings — a "corrected" tag is an element FG's service does not know.
// ─────────────────────────────────────────────────────────────────────────────

// ── SOAP ────────────────────────────────────────────────────────────────────
//
// The BO service exposes ONE physical endpoint (<base>/BO/Service.svc) and two
// operations reused across every health product. The business step is chosen by
// the SOAP operation + the <METHOD> tag inside the CDATA <Root> payload:
//
//   Quote (premium)   → op=CreatePolicy,         METHOD=ENQ
//   Proposal validate → op=HealthPreCRTValidate, METHOD=CRT
//   Policy issuance   → op=CreatePolicy,         METHOD=CRT + Receipt filled
const SOAP_OP = {
  CREATE_POLICY: 'CreatePolicy',
  PRE_CRT_VALIDATE: 'HealthPreCRTValidate',
};

// <METHOD> values inside the Root payload.
const METHOD = {
  ENQUIRY: 'ENQ', // quotation / premium calculation
  CREATE: 'CRT',  // proposal validation & policy issuance
};

// SOAPAction header value: "<tempuri>/IService/<op>".
//
// The BO service's contract is IService. The policy-document service is a
// DIFFERENT contract (IService1) on a different path — see PDF_CONTRACT below.
function soapAction(tempuri, op, contract = 'IService') {
  return `${String(tempuri).replace(/\/$/, '')}/${contract}/${op}`;
}

// ── Products ────────────────────────────────────────────────────────────────

// <Member> block layouts. The products do NOT share one member shape: element
// names, which elements are present, and their ORDER all differ. Sending one
// product's member block for another is not a partial payload FG completes with
// defaults — it is a block whose elements FG does not recognise, answered with
// the same empty *Result that an unprovisioned product produces.
const MEMBER_SHAPE = {
  HEALTH_TOTAL: 'HEALTH_TOTAL',
  HEALTH_ABSOLUTE: 'HEALTH_ABSOLUTE',
  ADVANTAGE_TOP_UP: 'ADVANTAGE_TOP_UP',
};

// `product` is the value that goes into <tem:Product>; MajorClass, ContractType
// and the default PolicyType feed the <Root> payload. Taken from the kit's own
// sample payloads.
const PRODUCTS = {
  HEALTH_TOTAL: {
    key: 'HEALTH_TOTAL',
    product: 'HealthTotal',
    majorClass: 'HTO',
    contractType: 'HTO',
    defaultPolicyType: 'HTI',
    memberShape: MEMBER_SHAPE.HEALTH_TOTAL,
    // Withdrawn for new business. The definition stays so existing policies and
    // their payloads remain reproducible; the service refuses it, because FG
    // themselves answer with an empty *Result that reads like a provisioning or
    // credential fault rather than "this product is gone".
    discontinued:
      'Generali Central has discontinued Health Total for new business (confirmed by GCI, August 2026)',
  },
  HEALTH_ABSOLUTE: {
    key: 'HEALTH_ABSOLUTE',
    product: 'HealthAbsolute',
    majorClass: 'FHA',
    contractType: 'FHA',
    defaultPolicyType: 'HAI',
    memberShape: MEMBER_SHAPE.HEALTH_ABSOLUTE,
  },
  ADVANTAGE_TOP_UP: {
    key: 'ADVANTAGE_TOP_UP',
    product: 'AdvantageTopup',
    majorClass: 'FAT',
    contractType: 'FAT',
    defaultPolicyType: 'HTI',
    memberShape: MEMBER_SHAPE.ADVANTAGE_TOP_UP,
  },
};

// What Generali Central list as available for health integration (August 2026),
// in their order. `key` points at a PRODUCTS entry; null means the TCS kit ships
// a spec but the payload has not been built or verified here.
const GCI_AVAILABLE_PRODUCTS = [
  { name: 'Health Absolute', key: 'HEALTH_ABSOLUTE' },
  { name: 'Varishta Bima', key: null },
  { name: 'DIY', key: null },
  { name: 'Future Advantage Topup', key: 'ADVANTAGE_TOP_UP' },
  { name: 'Health Unlimited', key: null },
  { name: 'Personal Accident', key: null },
];

/** Product keys implemented here AND that FG still write. */
function sellableProductKeys() {
  return Object.keys(PRODUCTS).filter((key) => !PRODUCTS[key].discontinued);
}

/** GCI product names not implemented here yet. */
function unimplementedProductNames() {
  return GCI_AVAILABLE_PRODUCTS.filter((entry) => !entry.key).map((entry) => entry.name);
}

// ── CKYC ────────────────────────────────────────────────────────────────────

// Legacy NL-CKYC, relative to FG_CKYC_BASE_URL.
const CKYC_PATH = {
  CREATE: '/API/CKYC/CreateCKYC',
  STATUS: '/API/CKYC/GetCKYCStatus',
};

// GC-CKYC 3.0.0, relative to FG_GCKYC_BASE_URL. Note the differing segments:
// verification sits under /Web, status under /Verify.
const GCKYC_PATH = {
  VERIFY: '/GCKYC/3.0.0/Web/VerifyCKYC',
  STATUS: '/GCKYC/3.0.0/Verify/GetKycStatus',
};

// finalStatus values that mean the KYC passed. "0" means not completed, with
// the reason in `message`.
const CKYC_VERIFIED_STATUSES = ['1', '3'];

// ── Policy document ─────────────────────────────────────────────────────────
//
// A separate WCF endpoint with its own contract name. <PolicyNO> has a capital
// O; a "corrected" <PolicyNo> is an element the service does not know.
const PDF_SERVICE_PATH = '/TCSPDFService/Service1.svc';
const PDF_CONTRACT = 'IService1';
const PDF_OPERATION = 'GetPDF';

/** A PDF always begins "%PDF-". The cheapest possible sanity check. */
const PDF_MAGIC = '%PDF-';

// ── Payment ─────────────────────────────────────────────────────────────────

// The eleven CheckSum fields, in FG's order (v1.39, "To Generate CheckSum",
// "1) For .Net the format provided below"), which states the format string
// verbatim:
//
//   "TransactionID|PaymentOption|ResponseURL|ProposalNumber|PremiumAmount|
//    UserIdentifier|UserId|FirstName|LastName|Mobile|Email|"
//
// Nothing else may be added: `Vendor` sits beside CheckSum in the posted form
// but is NOT part of its input, and CheckSum is obviously not part of its own.
//
// ⚠️ DO NOT "FIX" THIS FROM THE PHP SAMPLE. Two sections later the same document
// gives a PHP example whose string carries a TWELFTH value — a timestamp,
// "…|test@test.com|17/04/2018 11:16:14 AM |". It is a stale sample, not a
// second contract: the .Net section is the one that states the format, the
// request parameter table lists exactly these eleven plus Vendor and CheckSum,
// and this eleven-field form is what the working integration has always sent.
// Adding the timestamp would change every checksum and FG would reject the lot.
const CHECKSUM_FIELDS = [
  'TransactionID', 'PaymentOption', 'ResponseURL', 'ProposalNumber',
  'PremiumAmount', 'UserIdentifier', 'UserId', 'FirstName', 'LastName',
  'Mobile', 'Email',
];

// Gateway selection. v1.39 lists these as the payment PROVIDER, not the
// instrument — "1 [PayTm] OR 2 [HDFC] OR 3 [PayU]". The parameter sheet in the
// same kit calls 1 "Net Banking" and 2 "Credit/Debit Card"; the document wins,
// because UAT sends option 2 to RedirectHDFC.aspx.
const PAYMENT_OPTIONS = [
  { value: '1', label: 'PayTm' },
  { value: '2', label: 'HDFC' },
  { value: '3', label: 'PayU' },
];

// Outcome of a callback, independent of whether the payment itself succeeded.
//
// UNVERIFIED is the one that matters: a response that ARRIVED but could not be
// read is not a failed payment. Money may well have moved, and reporting it as
// "not received" is what invites a buyer to pay twice.
const PAYMENT_RESULT = {
  SUCCESS: 'success',       // FG said Success
  FAILURE: 'failure',       // FG said Failure/Error, or the buyer cancelled
  UNVERIFIED: 'unverified', // something arrived; it could not be read
  EMPTY: 'empty',           // nothing arrived at all
};

// Keys FG carry the ciphertext under, most authoritative first.
//
// `ResponseData` is the name v1.39 actually specifies — "Response Field Name is
// ResponseData" — and it leads the list for that reason. The rest are names
// observed or plausible on other FG channels, kept because the callback must
// never fail to find the payload it was sent: a ciphertext this service cannot
// locate is reported as `unverified`, which is money possibly moved and a buyer
// told to wait.
const PAYMENT_CIPHER_KEYS = [
  'ResponseData', 'responsedata',
  'EncResponse', 'encresponse', 'Response', 'response', 'Data', 'data', 'Enc', 'enc',
];

// Field names that identify an already-plaintext FG response.
const PAYMENT_PLAINTEXT_FIELDS = ['WS_P_ID', 'TID', 'PGID', 'Response', 'Premium'];

// ─────────────────────────────────────────────────────────────────────────────
// FG's CODED-VALUE MASTERS.
//
// GENERATED, NOT TRANSCRIBED, from the sheets of
// "Field Masters for Health Absolute.xlsx" in FG's TCS Health API Kit. Do not
// hand-edit: regenerate from the workbook when FG issue a new one.
//
// These exist because of HOW FG reject a wrong value. <Occupation>, <Relation>,
// <NomineeRelation>, <Salutation> and <MaritalStatus> are closed code lists, and
// a value outside them is answered with a bare sentence naming the field and
// nothing else — "Occupation is incorrect." No code, no field path, no hint at
// what the accepted values are. Worse, the QUOTE leg does not check any of them,
// so a wrong occupation prices perfectly and only fails at the proposal, after
// the buyer has chosen a plan.
//
// Validating here turns that into a message naming the field AND the codes FG
// accept. See helpers/fgCodes.helper.js.
//
// ⚠️ FG's runtime accepts a SUPERSET of these sheets — their own samples send
// <NomineeRelation>BROT</NomineeRelation>, which appears in no master, and a
// live probe on 2026-08-11 accepted the occupation 'STUD', which also does not.
// So these lists are the DOCUMENTED vocabulary, not a proven-exhaustive one, and
// validation against them is advisory-strict: it rejects a value FG would almost
// certainly reject anyway, with a better message than FG give.
// ─────────────────────────────────────────────────────────────────────────────

// <Occupation> / <InsuredOccpn> — 140 codes.
const FG_OCCUPATION = {
  ACCT: 'Accountant',
  ACTR: 'Actor/Actress',
  ADVO: 'Advocate',
  AGET: 'Agent (Insurance)',
  AIRF: 'Air Force',
  AMEX: 'Admin Executive',
  ARCH: 'Architect',
  ARMY: 'Army',
  BAPR: 'Baggage Porter',
  BARB: 'Barbers',
  BARM: 'Barman',
  BEAU: 'Beauticians',
  BLRM: 'Boilerman',
  BROK: 'Brokers',
  BULD: 'Builder',
  BUSM: 'Businessman',
  CARP: 'Carpenter',
  CASH: 'Cashier',
  CEME: 'Chemical Engineer',
  CHPR: 'Choreographer',
  CMST: 'Chemist',
  COME: 'Computer Engineer',
  CONS: 'Consultant',
  CONW: 'Construction Site Worker',
  COOK: 'Cook',
  CROP: 'Crane Operator',
  CVLE: 'Civil Engineer',
  DELI: 'Deliveryman',
  DENT: 'Dentist',
  DIEC: 'Die-Cutting Machine Operator',
  DIR: 'Director',
  DIVE: 'Diver (Commercial/Military)',
  DNCR: 'Dancer',
  DOCT: 'Doctor',
  DRAU: 'Draughtmen',
  DRIV: 'Driver',
  EDPO: 'EDP Operator',
  ELET: 'Electricians',
  ENGR: 'Engineer',
  ESTA: 'Estate Agents',
  EXEC: 'Executive',
  EXHL: 'Explosives handler',
  FACT: 'Factory Workers',
  FARM: 'Farmer',
  FIRE: 'Fireman',
  FISH: 'Fisherman',
  FITR: 'Fitter',
  FKOP: 'Forklift Operator',
  FLIG: 'Flight Steward/Stewardess',
  FORE: 'Foreman',
  FORO: 'Forest Officer',
  FOUD: 'Foundary Worker',
  FURN: 'Furnacemen',
  GASA: 'Gas Attendant',
  GEOL: 'Geologist',
  HAWK: 'Hawkers',
  HOAT: 'Hospital Attendant',
  HOTW: 'Hotel & Restaurant Waiters',
  HROF: 'Human Resource Officer',
  HSWF: 'Housewife',
  JOCK: 'Jockey',
  JUDG: 'Judge',
  JUVN: 'Juvenille',
  JWLR: 'Jeweler',
  LABR: 'Labourer',
  LABT: 'Laboratory Technician',
  LCTR: 'Lecturer',
  MACH: 'Machinist',
  MAIN: 'Maintenance Engineer',
  MARE: 'Marine Engineer',
  MARI: 'Mariner',
  MASN: 'Mason/ Plasterer',
  MECH: 'Mechanic',
  MEEN: 'Mechanical Engineer',
  MGR: 'Manager',
  MILK: 'Milkman',
  MINE: 'Mining Engineer',
  MINR: 'Miner',
  MKTG: 'Marketing Executive',
  MOPR: 'Machine Operators',
  MRTC: 'Train Driver',
  MUSI: 'Musician/ Singer',
  NAVY: 'Navy',
  NURS: 'Nurse',
  OFFR: 'Officer',
  OILW: 'Oil Refinery Worker',
  OTHR: 'Other Occupation',
  PAIN: 'Painter',
  PATH: 'Pathologist',
  PENS: 'Pensioner',
  PEON: 'Peon',
  PHAR: 'Pharmacist',
  PLOT: 'Pilot',
  PLTE: 'Plant Technician',
  PLTN: 'Politician',
  PLUM: 'Plumber',
  POLM: 'Police / Constable',
  POST: 'Postman',
  PRDE: 'Production Engineer',
  PRFS: 'Professional',
  PROF: 'Professor',
  PRPL: 'Principal',
  PRST: 'Priest',
  PWRO: 'Power Plant Operator',
  RADO: 'Radiologist',
  RECP: 'Receptionist',
  RETR: 'Retired',
  RIGR: 'Rigger',
  RPTR: 'Reporter',
  RTEC: 'Radio & TV Technician',
  RTHE: 'Radiotherapist',
  SAIL: 'Seaman/Sailor',
  SALE: 'Salesmen',
  SANI: 'Sanitary Inspector',
  SCIE: 'Scientist',
  SECG: 'Security Guard',
  SECR: 'Secretary',
  SHCL: 'Shipping Clerk',
  SHIP: 'Shipyard Worker',
  SOCI: 'Social Worker',
  SOPT: 'Site Operation Technologist',
  SPOT: 'Sports Person',
  STDN: 'Student',
  STFM: 'Site Foreman',
  STNP: 'Stenographer',
  STUN: 'Stunt performer',
  SUPV: 'Supervisor',
  SVCM: 'Service',
  SWEP: 'Sweeper',
  TAIL: 'Tailor',
  TEAC: 'Teacher',
  TECH: 'Technician',
  TFPO: 'Traffic Police',
  TUTO: 'Tutor',
  UNDA: 'Underwriter',
  UNEM: 'Unemployed',
  WELD: 'Welder',
  WIRE: 'Wireman',
  WOCU: 'Wood Cutter',
  XRAY: 'X-Ray Technician',
};

// <NomineeRelation> — 9 codes.
const FG_NOMINEE_RELATION = {
  SON: 'Son',
  SPOU: 'Spouse',
  WIFE: 'Wife',
  CHLD: 'Child',
  DAUG: 'Daughter',
  HUSB: 'Husband',
  MOTH: 'Mother',
  SELF: 'Self',
  FATH: 'Father',
};

// <Salutation> — 18 codes.
const FG_SALUTATION = {
  ADM: 'Admiral',
  ADV: 'Advocate',
  BRIG: 'Brigadier',
  CDR: 'Cdr.',
  COL: 'Colonel',
  DR: 'Dr.',
  LT: 'Lieutenant',
  MAJ: 'Major',
  MAST: 'Master',
  MISS: 'Miss',
  MR: 'Mr.',
  MRS: 'Mrs.',
  MS: 'Ms.',
  PROF: 'Proffessor',
  SHRI: 'Shri',
  SIR: 'Sir',
  SMT: 'Shrimati',
  Mx: 'Mixed',
};

// <MaritalStatus> — 6 codes.
// FG list six rows but only five codes: W is both Widow and Widower.
const FG_MARITAL_STATUS = {
  D: 'Divorced',
  M: 'Married',
  S: 'Single',
  W: 'Widow',
  W: 'Widower',
  L: 'Live in relationship',
};

// <Gender> / <InsuredGender> — 3 codes.
const FG_GENDER = {
  M: 'Male',
  F: 'Female',
  O: 'Other',
};

// <CheckType> — 9 codes.
const FG_CHECK_TYPE = {
  A: 'American Express Card',
  H: 'House Cheque',
  L: 'Local Cheque',
  M: 'Master Card',
  F: 'Miscellaneous',
  N: 'NEFT',
  O: 'Outstation Cheque',
  R: 'RTGS',
  V: 'Visa Card',
};

// <ReceiptType> item codes — 10.
const FG_RECEIPT_TYPE = {
  A: 'ACH/ ECS',
  '1': 'Cash',
  '2': 'Cheque',
  '9': 'Credit Card',
  D: 'Direct Cash',
  Z: 'DEMAND DRAFT',
  '3': 'EFT',
  V: 'IVR Payment',
  '4': 'Journal Adjustments',
  Q: 'Quick Pay',
};

// <Relation> — 9 codes.
const FG_RELATION = {
  SELF: 'Self',
  SPOU: 'Spouse',
  CHLD: 'Child',
  PARE: 'Parents',
  DAUG: 'Daughter',
  SON: 'Son',
  SIB: 'Siblings',
  GRPA: 'Grandparent',
  GRCH: 'Grandchild',
};

// Offered on Platinum & Signature for QUOTATION only, per the master's
// "Only Quote" column — not issuable on Classic.
const FG_RELATION_QUOTE_ONLY = new Set(['GRCH', 'GRPA', 'SIB']);

// <PolicyType> — 2 codes.
const FG_POLICY_TYPE = {
  HAI: 'Health Absolute Individual',
  HAF: 'Health Absolute Family',
};

// ── Operations & audit names ────────────────────────────────────────────────

const FG_OPERATIONS = {
  QUOTE: 'quote',
  PROPOSAL: 'proposal',
  ISSUE: 'issue',
  CKYC_CREATE: 'ckycCreate',
  CKYC_STATUS: 'ckycStatus',
  PAYMENT_SESSION: 'paymentSession',
  PAYMENT_RETURN: 'paymentReturn',
  PAYMENT_ISSUE: 'paymentIssue',
  POLICY_PDF: 'policyPdf',
};

// api_transactions.api_name for each FG call. Prefixed so one query separates
// insurers in a table all three write to (the column is a VARCHAR, not an enum
// — see migrations/001_create_journey_schema.sql).
const FG_API_NAMES = {
  QUOTE: 'FG_QUOTE',
  PROPOSAL: 'FG_PROPOSAL',
  ISSUE: 'FG_ISSUE',
  CKYC_CREATE: 'FG_CKYC_CREATE',
  CKYC_STATUS: 'FG_CKYC_STATUS',
  PAYMENT_SESSION: 'FG_PAYMENT_SESSION',
  PAYMENT_CALLBACK: 'FG_PAYMENT_CALLBACK',
  PAYMENT_ISSUE: 'FG_PAYMENT_ISSUE',
  POLICY_PDF: 'FG_POLICY_PDF',
};

// ── Body metrics ────────────────────────────────────────────────────────────
//
// There is no BMI element on the wire. FG compute it from <Height> and <Weight>
// and reject the proposal with "BMI is Invalid for Member N" when they cannot —
// an error naming a quantity never sent, about two fields that WERE sent, empty.
//
// The bounds are deliberately generous. Whether a particular BMI is insurable is
// FG's underwriting call, and a narrower bound here would reject business they
// would have written. What these catch is a MALFORMED request: a height in
// metres or feet is always out of range, and the BMI recheck catches a pair that
// is plausible on each side but cannot describe a person.
const HEIGHT_CM = { min: 30, max: 275 };
const WEIGHT_KG = { min: 2, max: 500 };
const BMI_PLAUSIBLE = { min: 5, max: 100 };

export {
  SOAP_OP,
  METHOD,
  soapAction,
  MEMBER_SHAPE,
  PRODUCTS,
  GCI_AVAILABLE_PRODUCTS,
  sellableProductKeys,
  unimplementedProductNames,
  CKYC_PATH,
  GCKYC_PATH,
  CKYC_VERIFIED_STATUSES,
  PDF_SERVICE_PATH,
  PDF_CONTRACT,
  PDF_OPERATION,
  PDF_MAGIC,
  CHECKSUM_FIELDS,
  PAYMENT_OPTIONS,
  PAYMENT_RESULT,
  PAYMENT_CIPHER_KEYS,
  PAYMENT_PLAINTEXT_FIELDS,
  FG_OPERATIONS,
  FG_API_NAMES,
  FG_OCCUPATION,
  FG_NOMINEE_RELATION,
  FG_SALUTATION,
  FG_MARITAL_STATUS,
  FG_GENDER,
  FG_CHECK_TYPE,
  FG_RECEIPT_TYPE,
  FG_RELATION,
  FG_RELATION_QUOTE_ONLY,
  FG_POLICY_TYPE,
  HEIGHT_CM,
  WEIGHT_KG,
  BMI_PLAUSIBLE,
};
