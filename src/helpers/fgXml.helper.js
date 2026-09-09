import { create } from 'xmlbuilder2';

import config from '../config/env.js';
import {
  METHOD, PRODUCTS, MEMBER_SHAPE, HEIGHT_CM, WEIGHT_KG, BMI_PLAUSIBLE,
} from '../constants/fg.constants.js';
import { requireFields, isDdMmYyyy, assert } from './fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The <Root> business payload that goes, as CDATA, inside the SOAP <tem:XML>
// element of every BO-service call.
//
// ⚠️ THIS FILE IS A TRANSCRIPTION, NOT A DESIGN. The element ORDER, the element
// NAMES and the decision to emit an empty tag rather than omit it are all
// reproduced from the TCS kit's own sample XML and from the working NovaCred
// implementation that FG have accepted on UAT. That includes FG's own
// misspellings — `AptRelWithominee` really is missing its N on the Health Total
// samples, and a "corrected" tag is simply an element FG's service does not
// know. Nothing here may be tidied, reordered or "cleaned up" without a
// verified FG response proving the new form is accepted.
//
// Empty optional elements are emitted as empty tags on purpose: the samples do,
// and FG's parser is positional enough that dropping a field it expects is not
// the same as sending it blank.
//
// Built with xmlbuilder2 — the same library the working implementation uses —
// for safe escaping and stable ordering, rather than string concatenation.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} p
 * @param {'ENQ'|'CRT'} p.method
 * @param {object} p.productDef  one of constants.PRODUCTS.*
 * @param {object} p.policy      policy header fields
 * @param {object} p.client      proposer / client
 * @param {object} [p.receipt]   payment receipt; `amount` matters on ANY CRT
 *                               call, proposal validation included
 * @param {object} p.risk        risk + members
 * @returns {string} serialized <Root> XML
 */
function buildRootXml(p) {
  const fg = config.fg;
  const { method, productDef, policy = {}, client = {}, receipt = {}, risk = {} } = p;

  validateCommon(p);

  const root = create({ version: '1.0' }).ele('Root');

  root.ele('Uid').txt(policy.uid || genUid()).up();
  root.ele('VendorCode').txt(fg.vendorCode || '').up();
  root.ele('VendorUserId').txt(fg.vendorUserId || '').up();
  root.ele('SentToOutSourcePrint').txt(method === METHOD.CREATE ? '0' : '').up();
  root.ele('WinNo').txt(policy.winNo || '').up();
  root.ele('ApplicationNo').txt(policy.applicationNo || '').up();

  // --- PolicyHeader ---------------------------------------------------------
  const ph = root.ele('PolicyHeader');
  ph.ele('PolicyStartDate').txt(policy.startDate).up();
  ph.ele('PolicyEndDate').txt(policy.endDate).up();
  ph.ele('AgentCode').txt(policy.agentCode || fg.agentCode || '').up();
  ph.ele('BranchCode').txt(policy.branchCode || fg.branchCode || '').up();
  ph.ele('MajorClass').txt(productDef.majorClass).up();
  ph.ele('ContractType').txt(productDef.contractType).up();
  ph.ele('METHOD').txt(method).up();
  ph.ele('PolicyIssueType').txt(policy.issueType || 'I').up();
  ph.ele('PolicyNo').txt(policy.policyNo || '').up();
  ph.ele('ClientID').txt(policy.clientId || '').up();
  ph.ele('ReceiptNo').txt(policy.receiptNo || '').up();
  ph.up();

  // --- POS_MISP -------------------------------------------------------------
  const pos = root.ele('POS_MISP');
  pos.ele('Type').txt(p.posMisp?.type || '').up();
  pos.ele('PanNo').txt(p.posMisp?.panNo || '').up();
  pos.up();

  // --- Client ---------------------------------------------------------------
  const c = root.ele('Client');
  c.ele('ClientCategory').txt(client.category || '').up();
  c.ele('ClientType').txt(client.type || 'I').up();
  c.ele('CreationType').txt(client.creationType || 'C').up();
  c.ele('Salutation').txt(client.salutation || '').up();
  c.ele('FirstName').txt(client.firstName || '').up();
  c.ele('LastName').txt(client.lastName || '').up();
  c.ele('DOB').txt(client.dob).up();
  c.ele('Gender').txt(client.gender || '').up();
  c.ele('MaritalStatus').txt(client.maritalStatus || '').up();
  c.ele('Occupation').txt(client.occupation || '').up();
  c.ele('PANNo').txt(client.pan || '').up();
  c.ele('GSTIN').txt(client.gstin || '').up();
  c.ele('AadharNo').txt(client.aadharNo || '').up();
  c.ele('CKYCNo').txt(client.ckycNo || '').up();
  c.ele('CKYCRefNo').txt(client.ckycRefNo || '').up();
  c.ele('EIANo').txt(client.eiaNo || '').up();
  // Newer Client elements. Absent from the kit's Postman samples but present in
  // the issuance payload FG supplied in August 2026, in this position and with
  // this spelling. Emitted empty by default like every other optional element
  // here: FG accept payloads both with and without them, so sending them costs
  // nothing and matches their current reference.
  c.ele('DarpanID').txt(client.darpanId || '').up();
  c.ele('HasDisability').txt(client.hasDisability || 'False').up();
  c.ele('DisabilityRemarks').txt(client.disabilityRemarks || '').up();
  c.ele('UDIDNumber').txt(client.udidNumber || '').up();
  c.ele('PercentageOfDisability').txt(client.percentageOfDisability || '').up();
  buildAddress(c, 'Address1', client.address1, 'R');
  buildAddress(c, 'Address2', client.address2 || client.address1, 'P');
  c.ele('VIPFlag').txt(client.vipFlag || 'N').up();
  c.ele('VIPCategory').txt(client.vipCategory || '').up();
  c.up();

  // --- Receipt (payment) ----------------------------------------------------
  const r = root.ele('Receipt');
  r.ele('UniqueTranKey').txt(receipt.uniqueTranKey || '').up();
  r.ele('CheckType').txt(receipt.checkType || '').up();
  r.ele('BSBCode').txt(receipt.bsbCode || '').up();
  r.ele('TransactionDate').txt(receipt.transactionDate || '').up();
  r.ele('ReceiptType').txt(receipt.receiptType || 'IVR').up();
  // Required on every CRT call, not just issuance — see validateCommon.
  r.ele('Amount').txt(receipt.amount != null ? String(receipt.amount) : '').up();
  r.ele('TCSAmount').txt(receipt.tcsAmount || '').up();
  r.ele('TranRefNo').txt(receipt.tranRefNo || '').up();
  r.ele('TranRefNoDate').txt(receipt.tranRefNoDate || '').up();
  r.up();

  // --- Risk -----------------------------------------------------------------
  const rk = root.ele('Risk');
  rk.ele('eNach').txt(risk.eNach || 'N').up();
  rk.ele('PolicyType').txt(risk.policyType || productDef.defaultPolicyType).up();
  rk.ele('Duration').txt(String(risk.duration || 1)).up();
  rk.ele('Installments').txt(risk.installments || 'FULL').up();
  rk.ele('PaymentType').txt(risk.paymentType || 'CC').up();
  rk.ele('IsFgEmployee').txt(risk.isFgEmployee || 'N').up();
  rk.ele('BranchReferenceID').txt(risk.branchReferenceId || '').up();
  rk.ele('FGBankBranchStaffID').txt(risk.fgBankBranchStaffId || '').up();
  rk.ele('BankStaffID').txt(risk.bankStaffId || '').up();
  rk.ele('BankCustomerID').txt(risk.bankCustomerId || '').up();
  rk.ele('BancaChannel').txt(risk.bancaChannel || config.fg.bancaChannel || '').up();
  rk.ele('PartnerRefNo').txt(risk.partnerRefNo || '').up();
  rk.ele('PayorID').txt(risk.payorId || '').up();
  rk.ele('PayerName').txt(risk.payerName || '').up();

  const bd = rk.ele('BeneficiaryDetails');
  assert(Array.isArray(risk.members) && risk.members.length > 0,
    'At least one risk.members[] entry is required', { field: 'risk.members' });
  risk.members.forEach((m, idx) => buildMember(bd, m, idx + 1, method, productDef));
  bd.up();
  rk.up();

  return root.end({ prettyPrint: false, headless: true });
}

function buildAddress(parent, tag, addr = {}, defaultType) {
  const a = parent.ele(tag);
  a.ele('AddrLine1').txt(addr.line1 || '').up();
  a.ele('AddrLine2').txt(addr.line2 || '').up();
  a.ele('AddrLine3').txt(addr.line3 || '').up();
  a.ele('Landmark').txt(addr.landmark || '').up();
  a.ele('Pincode').txt(addr.pincode || '').up();
  a.ele('City').txt(addr.city || '').up();
  a.ele('State').txt(addr.state || '').up();
  a.ele('Country').txt(addr.country || 'IND').up();
  a.ele('AddressType').txt(addr.addressType || defaultType).up();
  a.ele('HomeTelNo').txt(addr.homeTelNo || '').up();
  a.ele('OfficeTelNo').txt(addr.officeTelNo || '').up();
  a.ele('FAXNO').txt(addr.faxNo || '').up();
  a.ele('MobileNo').txt(addr.mobileNo || '').up();
  a.ele('EmailAddr').txt(addr.email || '').up();
  a.up();
}

// ── Height / Weight, and the BMI FG derive from them ────────────────────────
//
// There is no BMI element on the wire. FG compute it from <Height> and
// <Weight> and reject the proposal with "BMI is Invalid for Member N" when they
// cannot — an error naming a quantity never sent, about two fields that WERE
// sent, empty. Checking here turns that into a message naming the member the
// way FG number them.

/**
 * Read one supplied measurement, distinguishing "not given" from "given but not
 * a number". They have different causes and different fixes, and reporting a
 * height of "tall" as a missing field sends you looking in the wrong place.
 */
function readMetric(raw, name, at, memberNo, unit) {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    return { given: false, value: null };
  }
  const parsed = Number(raw);
  assert(Number.isFinite(parsed),
    `${at}: ${name} must be a number in ${unit} — got ${JSON.stringify(raw)}.`,
    { field: `risk.members[${memberNo - 1}].${name}`, memberNo, got: raw, expects: unit });
  return { given: true, value: parsed };
}

/**
 * Enforced on CRT (proposal + issuance), where FG validate and where the
 * failure was observed. On ENQ the values are checked only if supplied: a quote
 * is priced before the medical detail is necessarily collected, and turning an
 * absent height into a hard failure there would break quoting to fix proposals.
 * Their absence is logged, because a quote FG priced without them is a quote
 * whose proposal is about to be rejected.
 */
function resolveBodyMetrics(m, memberNo, method) {
  const at = `risk.members[${memberNo - 1}] (FG "Member ${memberNo}")`;
  const h = readMetric(m.height, 'height', at, memberNo, 'centimetres');
  const w = readMetric(m.weight, 'weight', at, memberNo, 'kilograms');
  const height = h.value;
  const weight = w.value;

  if (!h.given || !w.given) {
    const absent = [!h.given && 'height', !w.given && 'weight'].filter(Boolean);
    if (method === METHOD.CREATE) {
      assert(false,
        `${at}: ${absent.join(' and ')} ${absent.length > 1 ? 'are' : 'is'} required. Future `
        + 'Generali derive BMI from Height (cm) and Weight (kg) and report their absence as '
        + `"BMI is Invalid for Member ${memberNo}".`,
        {
          field: `risk.members[${memberNo - 1}].${absent[0]}`,
          fields: absent.map((f) => `risk.members[${memberNo - 1}].${f}`),
          memberNo, height: m.height, weight: m.weight,
        });
    }
    console.warn(
      `⚠️  FG member ${memberNo} has no ${absent.join('/')} — this quote will price, but the `
      + 'proposal built from it will be rejected as "BMI is Invalid".'
    );
    return { height, weight };
  }

  assert(height >= HEIGHT_CM.min && height <= HEIGHT_CM.max,
    `${at}: height ${height} is outside ${HEIGHT_CM.min}-${HEIGHT_CM.max}. Future Generali `
    + 'expect CENTIMETRES (their sample sends 154) — a value near 1.7 is metres and near 5.7 '
    + 'is feet.',
    { field: `risk.members[${memberNo - 1}].height`, memberNo, got: height, expects: 'cm' });

  assert(weight >= WEIGHT_KG.min && weight <= WEIGHT_KG.max,
    `${at}: weight ${weight} is outside ${WEIGHT_KG.min}-${WEIGHT_KG.max}. Future Generali `
    + 'expect KILOGRAMS (their sample sends 55).',
    { field: `risk.members[${memberNo - 1}].weight`, memberNo, got: weight, expects: 'kg' });

  // Each value plausible on its own, the pair impossible together.
  const bmi = weight / ((height / 100) ** 2);
  assert(bmi >= BMI_PLAUSIBLE.min && bmi <= BMI_PLAUSIBLE.max,
    `${at}: height ${height}cm with weight ${weight}kg gives a BMI of ${bmi.toFixed(1)}, which `
    + `Future Generali will reject as "BMI is Invalid for Member ${memberNo}". Check the units `
    + 'on both values.',
    {
      field: `risk.members[${memberNo - 1}]`,
      memberNo, height, weight, bmi: Number(bmi.toFixed(1)),
    });

  return { height, weight };
}

/**
 * Each product has its own <Member> layout — see MEMBER_SHAPE. Sending one
 * product's member block for another is not a partial payload FG complete with
 * defaults; it is a block whose elements FG do not recognise, answered with the
 * empty *Result that reads as a provisioning problem.
 */
function buildMember(parent, m, memberId, method, productDef) {
  const mem = parent.ele('Member');
  const memberNo = Number(m.memberId || memberId);
  const { height, weight } = resolveBodyMetrics(m, memberNo, method);

  switch (productDef.memberShape) {
    case MEMBER_SHAPE.HEALTH_TOTAL:
      buildHealthTotalMember(mem, m, memberId, height, weight);
      break;
    case MEMBER_SHAPE.HEALTH_ABSOLUTE:
      buildHealthAbsoluteMember(mem, m, memberId, height, weight);
      break;
    case MEMBER_SHAPE.ADVANTAGE_TOP_UP:
      buildAdvantageTopUpMember(mem, m, memberId, memberNo, height, weight);
      break;
    default:
      assert(false, `No <Member> layout defined for product "${productDef.key}"`,
        { field: 'productDef.memberShape', got: productDef.memberShape });
  }

  mem.up();
}

/**
 * MemberId … AptRel*, shared by Health Total and Health Absolute. The two differ
 * only in how the kit spells the appointee-relationship tag, so it is passed in:
 * the Health Total samples write `AptRelWithominee` (missing the N), the Health
 * Absolute ones write `AptRelWithNominee`. Both are reproduced AS FOUND.
 */
function buildSharedMemberHead(mem, m, memberId, height, weight, aptRelTag) {
  mem.ele('MemberId').txt(String(m.memberId || memberId)).up();
  mem.ele('AbhaNo').txt(m.abhaNo || '').up();
  mem.ele('InsuredName').txt(m.insuredName || '').up();
  mem.ele('InsuredDob').txt(m.insuredDob).up();
  mem.ele('InsuredGender').txt(m.insuredGender || '').up();
  mem.ele('InsuredOccpn').txt(m.insuredOccupation || '').up();
  mem.ele('CoverType').txt(m.coverType || '').up();
  mem.ele('SumInsured').txt(String(m.sumInsured)).up();
  mem.ele('DeductibleDiscount').txt(String(m.deductibleDiscount ?? 0)).up();
  mem.ele('Relation').txt(m.relation || 'SELF').up();
  mem.ele('NomineeName').txt(m.nomineeName || '').up();
  mem.ele('NomineeRelation').txt(m.nomineeRelation || '').up();
  mem.ele('AnualIncome').txt(m.annualIncome != null ? String(m.annualIncome) : '').up();
  // Validated above — cm and kg. Still emitted as empty tags when a quote (ENQ)
  // legitimately has neither, so the element order on the wire never changes.
  mem.ele('Height').txt(height != null ? String(height) : '').up();
  mem.ele('Weight').txt(weight != null ? String(weight) : '').up();
  mem.ele('NomineeAge').txt(m.nomineeAge != null ? String(m.nomineeAge) : '').up();
  mem.ele('AppointeeName').txt(m.appointeeName || '').up();
  mem.ele(aptRelTag).txt(m.appointeeRelation || '').up();
}

/** Health Total (HTO): shared head + medical-history tail. */
function buildHealthTotalMember(mem, m, memberId, height, weight) {
  buildSharedMemberHead(mem, m, memberId, height, weight, 'AptRelWithominee');
  mem.ele('MedicalLoading').txt(String(m.medicalLoading ?? 0)).up();
  mem.ele('PreExstDisease').txt(m.preExistingDisease || 'N').up();

  const dl = mem.ele('DiseaseMedicalHistoryList');
  const diseases = Array.isArray(m.diseases) && m.diseases.length
    ? m.diseases
    : [{ code: '', detail: '' }];
  diseases.forEach((d) => {
    const dh = dl.ele('DiseaseMedicalHistory');
    dh.ele('PreExistingDiseaseCode').txt(d.code || '').up();
    dh.ele('MedicalHistoryDetail').txt(d.detail || '').up();
    dh.up();
  });
  dl.up();
}

/**
 * Health Absolute (FHA): shared head + lifestyle/health declarations. Carries
 * no MedicalLoading, PreExstDisease or DiseaseMedicalHistoryList.
 *
 * <NomineeDetails> is emitted only when the caller supplies `member.nominees`.
 * The kit disagrees with itself here: "FHA Revised XML.txt" and the Sample XML
 * files end the member at <AdditionalInformation/>, while the older Postman
 * collection nests a full NomineeDetails/Nominee/Appointee block. The revised
 * samples win by default; a caller with the richer nominee data can still send
 * it.
 */
function buildHealthAbsoluteMember(mem, m, memberId, height, weight) {
  buildSharedMemberHead(mem, m, memberId, height, weight, 'AptRelWithNominee');
  mem.ele('Smoking').txt(m.smoking || 'N').up();
  mem.ele('Tobacco').txt(m.tobacco || 'N').up();
  mem.ele('IsGoodHealth').txt(m.isGoodHealth || 'Y').up();
  mem.ele('IsExistingAbsolutePolicy').txt(m.isExistingAbsolutePolicy || 'N').up();
  mem.ele('AdditionalInformation').txt(m.additionalInformation || '').up();

  if (Array.isArray(m.nominees) && m.nominees.length) {
    buildNomineeDetails(mem, m.nominees);
  }
}

/**
 * Future Advantage Top Up (FAT): its own order, not the shared head. A top-up is
 * priced off <Deductible> and <Plantype>, which no other product carries; it has
 * no CoverType, AnualIncome, PreExstDisease or medical-history list.
 */
function buildAdvantageTopUpMember(mem, m, memberId, memberNo, height, weight) {
  const absent = [
    (m.deductible === undefined || m.deductible === null || m.deductible === '') && 'deductible',
    !m.planType && 'planType',
  ].filter(Boolean);
  if (absent.length) {
    // Not a hard failure: no FG error message has been observed for these, so
    // refusing here would be our rule, not theirs. Logged because a top-up
    // without a deductible is not a priceable risk.
    console.warn(
      `⚠️  FG top-up member ${memberNo} is missing ${absent.join(' and ')} — Future Generali `
      + 'are unlikely to price it.'
    );
  }

  mem.ele('MemberId').txt(String(m.memberId || memberId)).up();
  mem.ele('AbhaNo').txt(m.abhaNo || '').up();
  mem.ele('InsuredName').txt(m.insuredName || '').up();
  mem.ele('InsuredDob').txt(m.insuredDob).up();
  mem.ele('InsuredGender').txt(m.insuredGender || '').up();
  mem.ele('InsuredOccpn').txt(m.insuredOccupation || '').up();
  mem.ele('SumInsured').txt(String(m.sumInsured)).up();
  mem.ele('Deductible').txt(m.deductible != null ? String(m.deductible) : '').up();
  mem.ele('Plantype').txt(m.planType || '').up();
  mem.ele('DeductibleDiscount').txt(m.deductibleDiscount != null ? String(m.deductibleDiscount) : '').up();
  mem.ele('Relation').txt(m.relation || 'SELF').up();
  mem.ele('NomineeName').txt(m.nomineeName || '').up();
  mem.ele('NomineeRelation').txt(m.nomineeRelation || '').up();
  mem.ele('NomineeAge').txt(m.nomineeAge != null ? String(m.nomineeAge) : '').up();
  mem.ele('Height').txt(height != null ? String(height) : '').up();
  mem.ele('Weight').txt(weight != null ? String(weight) : '').up();
  mem.ele('AppointeeName').txt(m.appointeeName || '').up();
  mem.ele('AptRelWithNominee').txt(m.appointeeRelation || '').up();
  mem.ele('MedicalLoading').txt(m.medicalLoading != null ? String(m.medicalLoading) : '').up();
}

/** <NomineeDetails> — Health Absolute's structured nominee/appointee block. */
function buildNomineeDetails(mem, nominees) {
  const nd = mem.ele('NomineeDetails');
  nominees.forEach((n, idx) => {
    const nm = nd.ele('Nominee');
    nm.ele('NomineeID').txt(String(n.id ?? idx + 1)).up();
    nm.ele('NomineeName').txt(n.name || '').up();
    nm.ele('NomineeGender').txt(n.gender || '').up();
    nm.ele('NomineeDOB').txt(n.dob || '').up();
    nm.ele('NomineeAge').txt(n.age != null ? String(n.age) : '').up();
    nm.ele('NomineeMobileNo').txt(n.mobileNo || '').up();
    nm.ele('NomineeEmailID').txt(n.email || '').up();
    nm.ele('NomineePresentAddress').txt(n.presentAddress || '').up();
    nm.ele('NomineePermanentAddress').txt(n.permanentAddress || '').up();
    nm.ele('NomineeRelationshipWithProposer').txt(n.relationship || '').up();
    nm.ele('NomineePercentage').txt(String(n.percentage ?? 0)).up();
    nm.ele('NomineeAccountNo').txt(n.accountNo || '').up();
    nm.ele('NomineeIFSCMICRCode').txt(n.ifscOrMicrCode || '').up();
    nm.ele('NomineeBankName').txt(n.bankName || '').up();
    nm.ele('NomineeBankAccountHolderName').txt(n.bankAccountHolderName || '').up();
    buildAppointee(nm, n.appointee || {}, idx + 1);
    nm.up();
  });
  nd.up();
}

function buildAppointee(parent, a, defaultId) {
  const ap = parent.ele('Appointee');
  ap.ele('AppointeeID').txt(String(a.id ?? defaultId)).up();
  ap.ele('AppointeeName').txt(a.name || '').up();
  ap.ele('AppointeeGender').txt(a.gender || '').up();
  ap.ele('AppointeeDOB').txt(a.dob || '').up();
  ap.ele('AppointeeAge').txt(a.age != null ? String(a.age) : '').up();
  ap.ele('AppointeeMobileNo').txt(a.mobileNo || '').up();
  ap.ele('AppointeeEmailID').txt(a.email || '').up();
  ap.ele('AppointeePresentAddress').txt(a.presentAddress || '').up();
  ap.ele('AppointeePermanentAddress').txt(a.permanentAddress || '').up();
  ap.ele('AppointeeRelationshipWithProposer').txt(a.relationship || '').up();
  ap.ele('AppointeePercentage').txt(a.percentage != null ? String(a.percentage) : '').up();
  ap.ele('AppointeeAccountNo').txt(a.accountNo || '').up();
  ap.ele('AppointeeIFSCMICRCode').txt(a.ifscOrMicrCode || '').up();
  ap.ele('AppointeeBankName').txt(a.bankName || '').up();
  ap.ele('AppointeeBankAccountHolderName').txt(a.bankAccountHolderName || '').up();
  ap.up();
}

function validateCommon(p) {
  assert(p.productDef && PRODUCTS[p.productDef.key],
    'Unknown or missing FG product definition', { field: 'product' });
  assert(p.method === METHOD.ENQUIRY || p.method === METHOD.CREATE,
    'method must be ENQ or CRT', { field: 'method', got: p.method });

  requireFields(p, ['policy.startDate', 'policy.endDate', 'client.dob'], 'the FG payload');
  assert(isDdMmYyyy(p.policy.startDate),
    'policy.startDate must be dd/mm/yyyy', { field: 'policy.startDate', got: p.policy.startDate });
  assert(isDdMmYyyy(p.policy.endDate),
    'policy.endDate must be dd/mm/yyyy', { field: 'policy.endDate', got: p.policy.endDate });
  assert(isDdMmYyyy(p.client.dob),
    'client.dob must be dd/mm/yyyy', { field: 'client.dob', got: p.client.dob });

  // ── Per-member: the two values FG PRICE from ──────────────────────────────
  //
  // Checked on ENQ as well as CRT, unlike height and weight. Those are medical
  // detail a quote can legitimately precede; these two ARE the quote — FG derive
  // <Age> from InsuredDob and rate against SumInsured — so a request missing
  // either is not an early quote, it is a broken one.
  //
  // Both failure modes were live before this check:
  //   * an absent sumInsured reached FG as the literal text
  //     <SumInsured>undefined</SumInsured>, because String(undefined) is
  //     "undefined" — answered with the reasonless empty *Result;
  //   * an ISO or US-ordered date passed straight through, and FG read
  //     06/09/1992 and 1992-09-06 as different people's ages without
  //     complaining about either.
  (Array.isArray(p.risk?.members) ? p.risk.members : []).forEach((m, index) => {
    const at = `risk.members[${index}] (FG "Member ${index + 1}")`;

    assert(!isEmptyValue(m.insuredDob),
      `${at}: insuredDob is required — Future Generali derive the member's age from it.`,
      { field: `risk.members[${index}].insuredDob` });
    assert(isDdMmYyyy(m.insuredDob),
      `${at}: insuredDob must be dd/mm/yyyy — got ${JSON.stringify(m.insuredDob)}. Future `
      + 'Generali accept a wrongly-ordered date without complaint and rate a different age from it.',
      { field: `risk.members[${index}].insuredDob`, got: m.insuredDob });

    assert(!isEmptyValue(m.sumInsured),
      `${at}: sumInsured is required — it is what Future Generali rate against.`,
      { field: `risk.members[${index}].sumInsured` });
    assert(Number.isFinite(Number(m.sumInsured)) && Number(m.sumInsured) > 0,
      `${at}: sumInsured must be a positive number — got ${JSON.stringify(m.sumInsured)}.`,
      { field: `risk.members[${index}].sumInsured`, got: m.sumInsured });
  });

  if (p.method === METHOD.CREATE) {
    // <Receipt><Amount> is NOT issuance-only, whatever the kit says.
    //
    // Verified on UAT 2026-08-17 by a six-call matrix, interleaved so FG's
    // intermittency could not fake the result: a CRT call that reaches their
    // receipt check with <Amount> empty is answered "Fail_Ex" (3/3), and the
    // same request carrying the premium returns Status Success (3/3).
    // <UniqueTranKey> and <TransactionDate> make no difference either way.
    //
    // It reads as a <ClientID> fault and is not one: with <ClientID> empty FG
    // answer the client handshake first, so the request never reaches the
    // receipt check, and the amount only appears to matter once a ClientID is
    // supplied.
    //
    // Warned, not thrown: issuance already requires it in the service, and
    // refusing here would turn a recoverable proposal into an exception for
    // callers that legitimately have no premium yet. But a CRT without it is a
    // call about to come back with a token that explains nothing, so it must
    // not pass silently.
    const amount = p.receipt?.amount;
    if (amount == null || amount === '') {
      console.warn(
        '⚠️  FG CRT call has no receipt.amount — Future Generali answer an empty <Amount> with '
        + '"Fail_Ex", which names nothing. Pass the quoted premium.'
      );
    }
  }
}

function isEmptyValue(value) {
  return value === undefined || value === null
    || (typeof value === 'string' && value.trim() === '');
}

/** FG's samples use a numeric Uid; a time-based one is generated when absent. */
function genUid() {
  return `${Date.now()}${Math.floor(Math.random() * 1000)}`;
}

export { buildRootXml, genUid };
