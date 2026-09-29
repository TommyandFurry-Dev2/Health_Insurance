import crypto from 'node:crypto';
import axios from 'axios';
import config from '../config/env.js';
import db from '../db/index.js';
import { encryptKycPayload, decryptKycPayload } from '../helpers/nivabupaKycCrypto.helper.js';
import * as kycRepo from '../repositories/nivabupaKyc.repository.js';
import * as logRepo from '../repositories/log.repository.js';

// NivaBupa KYC — the two flows from NivaBupa's "KYC APIs Integration Document"
// (kyc), both authenticated the same way (PartnerName header + GenerateTokenEnc)
// and both ending in one VERIFIED row of nivabupa_kyc_requests:
//
//   GenerateTokenEnc     → access_token
//
//   ── hosted (the one the SPA uses) ──
//   RedirectionLinkEnc   → a link to NivaBupa's OWN KYC page for this buyer
//   GetKycStatusEnc      → what that page ended in, polled afterwards
//
//   ── OTP, in this service (kept as the fallback) ──
//   EKYCOTPDetailEnc → OTP to the mobile registered on the PAN's CKYC record
//   EKYCDetailEnc    → the CKYC record, once NivaBupa has verified the OTP
//   ReSendOTPEnc     → the same OTP request again
//
// WHY the hosted page is preferred: NivaBupa's page runs whatever verification
// that customer can actually pass — CKYC, digital Aadhaar, OVD upload, PAN +
// Form 60 — while EKYCOTPDetailEnc can only do one: an OTP to the mobile
// registered against the PAN in the CKYC registry. A buyer whose CKYC record
// holds an old number, or who has no CKYC record at all, cannot finish the OTP
// flow at all, and that is a large share of first-time buyers.
//
// Every request and response body is { payload: <AES-encrypted JSON> } — see
// helpers/nivabupaKycCrypto.helper.js.

// The KYC reference travels to /uw-decision and /datapush in a header, not in
// the body: those bodies are forwarded to NivaBupa verbatim.
const KYC_REQUEST_ID_HEADER = 'x-nivabupa-kyc-request-id';

const REQUIRED_VARIABLES = [
  ['NIVABUPA_KYC_BASE_URL', () => config.nivabupa.kyc.baseUrl],
  ['NIVABUPA_KYC_PARTNER_NAME', () => config.nivabupa.kyc.partnerName],
  ['NIVABUPA_KYC_USERNAME', () => config.nivabupa.kyc.username],
  ['NIVABUPA_KYC_PASSWORD', () => config.nivabupa.kyc.password],
  ['NIVABUPA_KYC_ENCRYPTION_KEY', () => config.nivabupa.kyc.encryptionKey],
];

function missingKycVariables() {
  return REQUIRED_VARIABLES.filter(([, read]) => !read()).map(([name]) => name);
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function text(value) {
  return isBlank(value) ? '' : String(value).trim();
}

function isSuccess(response) {
  return text(response?.Status).toLowerCase() === 'success';
}

// ── Transport ───────────────────────────────────────────────────────────────

async function postEncrypted(operation, body, token) {
  const { baseUrl, partnerName, encryptionKey, timeoutMs } = config.nivabupa.kyc;
  const url = `${baseUrl}/${operation}`;
  const headers = { PartnerName: partnerName, 'Content-Type': 'application/json' };
  // Spelled exactly as NivaBupa's document and Postman collection spell it, and
  // sent as the bare token, as their collection sends it.
  if (token) headers.AthorizationToken = token;

  const response = await axios.post(
    url,
    { payload: encryptKycPayload(JSON.stringify(body), encryptionKey) },
    { headers, timeout: timeoutMs }
  );

  const cipherText = response.data?.payload ?? response.data?.Payload;
  if (typeof cipherText !== 'string' || !cipherText) {
    const error = new Error(`NivaBupa KYC ${operation} answered without an encrypted payload`);
    error.response = response;
    throw error;
  }
  return { httpStatus: response.status, data: JSON.parse(decryptKycPayload(cipherText, encryptionKey)) };
}

// Every upstream KYC call lands in nivabupa_api_transactions, correlated on the
// KYC reference. forAudit (inside recordApiTransaction) redacts Password and
// access_token; the OTP is masked before it gets there.
async function audit({ apiName, url, startedAt, journeyId, correlationId, requestPayload, result, error }) {
  await logRepo.recordApiTransaction({
    journeyId,
    apiName,
    journeyStep: 'KYC',
    endpointUrl: url,
    httpStatus: result?.httpStatus || error?.response?.status || null,
    durationMs: Date.now() - startedAt,
    status: error ? 'FAILED' : 'SUCCESS',
    requestPayload,
    responsePayload: result?.data ?? error?.response?.data ?? null,
    errorMessage: error?.message,
    correlationId,
  });
}

async function auditedPost(operation, apiName, body, token, { journeyId, correlationId, auditBody } = {}) {
  const url = `${config.nivabupa.kyc.baseUrl}/${operation}`;
  const startedAt = Date.now();
  const requestPayload = auditBody || body;
  try {
    const result = await postEncrypted(operation, body, token);
    await audit({ apiName, url, startedAt, journeyId, correlationId, requestPayload, result });
    return result.data;
  } catch (error) {
    await audit({ apiName, url, startedAt, journeyId, correlationId, requestPayload, error });
    throw error;
  }
}

// GenerateTokenEnc answers `expires_in: 0`, so there is no lifetime to cache a
// token against. A fresh one is fetched for each KYC operation instead of
// guessing one.
async function generateTokenEnc(context) {
  const { username, password } = config.nivabupa.kyc;
  const data = await auditedPost('GenerateTokenEnc', 'KYC_TOKEN', { Username: username, Password: password }, null, context);
  if (!data?.access_token || String(data?.Status) !== '200') {
    throw new Error(`NivaBupa KYC token rejected: ${data?.Message || 'no access_token in response'}`);
  }
  return data.access_token;
}

async function callKyc(operation, apiName, body, context = {}) {
  const token = await generateTokenEnc(context);
  return auditedPost(operation, apiName, body, token, context);
}

// ── OTP flow ────────────────────────────────────────────────────────────────

// Numeric, like NivaBupa's own identifiers. Date.now() plus two random digits
// keeps two attempts started in the same millisecond apart.
function newKycReferenceId() {
  return `${Date.now()}${crypto.randomInt(10, 100)}`;
}

// The same 12-digit shape the frontend has always generated SOURCING_APPNO in.
// This number becomes the proposal's SOURCING_APPNO, so KYC, underwriting,
// payment and Data Push all carry one application number.
function newApplicationNo() {
  return String(Date.now()).slice(-12);
}

const PAN_PATTERN = /^[A-Z]{5}\d{4}[A-Z]$/;
const MOBILE_PATTERN = /^\d{10}$/;
const OTP_PATTERN = /^\d{4,8}$/;
const APPLICATION_NO_PATTERN = /^[A-Za-z0-9-]{1,40}$/;

// EKYCOTPDetailEnc takes exactly Pan and MobileNumber — both required.
function validateOtpRequest(input = {}) {
  const errors = [];
  if (!PAN_PATTERN.test(text(input.pan).toUpperCase())) errors.push('A valid PAN is required.');
  if (!MOBILE_PATTERN.test(text(input.mobile))) errors.push('A valid 10-digit mobile number is required.');
  if (text(input.applicationNo) && !APPLICATION_NO_PATTERN.test(text(input.applicationNo))) {
    errors.push('applicationNo is not valid.');
  }
  return errors;
}

function isValidOtp(otp) {
  return OTP_PATTERN.test(text(otp));
}

function ekycOtpDetailEnc({ pan, mobile }, context) {
  return callKyc('EKYCOTPDetailEnc', 'KYC_OTP_SEND', {
    Pan: text(pan).toUpperCase(),
    MobileNumber: text(mobile),
  }, context);
}

// Sent means Success AND both identifiers the OTP is later verified against.
function isOtpSent(response) {
  return isSuccess(response) && !isBlank(response?.CYCRequestId) && !isBlank(response?.CKYCTransactionID);
}

function reSendOtpEnc({ requestId, transactionId }, context) {
  return callKyc('ReSendOTPEnc', 'KYC_OTP_RESEND', {
    CYCRequestId: requestId,
    CKYCTransactionID: transactionId,
  }, context);
}

function ekycDetailEnc({ requestId, transactionId, otp }, context) {
  const body = { CYCRequestId: requestId, CKYCTransactionID: transactionId, OtpData: text(otp) };
  return callKyc('EKYCDetailEnc', 'KYC_OTP_VERIFY', body, { ...context, auditBody: { ...body, OtpData: '***' } });
}

// Verified means NivaBupa answered Success AND returned the CKYC record's
// identifier (CKYCID) — the record is only downloaded once the OTP checks out.
function isKycVerified(response) {
  return isSuccess(response) && !isBlank(response?.CKYCID);
}

function kycMessage(response) {
  return text(response?.CKYCSuccessDescription) || text(response?.Remarks) || text(response?.message) || null;
}

// ── Hosted KYC: NivaBupa's own KYC page ─────────────────────────────────────

// Sent as PartnerRequestId. NivaBupa key the KYC record on it, and answer a
// repeat with "Duplicate Request" AND the same link — so one id per attempt,
// reused deliberately, is what makes a second "Verify KYC" click return the
// buyer to the page they were already on instead of opening a second record.
function newPartnerRequestId() {
  return `TF${Date.now()}${crypto.randomInt(10, 100)}`;
}

// NivaBupa want dd/mm/yyyy. The SPA sends what <input type="date"> produces
// (yyyy-mm-dd); a value already in their format passes through unchanged.
function toKycDate(value) {
  const raw = text(value);
  if (!raw) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  const dmy = /^(\d{2})[/-](\d{2})[/-](\d{4})$/.exec(raw);
  if (dmy) return `${dmy[1]}/${dmy[2]}/${dmy[3]}`;
  return raw;
}

// 'M' / 'male' / 'MALE' all reach NivaBupa as 'Male'. Anything else is passed
// through rather than guessed at.
function toKycGender(value) {
  const raw = text(value).toLowerCase();
  if (raw === 'm' || raw === 'male') return 'Male';
  if (raw === 'f' || raw === 'female') return 'Female';
  if (raw === 'o' || raw === 'other' || raw === 'transgender') return 'Other';
  return text(value);
}

// One name field split the way NivaBupa's payload wants it. A single-word name
// becomes the first name with no last name — their page asks for the rest.
function splitName(input) {
  const first = text(input.firstName);
  const last = text(input.lastName);
  if (first || last) return { firstName: first, lastName: last };
  const parts = text(input.fullName).split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The fields NivaBupa reject the request without. Verified against UAT rather
// than read off the document: RedirectionLinkEnc answers statusCode 400 with
// "<field> field is Mandatory" one field at a time, and address, pincode, state
// and salutation are NOT among them (their page collects the address itself).
// City is mandatory on NivaBupa's word rather than UAT's — checked here so a
// missing one is named to the buyer instead of coming back as their 400.
function validateRedirectRequest(input = {}) {
  const errors = [];
  const { firstName, lastName } = splitName(input);
  if (!firstName) errors.push('A name is required.');
  if (!lastName) errors.push('A last name is required — Niva Bupa need the full name for KYC.');
  if (!PAN_PATTERN.test(text(input.pan).toUpperCase())) errors.push('A valid PAN is required.');
  if (!MOBILE_PATTERN.test(text(input.mobile))) errors.push('A valid 10-digit mobile number is required.');
  if (!EMAIL_PATTERN.test(text(input.email))) errors.push('A valid email address is required.');
  if (!text(input.city)) errors.push('City is required — Niva Bupa need it for KYC.');
  if (!toKycDate(input.dob)) errors.push('Date of birth is required.');
  if (!toKycGender(input.gender)) errors.push('Gender is required.');
  if (text(input.applicationNo) && !APPLICATION_NO_PATTERN.test(text(input.applicationNo))) {
    errors.push('applicationNo is not valid.');
  }
  return errors;
}

// cityName always goes out — it is mandatory, and validateRedirectRequest has
// already refused a request without it. The other address fields go out only
// when the SPA has them: NivaBupa's page shows whatever is prefilled, and a
// half-filled address there is worse than none.
function buildRedirectBody(input, { applicationNo, partnerRequestId, callbackUrl }) {
  const { firstName, lastName } = splitName(input);
  const gender = toKycGender(input.gender);
  const body = {
    ApplicationNo: applicationNo,
    PolicyNo: '',
    Salutation: gender === 'Female' ? 'Ms' : gender === 'Male' ? 'Mr' : '',
    firstName,
    lastName,
    PartnerRequestId: partnerRequestId,
    KYCType: text(input.kycType) || 'CKYC',
    proposerDOB: toKycDate(input.dob),
    proposerGender: gender,
    proposerEmailID: text(input.email),
    proposerMobileNumber: text(input.mobile),
    Pan: text(input.pan).toUpperCase(),
  };
  if (text(input.address)) body.addressLine1 = text(input.address);
  body.cityName = text(input.city);
  if (text(input.pincode)) body.proposerPinCode = text(input.pincode);
  if (text(input.state)) body.stateName = text(input.state);
  if (text(input.country)) body.COUNTRY = text(input.country);
  // Where NivaBupa's page sends the buyer once they are done. Optional to them
  // — a request without it still issues a link, it just ends on their own page.
  if (callbackUrl) body.CallBack_URL = callbackUrl;
  return body;
}

function redirectionLinkEnc(body, context) {
  return callKyc('RedirectionLinkEnc', 'KYC_REDIRECT_LINK', body, context);
}

// Issued means a usable link came back. "Duplicate Request" satisfies this on
// purpose: it carries the link already issued for that PartnerRequestId.
function isRedirectIssued(response) {
  return text(response?.statusCode) === '200' && !isBlank(response?.RedirectUrl);
}

function redirectMessage(response) {
  return text(response?.message) || text(response?.Message) || null;
}

function getKycStatusEnc({ applicationNo, partnerRequestId }, context) {
  return callKyc('GetKycStatusEnc', 'KYC_STATUS', {
    ApplicationNo: text(applicationNo),
    PartnerRequestId: text(partnerRequestId),
  }, context);
}

// Complete is NivaBupa's own verdict on their own page: IsKycComplete = True.
// That alone is the verdict. Only a CKYC-registry match carries a CKYCID — a
// KYC completed by digital Aadhaar, OVD or document upload comes back complete
// with CKYCID and CKYC_NUMBER both "" (their document's own GetKycStatusEnc
// sample is exactly that, KYCType "OVD").
function isHostedKycComplete(response) {
  return text(response?.IsKycComplete).toLowerCase() === 'true';
}

// Their status call answers StatusCode 201 with "Kyc Not Completed" while the
// buyer is still on the page, and 201 "Unable to get Application detail." when
// the ApplicationNo/PartnerRequestId pair matches no record at all.
function hostedStatusMessage(response) {
  return text(response?.CKYCRejectionDescription)
    || text(response?.Message)
    || text(response?.Remarks)
    || null;
}

function hostedKycStatus(response) {
  return text(response?.CKYCStatus) || text(response?.StatusCode) || null;
}

function maskTail(value, visible = 4) {
  const raw = text(value);
  if (!raw) return null;
  return raw.length <= visible ? raw : `${'X'.repeat(raw.length - visible)}${raw.slice(-visible)}`;
}

// Photo is a large base64 image the proposal never needs, and the hosted
// status call's GetEKYCDocumentRespons carries the uploaded document scans —
// both are dropped before the response is written to verified_response.
function storableResponse(response) {
  const { Photo, GetEKYCDocumentRespons, ...rest } = response || {};
  return rest;
}

// What the SPA is told. Deliberately not the CKYC record: it carries address,
// DOB and registry identifiers the browser never needs.
function summarize(row, { verified, message, response } = {}) {
  const name = text(response?.Name) || [response?.FirstName, response?.MiddleName, response?.LastName].map(text).filter(Boolean).join(' ');
  return {
    referenceId: row.kyc_reference_id,
    applicationNo: row.application_no,
    verified: Boolean(verified),
    message: message ?? row.status_message ?? null,
    name: name || null,
    ckycNumberMasked: maskTail(response?.CKYCID || row.ckyc_number),
  };
}

// ── Underwriting: the KYC completion check ──────────────────────────────────

function sourcingAppNoOf(payload) {
  return text(payload?.Proposal?.POLICY?.CONTRACT_DETAILS?.SOURCING_APPNO);
}

async function findVerifiedKyc(headers = {}) {
  const referenceId = text(headers[KYC_REQUEST_ID_HEADER]);
  if (!referenceId) return { referenceId, row: null };
  const row = await kycRepo.findByReferenceId(referenceId);
  return { referenceId, row: row?.status === 'VERIFIED' ? row : null };
}

// Returns { ok: true } or { ok: false, httpStatus, message }. Runs before
// anything is sent to NivaBupa's uwDecision API.
async function checkKycForUnderwriting(headers, payload) {
  const missing = missingKycVariables();
  if (missing.length) {
    return { ok: false, httpStatus: 503, message: `NivaBupa KYC is not configured on this server — missing ${missing.join(', ')}` };
  }

  let found;
  try {
    found = await findVerifiedKyc(headers);
  } catch (error) {
    console.error('⚠️  KYC lookup failed:', error.message);
    return { ok: false, httpStatus: 503, message: 'Could not confirm KYC right now — please try again.' };
  }

  if (!found.referenceId) {
    return { ok: false, httpStatus: 400, message: 'KYC verification with Niva Bupa is required before underwriting.' };
  }
  if (!found.row) {
    return { ok: false, httpStatus: 400, message: 'Niva Bupa has not verified KYC for this proposal.' };
  }
  if (sourcingAppNoOf(payload) !== text(found.row.application_no)) {
    return {
      ok: false,
      httpStatus: 400,
      message: 'The proposal application number does not match the application KYC was verified for.',
    };
  }
  return { ok: true };
}

// ── Data Push: verified KYC mapping ─────────────────────────────────────────
//
// PROPOSER.KYC fields NivaBupa's verification actually establishes: the CKYC
// number of the downloaded record, the PAN it was found by (the response's own
// PAN when it carries one), and — from the hosted flow's GetKycStatusEnc — the
// identity/address record pointers, which that response returns under the very
// names Data Push uses. Only non-blank verified values are written: a field
// NivaBupa left empty (CKYC_NUMBER on an OVD/Aadhaar KYC, all four pointers on
// the OTP flow) keeps what the proposal carries, which for those is null. Every
// other field stays exactly as built.
const VERIFIED_KYC_RECORD_FIELDS = [
  'KYC_IDENTITY_MASTER_FLAG',
  'KYC_IDENTITY_RECORD_NUMBER',
  'KYC_ADDRESS_MASTER_FLAG',
  'KYC_ADDRESS_RECORD_NUMBER',
];

function applyVerifiedKycFields(payload, row) {
  const proposer = payload?.Proposal?.PROPOSER;
  if (!proposer || row?.status !== 'VERIFIED') return [];
  const response = db.fromJson(row.verified_response) || {};
  if (!proposer.KYC || typeof proposer.KYC !== 'object') proposer.KYC = {};

  const applied = [];
  const write = (field, value) => {
    if (isBlank(value)) return;
    proposer.KYC[field] = String(value).trim();
    applied.push(field);
  };
  // PAN from the OTP flow's response, Pan / PAN_NUMBER from the hosted flow's —
  // whichever this row was verified through.
  write('CKYC_NUMBER', response.CKYCID || response.CKYC_NUMBER || row.ckyc_number);
  write('PAN_NUMBER', text(response.PAN || response.Pan || response.PAN_NUMBER).toUpperCase() || row.pan);
  for (const field of VERIFIED_KYC_RECORD_FIELDS) write(field, response[field]);
  return applied;
}

// Never blocks and never throws: Data Push runs after payment has been taken.
async function applyVerifiedKycToDataPush(headers, payload) {
  try {
    const found = await findVerifiedKyc(headers);
    if (!found.referenceId) return { applied: [], skipped: 'no KYC reference on the request' };
    if (!found.row) return { applied: [], skipped: `no verified KYC stored for ${found.referenceId}` };
    if (sourcingAppNoOf(payload) !== text(found.row.application_no)) {
      return { applied: [], skipped: 'SOURCING_APPNO does not match the KYC application number' };
    }
    return { applied: applyVerifiedKycFields(payload, found.row) };
  } catch (error) {
    return { applied: [], skipped: `verified KYC lookup failed: ${error.message}` };
  }
}

export {
  KYC_REQUEST_ID_HEADER,
  missingKycVariables,
  newKycReferenceId,
  newApplicationNo,
  newPartnerRequestId,
  validateRedirectRequest,
  buildRedirectBody,
  redirectionLinkEnc,
  isRedirectIssued,
  redirectMessage,
  getKycStatusEnc,
  isHostedKycComplete,
  hostedStatusMessage,
  hostedKycStatus,
  validateOtpRequest,
  isValidOtp,
  ekycOtpDetailEnc,
  isOtpSent,
  reSendOtpEnc,
  ekycDetailEnc,
  isKycVerified,
  isSuccess,
  kycMessage,
  storableResponse,
  summarize,
  checkKycForUnderwriting,
  applyVerifiedKycFields,
  applyVerifiedKycToDataPush,
};
