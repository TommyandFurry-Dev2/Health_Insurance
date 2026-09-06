import { validationError, isBlank } from './itgi.helper.js';
import {
  CONTRACT_TYPE,
  GENDER,
  RELATIONSHIP,
  NOMINEE_RELATIONSHIP,
  SUM_INSURED,
  SALUTATION,
  INSURANCE_TYPE,
  YES_NO,
  MEDICAL_QUESTIONS,
  CKYC_CLIENT_TYPE,
  CKYC_ID_TYPES,
  CKYC_GENDER,
  CKYC_DOCUMENT_TYPES,
  CKYC_FILE_EXTENSIONS,
  CKYC_DOC_NAME,
  CKYC_RELATIONSHIP_TYPES,
  CKYC_CREATE_ID_NAMES_OBSERVED,
  CKYC_ID_NUMBER_PATTERN,
} from '../constants/itgi.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Pre-flight validation for the ITGI payloads.
//
// Why it exists: ITGI answer a malformed HEALTH request with HTTP 200 and a
// generic `error[]`, and a malformed CKYC request with a bare 400 carrying no
// field information at all. Either way a wrong nominee relationship code or an
// out-of-master sum insured surfaces as an opaque upstream failure long after
// the buyer filled the form. Everything checked here is a documented,
// table-driven rule from the field dictionaries — nothing is invented, and
// nothing about the outgoing payload is rewritten.
//
// The CKYC functions additionally NORMALISE (trim, strip non-digits from
// mobile/pincode, upper-case idType), because the CKYC service is stricter
// about shape than the health endpoints and rejects on whitespace.
// ─────────────────────────────────────────────────────────────────────────────

// ── primitives ──────────────────────────────────────────────────────────────

function fail(message, field) {
  throw validationError(`ITGI: ${message}`, field);
}

function need(value, field, label) {
  if (isBlank(value)) fail(`${label} is required`, field);
  return value;
}

function oneOf(value, allowed, field, label) {
  if (isBlank(value)) return;
  if (!allowed.includes(value)) {
    fail(`${label} must be one of ${allowed.join(', ')} (got "${value}")`, field);
  }
}

function maxLen(value, length, field, label) {
  if (!isBlank(value) && String(value).length > length) {
    fail(`${label} must be at most ${length} characters (got ${String(value).length})`, field);
  }
}

function digits(value, length, field, label) {
  if (isBlank(value)) return;
  if (!new RegExp(`^\\d{${length}}$`).test(String(value))) {
    fail(`${label} must be exactly ${length} digits (got "${value}")`, field);
  }
}

/** ITGI health dates are dd/MM/yyyy throughout. Returns a local-midnight Date. */
function parseDdMmYyyy(value, field, label) {
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(String(value ?? ''))) {
    fail(`${label} must be in DD/MM/YYYY format (got "${value}")`, field);
  }
  const [day, month, year] = String(value).split('/').map(Number);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    fail(`${label} is not a real calendar date ("${value}")`, field);
  }
  return date;
}

function today() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

// ── shared health blocks ────────────────────────────────────────────────────

/**
 * `health` fields common to premium and proposal. sumInsured placement differs
 * by contract type: FHP carries a single floater SI on `health`, IHP carries
 * one per member.
 */
function validateHealthCommon(health, contractType) {
  need(health, 'health', 'health');
  need(health.insuranceType, 'health.insuranceType', 'health.insuranceType');
  oneOf(health.insuranceType, [INSURANCE_TYPE], 'health.insuranceType', 'health.insuranceType');

  for (const key of ['criticalIllnessCovered', 'consumables', 'roomRentWaiver', 'iffcoTokioPolicy']) {
    need(health[key], `health.${key}`, `health.${key}`);
    oneOf(health[key], YES_NO, `health.${key}`, `health.${key}`);
  }
  if (health.iffcoTokioPolicy === 'Y') {
    need(health.iffcoTokioPolicyNo, 'health.iffcoTokioPolicyNo',
      'health.iffcoTokioPolicyNo (required when iffcoTokioPolicy is "Y")');
    maxLen(health.iffcoTokioPolicyNo, 10, 'health.iffcoTokioPolicyNo', 'health.iffcoTokioPolicyNo');
  }

  const inception = parseDdMmYyyy(
    need(health.inceptionDate, 'health.inceptionDate', 'health.inceptionDate'),
    'health.inceptionDate', 'health.inceptionDate'
  );
  if (inception < today()) {
    fail('health.inceptionDate must not be before the current date', 'health.inceptionDate');
  }
  const expiration = parseDdMmYyyy(
    need(health.expirationDate, 'health.expirationDate', 'health.expirationDate'),
    'health.expirationDate', 'health.expirationDate'
  );
  if (expiration <= inception) {
    fail('health.expirationDate must be after health.inceptionDate', 'health.expirationDate');
  }

  need(health.policyProfile, 'health.policyProfile', 'health.policyProfile');
  need(health.policyProfile.gender, 'health.policyProfile.gender', 'health.policyProfile.gender');
  oneOf(health.policyProfile.gender, Object.keys(GENDER),
    'health.policyProfile.gender', 'health.policyProfile.gender');

  if (contractType === CONTRACT_TYPE.FHP) {
    const sumInsured = need(health.sumInsured, 'health.sumInsured', 'health.sumInsured (FHP floater)');
    if (!SUM_INSURED.FHP.includes(Number(sumInsured))) {
      fail(`health.sumInsured ${sumInsured} is not in the FHP Sum_Insured master`, 'health.sumInsured');
    }
  }
}

/** individualMembers[] fields common to premium and proposal. */
function validateMembersCommon(health, contractType) {
  const members = health.individualMembers;
  if (!Array.isArray(members) || members.length === 0) {
    fail('health.individualMembers must be a non-empty array', 'health.individualMembers');
  }

  members.forEach((member, index) => {
    const at = `health.individualMembers[${index}]`;
    if (!Number.isInteger(member.recordIndex)) {
      fail(`${at}.recordIndex must be an integer starting from 0`, `${at}.recordIndex`);
    }
    parseDdMmYyyy(need(member.dateOfBirth, `${at}.dateOfBirth`, `${at}.dateOfBirth`),
      `${at}.dateOfBirth`, `${at}.dateOfBirth`);
    oneOf(need(member.gender, `${at}.gender`, `${at}.gender`), Object.keys(GENDER),
      `${at}.gender`, `${at}.gender`);
    oneOf(need(member.relationship, `${at}.relationship`, `${at}.relationship`), RELATIONSHIP,
      `${at}.relationship`, `${at}.relationship`);

    if (contractType === CONTRACT_TYPE.IHP) {
      const sumInsured = need(member.sumInsured, `${at}.sumInsured`, `${at}.sumInsured (IHP per-member SI)`);
      if (!SUM_INSURED.IHP.includes(Number(sumInsured))) {
        fail(`${at}.sumInsured ${sumInsured} is not in the IHP Sum_Insured master`, `${at}.sumInsured`);
      }
    }
  });

  if (members[0] && members[0].recordIndex !== 0) {
    fail('health.individualMembers recordIndex must start from 0', 'health.individualMembers[0].recordIndex');
  }
}

// ── premium ─────────────────────────────────────────────────────────────────

/** Premium request — FHPPremiumCalculator.xlsx / IHPPremiumCalculator.xlsx. */
function validatePremium(body) {
  need(body.uniqueReferenceNo, 'uniqueReferenceNo', 'uniqueReferenceNo');
  maxLen(body.uniqueReferenceNo, 100, 'uniqueReferenceNo', 'uniqueReferenceNo');
  need(body.partnerDetail && body.partnerDetail.partnerCode,
    'partnerDetail.partnerCode', 'partnerDetail.partnerCode');

  validateHealthCommon(body.health, body.contractType);
  validateMembersCommon(body.health, body.contractType);
}

// ── proposal ────────────────────────────────────────────────────────────────

function validateNominees(health) {
  const nominees = health.nominee;
  if (!Array.isArray(nominees) || nominees.length === 0) {
    fail('health.nominee must be a non-empty array', 'health.nominee');
  }

  let total = 0;
  nominees.forEach((nominee, index) => {
    const at = `health.nominee[${index}]`;
    maxLen(need(nominee.nomineeFirstName, `${at}.nomineeFirstName`, `${at}.nomineeFirstName`), 30,
      `${at}.nomineeFirstName`, `${at}.nomineeFirstName`);
    maxLen(need(nominee.nomineeLastName, `${at}.nomineeLastName`, `${at}.nomineeLastName`), 30,
      `${at}.nomineeLastName`, `${at}.nomineeLastName`);

    // Nominee_Relationship master — short codes (BRO, FATR, SPOU…), not the
    // full words used by member `relationship`.
    const relationship = need(nominee.nomineeRelationship, `${at}.nomineeRelationship`, `${at}.nomineeRelationship`);
    if (!Object.keys(NOMINEE_RELATIONSHIP).includes(String(relationship))) {
      fail(
        `${at}.nomineeRelationship "${relationship}" is not in the Nominee_Relationship master `
        + '(use the KEY, e.g. BRO/FATR/MOTR/SPOU/SELF — not the member relationship word)',
        `${at}.nomineeRelationship`
      );
    }

    const share = Number(need(nominee.nomineePercentageShare, `${at}.nomineePercentageShare`, `${at}.nomineePercentageShare`));
    if (!Number.isFinite(share) || share <= 0) {
      fail(`${at}.nomineePercentageShare must be greater than zero`, `${at}.nomineePercentageShare`);
    }
    total += share;

    maxLen(need(nominee.nomineeAdress1, `${at}.nomineeAdress1`, `${at}.nomineeAdress1`), 30,
      `${at}.nomineeAdress1`, `${at}.nomineeAdress1`);
    maxLen(need(nominee.nomineeAdress2, `${at}.nomineeAdress2`, `${at}.nomineeAdress2`), 30,
      `${at}.nomineeAdress2`, `${at}.nomineeAdress2`);
    digits(need(nominee.nomineePinCode, `${at}.nomineePinCode`, `${at}.nomineePinCode`), 6,
      `${at}.nomineePinCode`, `${at}.nomineePinCode`);
  });

  if (total !== 100) {
    fail(`health.nominee percentage shares must total exactly 100 (got ${total})`, 'health.nominee');
  }
}

function validateProposerProfile(profile) {
  need(profile, 'health.policyProfile', 'health.policyProfile');
  const at = 'health.policyProfile';
  digits(need(profile.mobile, `${at}.mobile`, `${at}.mobile`), 10, `${at}.mobile`, `${at}.mobile`);
  need(profile.emailId, `${at}.emailId`, `${at}.emailId`);
  maxLen(need(profile.firstName, `${at}.firstName`, `${at}.firstName`), 30, `${at}.firstName`, `${at}.firstName`);
  maxLen(need(profile.lastName, `${at}.lastName`, `${at}.lastName`), 30, `${at}.lastName`, `${at}.lastName`);
  parseDdMmYyyy(need(profile.dateOfBirth, `${at}.dateOfBirth`, `${at}.dateOfBirth`),
    `${at}.dateOfBirth`, `${at}.dateOfBirth`);
  oneOf(need(profile.salutation, `${at}.salutation`, `${at}.salutation`), SALUTATION,
    `${at}.salutation`, `${at}.salutation`);
  maxLen(need(profile.address1, `${at}.address1`, `${at}.address1`), 30, `${at}.address1`, `${at}.address1`);
  maxLen(need(profile.address2, `${at}.address2`, `${at}.address2`), 30, `${at}.address2`, `${at}.address2`);
  maxLen(profile.address3, 30, `${at}.address3`, `${at}.address3`);
  maxLen(profile.address4, 30, `${at}.address4`, `${at}.address4`);
  digits(need(profile.pincode, `${at}.pincode`, `${at}.pincode`), 6, `${at}.pincode`, `${at}.pincode`);
  need(profile.country, `${at}.country`, `${at}.country`);
}

/** Lifestyle conditionals + the five medical questions, per member. */
function validateMemberProposalDetail(member, index) {
  const at = `health.individualMembers[${index}]`;
  maxLen(need(member.firstName, `${at}.firstName`, `${at}.firstName`), 30, `${at}.firstName`, `${at}.firstName`);
  maxLen(need(member.lastName, `${at}.lastName`, `${at}.lastName`), 30, `${at}.lastName`, `${at}.lastName`);

  // "If <habit> is Y than this field is mandatory" (individualMembers sheet).
  const conditionals = [
    ['alcohol', 'alcoholConsumptionPerWeek'],
    ['smoke', 'smokeCigarettePerDay'],
    ['tobacco', 'tobaccoConsumptionPerWeek'],
  ];
  for (const [habit, detail] of conditionals) {
    oneOf(member[habit], YES_NO, `${at}.${habit}`, `${at}.${habit}`);
    if (member[habit] === 'Y') {
      need(member[detail], `${at}.${detail}`, `${at}.${detail} (required when ${habit} is "Y")`);
    }
  }

  const answers = member.medicalHistoryQuestions;
  if (!Array.isArray(answers) || answers.length === 0) {
    fail(`${at}.medicalHistoryQuestions must be a non-empty array`, `${at}.medicalHistoryQuestions`);
  }

  const byId = new Map(answers.map((answer) => [answer.qid, answer]));
  for (const question of MEDICAL_QUESTIONS) {
    const answer = byId.get(question.qid);
    if (!answer) {
      fail(`${at}.medicalHistoryQuestions is missing ${question.qid} ("${question.question}")`,
        `${at}.medicalHistoryQuestions`);
    }
    // The kit's two samples disagree on the type — FHP sends booleans, IHP the
    // strings "false" — so both are accepted.
    const yes = answer.answer === true || String(answer.answer).toLowerCase() === 'true';
    const no = answer.answer === false || String(answer.answer).toLowerCase() === 'false';
    if (!yes && !no) {
      fail(`${at}.medicalHistoryQuestions ${question.qid}.answer must be true or false (got "${answer.answer}")`,
        `${at}.medicalHistoryQuestions`);
    }
    if (yes && question.declineIfTrue) {
      fail(`${at} answered "true" to ${question.qid} ("${question.question}") — ITGI do not sell this policy online`,
        `${at}.medicalHistoryQuestions`);
    }
  }
}

/** Proposal request — FHPQuoteCreation.xlsx / IHPQuoteCreation.xlsx. */
function validateProposal(body) {
  const contractType = body.contractType;
  need(body.uniqueReferenceNo, 'uniqueReferenceNo', 'uniqueReferenceNo');
  maxLen(body.uniqueReferenceNo, 100, 'uniqueReferenceNo', 'uniqueReferenceNo');
  need(body.partnerDetail && body.partnerDetail.partnerCode,
    'partnerDetail.partnerCode', 'partnerDetail.partnerCode');

  if (!isBlank(body.ignoreCkyc)) {
    const value = String(body.ignoreCkyc).toLowerCase();
    if (value !== 'true' && value !== 'false') {
      fail(`ignoreCkyc must be "true" or "false" (got "${body.ignoreCkyc}")`, 'ignoreCkyc');
    }
  }

  // Mandatory per the `object` sheet — the reference ITGI mint from their CKYC
  // API — and mandatory in practice even when ignoreCkyc is "true". Verified on
  // UAT 2026-08-18 with an otherwise identical payload: with the reference and
  // ignoreCkyc="true" ITGI answer statusMessage KYC_IGNORE_VALID_REQUEST; drop
  // the reference and the same request dies as a generic errorField "runtime"
  // technical fault with nothing to act on. So it is required unconditionally,
  // and ignoreCkyc only turns off the VALIDATION of the reference, not the need
  // to send one.
  need(body.itgiKYCReferenceNo, 'itgiKYCReferenceNo',
    'itgiKYCReferenceNo (obtain it from ITGI CKYC; required even when ignoreCkyc is "true")');

  const health = body.health;
  validateHealthCommon(health, contractType);
  validateMembersCommon(health, contractType);

  maxLen(need(health.emergencyContactName, 'health.emergencyContactName', 'health.emergencyContactName'), 30,
    'health.emergencyContactName', 'health.emergencyContactName');
  digits(need(health.emergencyContactMobile, 'health.emergencyContactMobile', 'health.emergencyContactMobile'), 10,
    'health.emergencyContactMobile', 'health.emergencyContactMobile');

  // IHP additionally carries the KYC document on `health`; FHP does not.
  if (contractType === CONTRACT_TYPE.IHP) {
    need(health.kycDocument, 'health.kycDocument', 'health.kycDocument (IHP)');
    maxLen(need(health.kycDocumentNo, 'health.kycDocumentNo', 'health.kycDocumentNo (IHP)'), 12,
      'health.kycDocumentNo', 'health.kycDocumentNo');
  }

  need(health.premiumPayble, 'health.premiumPayble',
    'health.premiumPayble (the net premium returned by the premium service — note ITGI\'s spelling)');
  need(health.accountNumber, 'health.accountNumber', 'health.accountNumber');
  need(health.ifscCode, 'health.ifscCode', 'health.ifscCode');
  need(health.payeeName, 'health.payeeName', 'health.payeeName');

  validateNominees(health);
  validateProposerProfile(health.policyProfile);
  health.individualMembers.forEach(validateMemberProposalDetail);
}

// ── payment confirmation / policy download ──────────────────────────────────

/**
 * Payment confirmation. Undocumented: ITGI_FHP_DOC v1.2 lists the URL in
 * Annexure I with a one-line purpose and nothing else — no field list, no
 * sample, no sheet. These were established against staging on 2026-08-21, one
 * round trip per field, because ITGI name exactly one missing field at a time.
 *
 * ⚠️ This endpoint is only usable when payment is collected at the PARTNER end,
 * which is switched off for our partner code — it answers "Payment at partner
 * end is not allowed for this product." The route exists so the flow is
 * complete the day ITGI enable it; today the hosted gateway is the only path.
 */
function validatePaymentConfirmation(body) {
  for (const field of ['orderNo', 'uniqueReferenceNo', 'ptnrTransactionLogId', 'traceNo', 'authorizationCode']) {
    need(body[field], field, field);
  }
}

/**
 * Policy download.
 *
 * The identifier is `policyDownloadNo` and it is the POLICY number from the
 * gateway redirect, never the orderNo — the controller defaults it from orderNo
 * only because a caller holding one and not the other is the common case
 * immediately after issuance.
 *
 * `contractType` is checked here rather than left to ITGI because omitting it
 * makes them answer `partnerDetails: "Partner details are invalid."` — an error
 * about a field that is perfectly correct, which sends you checking credentials
 * instead of the payload. Supplying it turns the same request into the true
 * answer ("Policy number not found against your partner code"). Verified by a
 * four-way matrix on staging, 2026-08-21. prepareRequest always sets it, so
 * this only fires if that ever stops being true.
 */
function validatePolicyDownload(body) {
  need(body.policyDownloadNo, 'policyDownloadNo',
    'policyDownloadNo (the POLICY number from the payment redirect, not the orderNo)');
  need(body.contractType, 'contractType',
    'contractType (omitting it makes ITGI answer with a misleading "Partner details are invalid.")');
}

// ── CKYC ────────────────────────────────────────────────────────────────────

function ckycNeed(value, field, label = 'ITGI CKYC') {
  if (isBlank(value)) {
    throw validationError(`${label}: ${field} is required`, field);
  }
  return String(value).trim();
}

/**
 * Validate and normalise a CKYC SEARCH before spending a round trip. ITGI
 * answer a malformed CKYC request with a bare 400 BAD_REQUEST carrying no field
 * information at all (verified on UAT 2026-08-19), so anything checkable is
 * checked here to produce a message that names the problem.
 */
function prepareCkycFetch(input = {}) {
  const clientType = input.clientType || CKYC_CLIENT_TYPE.IND;
  if (!CKYC_CLIENT_TYPE[clientType]) {
    throw validationError(`ITGI CKYC: clientType must be IND or LE (got "${clientType}")`, 'clientType');
  }

  const firstName = ckycNeed(input.firstName, 'firstName');
  const idNumber = ckycNeed(input.idNumber, 'idNumber');
  const idType = ckycNeed(input.idType, 'idType').toUpperCase();
  if (!CKYC_ID_TYPES.includes(idType)) {
    throw validationError(
      `ITGI CKYC: idType "${idType}" is not one of ${CKYC_ID_TYPES.join(', ')}`, 'idType'
    );
  }

  // DD-MM-YYYY with HYPHENS — note this differs from the health endpoints'
  // DD/MM/YYYY. ISO order is accepted by the transport but answered with
  // INVALID REQUEST, so it is refused here where the reason can be stated.
  const dateofBirth = ckycNeed(input.dateofBirth, 'dateofBirth');
  if (!/^\d{2}-\d{2}-\d{4}$/.test(dateofBirth)) {
    throw validationError(
      `ITGI CKYC: dateofBirth must be DD-MM-YYYY (got "${dateofBirth}")`, 'dateofBirth'
    );
  }

  const gender = input.gender ? String(input.gender).trim().toUpperCase() : undefined;
  if (gender && !CKYC_GENDER[gender]) {
    throw validationError(`ITGI CKYC: gender must be M, F or T (got "${gender}")`, 'gender');
  }

  const mobileNumber = input.mobileNumber
    ? String(input.mobileNumber).replace(/\D/g, '').slice(-10)
    : undefined;
  if (clientType === CKYC_CLIENT_TYPE.IND && !mobileNumber) {
    throw validationError('ITGI CKYC: mobileNumber is required for an individual', 'mobileNumber');
  }

  return {
    clientType,
    firstName,
    ...(input.middleName ? { middleName: String(input.middleName).trim() } : {}),
    ...(input.lastName ? { lastName: String(input.lastName).trim() } : {}),
    dateofBirth,
    ...(gender ? { gender } : {}),
    idType,
    idNumber,
    ...(mobileNumber ? { mobileNumber } : {}),
  };
}

/** kycDocuments[] shape + the three composition rules from the kit. */
function prepareCkycDocuments(docs, clientType) {
  if (!Array.isArray(docs) || docs.length === 0) {
    throw validationError('ITGI CKYC create: kycDocuments must be a non-empty array', 'kycDocuments');
  }

  const prepared = docs.map((doc, index) => {
    const at = `kycDocuments[${index}]`;

    const idType = String(doc.idType ?? '').trim().toUpperCase();
    if (!CKYC_DOCUMENT_TYPES.includes(idType)) {
      throw validationError(
        `ITGI CKYC create: ${at}.idType must be one of ${CKYC_DOCUMENT_TYPES.join(', ')}`, `${at}.idType`
      );
    }

    const extension = String(doc.fileExtension ?? '').trim().toLowerCase();
    if (!CKYC_FILE_EXTENSIONS.includes(extension)) {
      throw validationError(
        `ITGI CKYC create: ${at}.fileExtension must be one of ${CKYC_FILE_EXTENSIONS.join(', ')}`,
        `${at}.fileExtension`
      );
    }

    const fileBase64 = String(doc.fileBase64 ?? '').trim();
    if (!fileBase64) {
      throw validationError(`ITGI CKYC create: ${at}.fileBase64 is required`, `${at}.fileBase64`);
    }

    const idName = String(doc.idName ?? '').trim().toUpperCase();
    if (!idName) {
      throw validationError(`ITGI CKYC create: ${at}.idName is required`, `${at}.idName`);
    }

    // Checked against the OBSERVED staging vocabulary, not a documented one —
    // see CKYC_CREATE_ID_NAMES_OBSERVED. This exists to save a round trip that
    // currently cannot succeed: a name outside the set comes back as "Provided
    // ADDRESS_PROOF not in valid format", which names the idType rather than the
    // document and so reads as a bad upload.
    //
    // It guards against observed behaviour, so it may need relaxing once ITGI
    // confirm the real vocabulary. OTHERS is exempt: the photograph sits outside
    // the set and is accepted there.
    const isProof = idType === 'IDENTITY_PROOF' || idType === 'ADDRESS_PROOF';
    const idNumber = String(doc.idNumber ?? '').trim();

    if (isProof) {
      if (!CKYC_CREATE_ID_NAMES_OBSERVED.includes(idName)) {
        // A near-miss Aadhaar spelling is the common mistake, because the one
        // ITGI accept is not the one anybody guesses. Point straight at it
        // rather than listing five.
        const isAadhaar = idName.startsWith('AADHA') || idName === 'UID';
        throw validationError(
          isAadhaar
            ? `ITGI CKYC create: ${at}.idName "${idName}" is not the value ITGI accept for an `
              + 'Aadhaar. Use "AADHAR CARD NUMBER" — ITGI confirmed that exact spelling by email '
              + 'on 2026-08-25 (single "A" in AADHAR, and the trailing "CARD NUMBER").'
            : `ITGI CKYC create: ${at}.idName "${idName}" is not among the accepted names `
              + `(${CKYC_CREATE_ID_NAMES_OBSERVED.join(', ')}). The full vocabulary is not `
              + 'documented in ITGI Partner Health Kit v3.5 — "AADHAR CARD NUMBER" came from ITGI '
              + 'directly, the rest from staging observation on 2026-08-24.',
          `${at}.idName`
        );
      }
      if (!idNumber) {
        throw validationError(
          `ITGI CKYC create: ${at}.idNumber is required for a ${idName} document `
          + '(observed on ITGI staging 2026-08-24; not documented in kit v3.5)',
          `${at}.idNumber`
        );
      }
      if (!CKYC_ID_NUMBER_PATTERN.test(idNumber.toUpperCase())) {
        throw validationError(
          `ITGI CKYC create: ${at}.idNumber may contain only letters, digits and / [ ] { } ( ) - `
          + '— no spaces or commas. ITGI stated this character set in a staging rejection on '
          + '2026-08-24; it is not documented in kit v3.5',
          `${at}.idNumber`
        );
      }
    }

    return {
      idType,
      idName,
      idNumber,
      fileName: String(doc.fileName ?? `document-${index + 1}`).trim(),
      fileExtension: extension,
      fileBase64,
    };
  });

  const names = prepared.map((doc) => doc.idName);
  if (!names.includes(CKYC_DOC_NAME.PAN) && !names.includes(CKYC_DOC_NAME.FORM60)) {
    throw validationError('ITGI CKYC create: a PAN or FORM60 document is mandatory', 'kycDocuments');
  }
  if (!prepared.some((doc) => doc.idType === 'ADDRESS_PROOF')) {
    throw validationError('ITGI CKYC create: at least one ADDRESS_PROOF document is mandatory', 'kycDocuments');
  }
  if (clientType === CKYC_CLIENT_TYPE.IND && !names.includes(CKYC_DOC_NAME.PHOTOGRAPH)) {
    throw validationError('ITGI CKYC create: a PHOTOGRAPH is mandatory for an individual', 'kycDocuments');
  }

  return prepared;
}

/**
 * Validate and normalise a CKYC CREATE.
 *
 * The document rules are the kit's own (PAN or FORM60; at least one address
 * proof; a photograph for an individual). They are checked here because ITGI
 * answer a rule breach with a status and a BLANK IURN rather than anything
 * naming the missing document — and because a rejected create still costs the
 * customer an upload.
 */
function prepareCkycCreate(input = {}) {
  const label = 'ITGI CKYC create';
  const clientType = input.clientType || CKYC_CLIENT_TYPE.IND;
  if (!CKYC_CLIENT_TYPE[clientType]) {
    throw validationError(`${label}: clientType must be IND or LE (got "${clientType}")`, 'clientType');
  }

  const dateofBirth = ckycNeed(input.dateofBirth, 'dateofBirth', label);
  if (!/^\d{2}-\d{2}-\d{4}$/.test(dateofBirth)) {
    throw validationError(`${label}: dateofBirth must be DD-MM-YYYY (got "${dateofBirth}")`, 'dateofBirth');
  }

  const gender = input.gender ? String(input.gender).trim().toUpperCase() : undefined;
  if (gender && !CKYC_GENDER[gender]) {
    throw validationError(`${label}: gender must be M, F or T (got "${gender}")`, 'gender');
  }

  const relationshipType = input.relationshipType ? String(input.relationshipType).trim() : undefined;
  if (relationshipType && !CKYC_RELATIONSHIP_TYPES.includes(relationshipType)) {
    throw validationError(
      `${label}: relationshipType must be one of ${CKYC_RELATIONSHIP_TYPES.join(', ')}`, 'relationshipType'
    );
  }

  const kycDocuments = prepareCkycDocuments(input.kycDocuments, clientType);

  return {
    clientType,
    ...(input.prefix ? { prefix: String(input.prefix).trim() } : {}),
    firstName: ckycNeed(input.firstName, 'firstName', label),
    ...(input.middleName ? { middleName: String(input.middleName).trim() } : {}),
    ...(input.lastName ? { lastName: String(input.lastName).trim() } : {}),
    ...(gender ? { gender } : {}),
    dateofBirth,
    ...(relationshipType ? { relationshipType } : {}),
    ...(input.relatedPersonPrefix ? { relatedPersonPrefix: String(input.relatedPersonPrefix).trim() } : {}),
    ...(input.relatedPersonFirstName ? { relatedPersonFirstName: String(input.relatedPersonFirstName).trim() } : {}),
    ...(input.relatedPersonMiddleName ? { relatedPersonMiddleName: String(input.relatedPersonMiddleName).trim() } : {}),
    ...(input.relatedPersonLastName ? { relatedPersonLastName: String(input.relatedPersonLastName).trim() } : {}),
    mobileNumber: ckycNeed(input.mobileNumber, 'mobileNumber', label).replace(/\D/g, '').slice(-10),
    emailAddress: ckycNeed(input.emailAddress, 'emailAddress', label),
    // Permanent address
    addressLine1: ckycNeed(input.addressLine1, 'addressLine1', label),
    city: ckycNeed(input.city, 'city', label),
    district: ckycNeed(input.district, 'district', label),
    state: ckycNeed(input.state, 'state', label),
    country: ckycNeed(input.country, 'country', label),
    pinCode: ckycNeed(input.pinCode, 'pinCode', label).replace(/\D/g, ''),
    // Correspondence address
    correspondenceAddressLine1: ckycNeed(input.correspondenceAddressLine1, 'correspondenceAddressLine1', label),
    correspondenceCity: ckycNeed(input.correspondenceCity, 'correspondenceCity', label),
    correspondenceDistrict: ckycNeed(input.correspondenceDistrict, 'correspondenceDistrict', label),
    correspondenceState: ckycNeed(input.correspondenceState, 'correspondenceState', label),
    correspondenceCountry: ckycNeed(input.correspondenceCountry, 'correspondenceCountry', label),
    correspondencePinCode: ckycNeed(input.correspondencePinCode, 'correspondencePinCode', label).replace(/\D/g, ''),
    kycDocuments,
  };
}

export {
  validatePremium,
  validateProposal,
  validatePaymentConfirmation,
  validatePolicyDownload,
  prepareCkycFetch,
  prepareCkycCreate,
};
