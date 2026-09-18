import crypto from 'node:crypto';
import axios from 'axios';
import config from '../config/env.js';
import db from '../db/index.js';
import { encryptKycPayload, decryptKycPayload } from '../helpers/nivabupaKycCrypto.helper.js';
import * as kycRepo from '../repositories/nivabupaKyc.repository.js';
import * as logRepo from '../repositories/log.repository.js';

// NivaBupa KYC — the CKYC OTP flow from NivaBupa's "KYC APIs Integration
// Document" (kyc):
//
//   GenerateTokenEnc → access_token      (PartnerName header, Username/Password)
//   EKYCOTPDetailEnc → OTP to the mobile registered on the PAN's CKYC record
//   EKYCDetailEnc    → the CKYC record, once NivaBupa has verified the OTP
//   ReSendOTPEnc     → the same OTP request again
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
async function generateToken(context) {
  const { username, password } = config.nivabupa.kyc;
  const data = await auditedPost('GenerateTokenEnc', 'KYC_TOKEN', { Username: username, Password: password }, null, context);
  if (!data?.access_token || String(data?.Status) !== '200') {
    throw new Error(`NivaBupa KYC token rejected: ${data?.Message || 'no access_token in response'}`);
  }
  return data.access_token;
}

async function callKyc(operation, apiName, body, context = {}) {
  const token = await generateToken(context);
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

function sendKycOtp({ pan, mobile }, context) {
  return callKyc('EKYCOTPDetailEnc', 'KYC_OTP_SEND', {
    Pan: text(pan).toUpperCase(),
    MobileNumber: text(mobile),
  }, context);
}

// Sent means Success AND both identifiers the OTP is later verified against.
function isOtpSent(response) {
  return isSuccess(response) && !isBlank(response?.CYCRequestId) && !isBlank(response?.CKYCTransactionID);
}

function resendKycOtp({ requestId, transactionId }, context) {
  return callKyc('ReSendOTPEnc', 'KYC_OTP_RESEND', {
    CYCRequestId: requestId,
    CKYCTransactionID: transactionId,
  }, context);
}

function verifyKycOtp({ requestId, transactionId, otp }, context) {
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

function maskTail(value, visible = 4) {
  const raw = text(value);
  if (!raw) return null;
  return raw.length <= visible ? raw : `${'X'.repeat(raw.length - visible)}${raw.slice(-visible)}`;
}

// Photo can be a large base64 image the proposal never needs.
function storableResponse(response) {
  const { Photo, ...rest } = response || {};
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
// PROPOSER.KYC fields NivaBupa's CKYC OTP verification actually establishes:
// the CKYC number of the downloaded record, and the PAN it was found by (the
// response's own PAN when it carries one). Only non-blank verified values are
// written; every other field the proposal carries stays exactly as built.
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
  write('CKYC_NUMBER', response.CKYCID || row.ckyc_number);
  write('PAN_NUMBER', text(response.PAN).toUpperCase() || row.pan);
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
  validateOtpRequest,
  isValidOtp,
  sendKycOtp,
  isOtpSent,
  resendKycOtp,
  verifyKycOtp,
  isKycVerified,
  isSuccess,
  kycMessage,
  storableResponse,
  summarize,
  checkKycForUnderwriting,
  applyVerifiedKycFields,
  applyVerifiedKycToDataPush,
};
