// ─────────────────────────────────────────────────────────────────────────────
// IFFCO Tokio (ITGI) — Partner Health constants.
//
// Master data from ITGI_PARTNER_HEALTH_KIT v3.5 (FHP + IHP field dictionaries)
// and Partner CKYC Kit v1.4.1, plus the handful of rules that exist only as
// observed staging behaviour — each of those is marked with what was observed
// and when, because they are the ones that may need revisiting.
//
// Nothing here is environment-dependent: no host, no credential, no partner
// code. Those live in config/env.js and come from the environment only.
// ─────────────────────────────────────────────────────────────────────────────

// Named after the config.itgi.paths key each one resolves against — see
// services/itgiApi.service.js's endpointFor().
const ITGI_OPERATIONS = {
  PREMIUM: 'premium',
  PROPOSAL: 'proposal',
  PAYMENT_CONFIRMATION: 'paymentConfirmation',
  POLICY_DOWNLOAD: 'policyDownload',
  KYC_FETCH: 'kycFetch',
  KYC_CREATE: 'kycCreate',
};

// api_transactions.api_name for each ITGI call. Prefixed so one query separates
// insurers in a table both write to (the column is a VARCHAR, not an enum —
// see migrations/001_create_journey_schema.sql).
const ITGI_API_NAMES = {
  PREMIUM: 'ITGI_PREMIUM',
  PROPOSAL: 'ITGI_PROPOSAL',
  PAYMENT_INITIATE: 'ITGI_PAYMENT_INITIATE',
  PAYMENT_CONFIRMATION: 'ITGI_PAYMENT_CONFIRMATION',
  PAYMENT_CALLBACK: 'ITGI_PAYMENT_CALLBACK',
  POLICY_DOWNLOAD: 'ITGI_POLICY_DOWNLOAD',
  KYC_FETCH: 'ITGI_KYC_FETCH',
  KYC_CREATE: 'ITGI_KYC_CREATE',
};

// FHP carries one floater sum insured on `health`; IHP carries one per member.
// Everything else about the two contracts is identical, including the paths.
const CONTRACT_TYPE = {
  FHP: 'FHP', // Family Health Protector (floater — SI at policy level)
  IHP: 'IHP', // Individual Health Plan   (SI per member)
};

// ── Health master data (FHPQuoteCreation.xlsx / IHPQuoteCreation.xlsx) ───────
//
// The "Table Driven" columns of the field dictionaries. ITGI reject an
// out-of-master value upstream with a generic error[] that names the field but
// not the reason, so these are mirrored here to fail before the round trip with
// a message that says what was wrong with the value.

/** Table=Gender, Column=KEY. Used by policyProfile.gender and member gender. */
const GENDER = { M: 'Male', F: 'Female' };

/**
 * Table=Relationship, Column=KEY — the member `relationship`. Full words, and
 * NOT interchangeable with NOMINEE_RELATIONSHIP below.
 */
const RELATIONSHIP = [
  'Self', 'Spouse', 'Father', 'Mother', 'Son', 'Daughter', 'Father in Law',
  'Mother in Law', 'Brother', 'Sister', 'Grand Father', 'Grand Mother',
  'Brother in Law', 'Daughter in Law', 'Grand Daughter', 'Grand Son', 'Niece',
  'Nephew', 'Sister in Law', 'Son in Law', 'Relative Living Together', 'Uncle',
];

/**
 * Table=Nominee_Relationship, Column=KEY — the nominee `nomineeRelationship`.
 *
 * A DIFFERENT master from RELATIONSHIP: short codes, not words. The FHP
 * proposal sample in the kit sends "Brother" here, which does not exist in this
 * table (the code is BRO) — the IHP sample gets it right with FATR/MOTR. Send
 * the KEY.
 */
const NOMINEE_RELATIONSHIP = {
  AUNT: 'AUNT',
  BRO: 'BROTHER',
  BROL: 'Brother in Law',
  CHLD: 'Child Family Dis eligible',
  DGTL: 'DAUGHTER IN LAW',
  DGTR: 'DAUGHTER',
  FATL: 'Father-in-law',
  FATR: 'Father',
  GDAU: 'Grand Daughter',
  GRF: 'Grand Father',
  GRM: 'Grand Mother',
  GSON: 'Grand Son',
  MOTL: 'Mother-in-law',
  MOTR: 'Mother',
  NEPW: 'Nephew',
  NIEC: 'Niece',
  ORS: 'Others not eligible for discnt',
  PARE: 'Parent',
  RELT: 'Relative Living Together',
  SELF: 'SELF',
  SIS: 'SISTER',
  SISL: 'SISTER in law',
  SON: 'Son',
  SONL: 'Son in Law',
  SPOU: 'Spouse (ie Husband or Wife)',
  UNCL: 'UNCLE',
};

/**
 * Table=Sum_Insured, Column=KEY. FHP runs to 30L, IHP stops at 20L — the two
 * workbooks ship different lists, so they are kept separate.
 *
 * ⚠️ The PRODUCT configuration is narrower than the master, and differs per
 * environment and partner code. On UAT for ITGIHLT073 (verified 2026-08-18)
 * FHP accepted 5L–30L and IHP 3L–20L; anything below came back as
 * "Invalid value from sum insured." Those bounds are deliberately NOT encoded
 * here — they are ITGI's product setup, not the contract, and hardcoding a UAT
 * band would reject values a production product may well sell. The master is
 * what the request must satisfy; the band is what ITGI answer.
 */
const SUM_INSURED = {
  FHP: [
    150000, 200000, 250000, 300000, 350000, 400000,
    500000, 600000, 700000, 800000, 900000, 1000000,
    1100000, 1200000, 1300000, 1400000, 1500000, 1600000, 1700000, 1800000,
    1900000, 2000000, 2100000, 2200000, 2300000, 2400000, 2500000, 2600000,
    2700000, 2800000, 2900000, 3000000,
  ],
  IHP: [
    150000, 200000, 250000, 300000, 350000, 400000,
    500000, 600000, 700000, 800000, 900000, 1000000,
    1100000, 1200000, 1300000, 1400000, 1500000, 1600000, 1700000, 1800000,
    1900000, 2000000,
  ],
};

/** policyProfile.salutation (proposal). */
const SALUTATION = ['MR', 'MS'];

/** health.insuranceType — "Value will always be NEW" per the field dictionary. */
const INSURANCE_TYPE = 'NEW';

/** Y/N fields throughout the health payloads. */
const YES_NO = ['Y', 'N'];

/**
 * medicalHistoryQuestions — the same five repeat for every member.
 * `declineIfTrue` marks the two ITGI will not sell against online.
 *
 * The `question` TEXT is load-bearing and is why this table carries the
 * wording rather than just the ids: ITGI dereference `question` while
 * deserializing a proposal, so an entry of `{ qid, answer }` — the shape the
 * field dictionary describes — takes the WHOLE proposal down with a generic
 * `errorField: "runtime"` fault that names nothing. Isolated on staging
 * 2026-08-24 against byte-identical payloads, three runs each: present and
 * non-null passes, absent or null fails; the text itself is never validated
 * ("" and arbitrary text both pass). So it is their NPE rather than a rule —
 * and helpers/itgi.helper.js fills it from here so callers can keep sending
 * `{ qid, answer }`.
 */
const MEDICAL_QUESTIONS = [
  { qid: 'Q1', question: 'High or low blood pressure', declineIfTrue: false },
  { qid: 'Q2', question: 'Diabetes', declineIfTrue: false },
  { qid: 'Q11', question: 'Thyroid disorder or any other endocrine disorder', declineIfTrue: false },
  { qid: 'Q98', question: 'Do you depend on insulin', declineIfTrue: true },
  {
    qid: 'Q99',
    question: 'Any other existing disease or additional facts which effect the proposed insurance & should be closed to insurer',
    declineIfTrue: true,
  },
];

// ── Hosted payment gateway ──────────────────────────────────────────────────
//
// ITGI take the money on their own page and issue the policy themselves —
// partner-end collection is disabled for our partner code, so /payment/
// confirmation answers "Payment at partner end is not allowed for this
// product." (verified on staging 2026-08-21 for ITGIHLT073, contract FHP).
//
// That makes the redirect below the ONLY channel by which a policy number
// reaches this service.

/**
 * The redirect ITGI send the buyer back on, as a single pipe-delimited value:
 *   {responseUrl}?ITGIResponse=product|orderNo|traceNo|policyNo|premium|message
 *
 * Field order confirmed against six live UAT payments on 2026-08-26, e.g.
 *   IHP|IHP20260826U20|087610|H1622549|5539|SUCCESS
 */
const PAYMENT_RESPONSE_FIELDS = [
  'product', 'orderNo', 'traceNo', 'policyNo', 'premiumPayable', 'message',
];

/** The query parameter carrying the value above. */
const PAYMENT_RESPONSE_PARAM = 'ITGIResponse';

/** `message` values on that redirect. Only SUCCESS means a policy exists. */
const PAYMENT_RESULT = {
  SUCCESS: 'SUCCESS',
  FAIL: 'FAIL',
  DECLINED: 'DECLINED',
  PENDING: 'PENDING',
  RESPONSE_MISMATCH: 'RESPONSE_MISMATCH',
};

/** ITGI's own wording for each, from ITGI_FHP_DOC v1.2 Annexure I. */
const PAYMENT_RESULT_MESSAGES = {
  SUCCESS: 'Payment deducted and policy submitted successfully',
  FAIL: 'Payment deducted but failed while creating policy',
  DECLINED: 'Customer declined the transaction at the payment gateway',
  PENDING: 'Customer left the transaction pending at the payment gateway',
  RESPONSE_MISMATCH: 'Deducted amount differs from the policy amount',
};

// ── CKYC (Partner CKYC Kit v1.4.1) ──────────────────────────────────────────
//
// A separate kit from the v3.5 health one, which is why no health workbook
// mentions any of this. It is the only source of `itgiUniqueReferenceId` — the
// IURN every proposal must carry as `itgiKYCReferenceNo`.
//
// Two things the kit gets wrong for this host, both confirmed on UAT
// 2026-08-19 by byte-identical requests differing only in the stated variable:
//   * Basic auth IS required (the kit shows none and assumes IP whitelisting);
//     without the header the connection is simply dropped.
//   * /partner-services/kyc/fetch-validate-otp answers 404, so the OTP leg of
//     the documented flow is not callable and is deliberately not implemented.

/** `result.status` values on a search. */
const CKYC_STATUS = {
  SUCCESS: 'SUCCESS',
  EXISTING_RECORD: 'EXISTING RECORD',
  OTP_PENDING: 'OTPPending',
  NO_RECORD: 'No Record',
  INVALID_REQUEST: 'INVALID REQUEST',
  // Seen live 2026-08-26 carrying a valid reference that a proposal then
  // accepted (orderNo FHP20260826U1). It is in no ITGI kit — which is why the
  // search envelope judges a record by whether it has an IURN rather than by
  // matching a known label. The vocabulary is open; an allow-list cannot hold.
  IN_PROGRESS: 'CKYCInProgress',
};

/** The three statuses that genuinely cannot carry a usable reference. */
const CKYC_UNUSABLE_STATUSES = [
  CKYC_STATUS.NO_RECORD,
  CKYC_STATUS.INVALID_REQUEST,
  CKYC_STATUS.OTP_PENDING,
];

/** `clientType` — individual or legal entity. */
const CKYC_CLIENT_TYPE = { IND: 'IND', LE: 'LE' };

/**
 * `idType` on a search. Table-driven upstream: an out-of-enum value is refused
 * with a bare 400 BAD_REQUEST carrying no field information (verified
 * 2026-08-19), so it is checked locally to produce something actionable.
 */
const CKYC_ID_TYPES = [
  'PAN',
  'PASSPORT',
  'VOTER ID',
  'DRIVING LICENSE',
  'AADHAAR',
  'CKYC IDENTIFIER',
  'ITGI UNIQUE IDENTIFIER',
];

/** `gender` — the CKYC service's own three-value set, not the health masters'. */
const CKYC_GENDER = { M: 'M', F: 'F', T: 'T' };

/** `kycDocuments[].idType` — the document's CATEGORY, not its name. */
const CKYC_DOCUMENT_TYPES = ['IDENTITY_PROOF', 'ADDRESS_PROOF', 'OTHERS'];

/** `kycDocuments[].fileExtension` — the only formats the service accepts. */
const CKYC_FILE_EXTENSIONS = ['pdf', 'jpg', 'jpeg', 'tif', 'tiff'];

/**
 * Document composition rules for a create, from the kit: PAN **or** FORM60 must
 * be present, at least one ADDRESS_PROOF, and a PHOTOGRAPH for an individual.
 * The photograph is categorised OTHERS because the idType enum has no photo
 * category of its own.
 */
const CKYC_DOC_NAME = { PAN: 'PAN', FORM60: 'FORM60', PHOTOGRAPH: 'PHOTOGRAPH' };

/**
 * Accepted `kycDocuments[].idName` on an IDENTITY_PROOF / ADDRESS_PROOF entry.
 * Mixed provenance, and none of it documented — a full sweep of kit v3.5
 * returns zero occurrences of kycDocuments, idName, idNumber, IDENTITY_PROOF or
 * ADDRESS_PROOF.
 *
 * STATED BY ITGI — 'AADHAR CARD NUMBER' is the Aadhaar value, given by the
 *   IFFCO Tokio team by email on 2026-08-25. Note the spelling: AADHAR, one
 *   'A', with the trailing 'CARD NUMBER'. Verified on staging the same day: a
 *   create carrying it with a 12-digit Aadhaar returned recordCreated "Y" and a
 *   real IURN. The earlier reading that Aadhaar was unsupported was wrong, and
 *   wrong in a way trial-and-error could not catch — an unguessable spelling is
 *   indistinguishable from an absent value when the only signal is generic.
 *
 * OBSERVED ON STAGING — the other four, 2026-08-24, by walking the vocabulary
 *   with one constant file: each answers with a specific error about the NUMBER
 *   (so the name parsed), while unrecognised names fall through to the generic
 *   "Provided ADDRESS_PROOF not in valid format", which names no field and
 *   reads like a bad upload.
 *
 * OTHERS entries (the photograph) are exempt and must stay so — PHOTOGRAPH
 * sits outside this set and is accepted there.
 */
const CKYC_CREATE_ID_NAMES_OBSERVED = [
  'PAN', 'PASSPORT', 'VOTER ID', 'DRIVING LICENSE',
  'AADHAR CARD NUMBER',
];

/**
 * The character set for `kycDocuments[].idNumber`, in ITGI's own words from a
 * staging rejection on 2026-08-24: "ALPHABETS, NUMBER, PUNCTUATIONS. THE
 * ALLOWED PUNCTUATIONS ARE AS FOLLOWS: / [ ] { } ( ) -". No spaces and no
 * commas — so an address pasted into the number field fails, as does an empty
 * string. Undocumented; it reached us in an error message.
 */
const CKYC_ID_NUMBER_PATTERN = /^[A-Z0-9/[\]{}()-]+$/;

/** `relationshipType` for the related-person block on a create. */
const CKYC_RELATIONSHIP_TYPES = ['Father', 'Spouse', 'Mother'];

export {
  ITGI_OPERATIONS,
  ITGI_API_NAMES,
  CONTRACT_TYPE,
  GENDER,
  RELATIONSHIP,
  NOMINEE_RELATIONSHIP,
  SUM_INSURED,
  SALUTATION,
  INSURANCE_TYPE,
  YES_NO,
  MEDICAL_QUESTIONS,
  PAYMENT_RESPONSE_FIELDS,
  PAYMENT_RESPONSE_PARAM,
  PAYMENT_RESULT,
  PAYMENT_RESULT_MESSAGES,
  CKYC_STATUS,
  CKYC_UNUSABLE_STATUSES,
  CKYC_CLIENT_TYPE,
  CKYC_ID_TYPES,
  CKYC_GENDER,
  CKYC_DOCUMENT_TYPES,
  CKYC_FILE_EXTENSIONS,
  CKYC_DOC_NAME,
  CKYC_CREATE_ID_NAMES_OBSERVED,
  CKYC_ID_NUMBER_PATTERN,
  CKYC_RELATIONSHIP_TYPES,
};
