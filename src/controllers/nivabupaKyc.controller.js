import db from '../db/index.js';
import * as kycService from '../services/nivabupaKyc.service.js';
import * as kycRepo from '../repositories/nivabupaKyc.repository.js';
import * as journeyService from '../services/journey.service.js';
import { KYC_STATUS } from '../constants/journey.constants.js';

function notConfigured(res) {
  const missing = kycService.missingKycVariables();
  if (missing.length === 0) return false;
  res.status(503).json({
    status: 'ERROR',
    message: `NivaBupa KYC is not configured on this server — missing ${missing.join(', ')}`,
  });
  return true;
}

function upstreamError(res, error, label) {
  console.error(`❌ ${label}:`, error.message);
  return res.status(502).json({ status: 'ERROR', message: error.message || label });
}

function databaseError(res, error) {
  console.error('❌ NivaBupa KYC could not be recorded:', error.message);
  return res.status(503).json({ status: 'ERROR', message: 'KYC could not be recorded right now — please try again.' });
}

// Loads the attempt a verify/resend refers to, answering the error itself when
// there is none. The CKYC identifiers never come from the browser.
async function loadAttempt(req, res) {
  const referenceId = String(req.body?.referenceId || '').trim();
  if (!referenceId) {
    res.status(400).json({ status: 'ERROR', message: 'referenceId is required' });
    return null;
  }
  let row;
  try {
    row = await kycRepo.findByReferenceId(referenceId);
  } catch (error) {
    databaseError(res, error);
    return null;
  }
  if (!row) {
    res.status(404).json({ status: 'ERROR', message: 'No KYC request found for this reference — send the OTP again.' });
    return null;
  }
  return row;
}

// POST /nivabupa/kyc/otp/send
//
// Body: { pan*, mobile*, applicationNo? }
//
// Asks NivaBupa (EKYCOTPDetailEnc) to send an OTP to the mobile registered on
// the PAN's CKYC record. applicationNo is reused when supplied, so a buyer who
// has to start again keeps the application number the proposal will carry.
export const sendOtp = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const input = req.body || {};
  const errors = kycService.validateOtpRequest(input);
  if (errors.length) {
    return res.status(400).json({ status: 'ERROR', message: errors.join(' '), errors });
  }

  const kycReferenceId = kycService.newKycReferenceId();
  const applicationNo = String(input.applicationNo || '').trim() || kycService.newApplicationNo();
  const pan = String(input.pan).trim().toUpperCase();
  const mobile = String(input.mobile).trim();
  const context = { journeyId: req.journeyId, correlationId: kycReferenceId };

  try {
    await kycRepo.createPending({ kycReferenceId, applicationNo, journeyId: req.journeyId, pan, mobile });
  } catch (error) {
    return databaseError(res, error);
  }

  let response;
  try {
    response = await kycService.sendKycOtp({ pan, mobile }, context);
  } catch (error) {
    await kycRepo.markFailed(kycReferenceId, { message: error.message }).catch(() => {});
    return upstreamError(res, error, 'NivaBupa KYC OTP request failed');
  }

  const message = kycService.kycMessage(response);
  if (!kycService.isOtpSent(response)) {
    await kycRepo.markFailed(kycReferenceId, { ckycStatus: response?.CKYCStatus, message }).catch(() => {});
    return res.status(422).json({
      status: 'ERROR',
      message: message || 'Niva Bupa could not send a KYC OTP for this PAN.',
      ckycStatus: response?.CKYCStatus ?? null,
    });
  }

  try {
    await kycRepo.markOtpSent(kycReferenceId, {
      requestId: response.CYCRequestId,
      transactionId: response.CKYCTransactionID,
      ckycStatus: response.CKYCStatus,
      message,
    });
  } catch (error) {
    return databaseError(res, error);
  }

  if (req.journeyId) {
    await journeyService.saveKycStatus(req.journeyId, {
      status: KYC_STATUS.PENDING,
      method: 'CKYC',
      referenceId: kycReferenceId,
      panNumber: pan,
    }, req.journeyContext);
  }

  return res.status(200).json({
    status: 'SUCCESS',
    kyc: { referenceId: kycReferenceId, applicationNo, message },
  });
};

// POST /nivabupa/kyc/otp/verify
//
// Body: { referenceId*, otp* }
//
// Submits the OTP to NivaBupa (EKYCDetailEnc). `verified` is NivaBupa's answer:
// true only when they return the CKYC record.
export const verifyOtp = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const row = await loadAttempt(req, res);
  if (!row) return undefined;

  if (row.status === 'VERIFIED') {
    const response = db.fromJson(row.verified_response);
    return res.status(200).json({ status: 'SUCCESS', kyc: kycService.summarize(row, { verified: true, response }) });
  }
  if (row.status !== 'OTP_SENT') {
    return res.status(409).json({ status: 'ERROR', message: 'No OTP is pending for this KYC request — send the OTP again.' });
  }

  const otp = String(req.body?.otp || '').trim();
  if (!kycService.isValidOtp(otp)) {
    return res.status(400).json({ status: 'ERROR', message: 'Enter the OTP you received.' });
  }

  let response;
  try {
    response = await kycService.verifyKycOtp(
      { requestId: row.ckyc_request_id, transactionId: row.ckyc_transaction_id, otp },
      { journeyId: req.journeyId, correlationId: row.kyc_reference_id }
    );
  } catch (error) {
    return upstreamError(res, error, 'NivaBupa KYC OTP verification failed');
  }

  const verified = kycService.isKycVerified(response);
  const message = kycService.kycMessage(response) || (verified ? 'KYC verified' : 'OTP could not be verified.');

  let saved = row;
  try {
    if (verified) {
      saved = await kycRepo.markVerified(row.kyc_reference_id, {
        ckycNumber: response.CKYCID,
        ckycStatus: response.CKYCStatus,
        message,
        response: kycService.storableResponse(response),
      });
    } else {
      await kycRepo.saveMessage(row.kyc_reference_id, { ckycStatus: response?.CKYCStatus, message, countAttempt: true });
    }
  } catch (error) {
    // Verified but not recorded would leave underwriting unable to find it.
    return databaseError(res, error);
  }

  if (req.journeyId && verified) {
    await journeyService.saveKycStatus(req.journeyId, {
      status: KYC_STATUS.VERIFIED,
      method: 'CKYC',
      referenceId: row.kyc_reference_id,
      ckycNumber: response.CKYCID,
      panNumber: row.pan,
    }, req.journeyContext);
  }

  return res.status(200).json({
    status: 'SUCCESS',
    kyc: kycService.summarize(saved, { verified, message, response }),
  });
};

// POST /nivabupa/kyc/otp/resend
//
// Body: { referenceId* }
export const resendOtp = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const row = await loadAttempt(req, res);
  if (!row) return undefined;
  if (row.status !== 'OTP_SENT') {
    return res.status(409).json({ status: 'ERROR', message: 'No OTP is pending for this KYC request — send the OTP again.' });
  }

  let response;
  try {
    response = await kycService.resendKycOtp(
      { requestId: row.ckyc_request_id, transactionId: row.ckyc_transaction_id },
      { journeyId: req.journeyId, correlationId: row.kyc_reference_id }
    );
  } catch (error) {
    return upstreamError(res, error, 'NivaBupa KYC OTP resend failed');
  }

  const message = kycService.kycMessage(response);
  if (!kycService.isSuccess(response)) {
    return res.status(422).json({ status: 'ERROR', message: message || 'Niva Bupa could not resend the OTP.' });
  }
  await kycRepo.saveMessage(row.kyc_reference_id, { ckycStatus: response.CKYCStatus, message }).catch(() => {});

  return res.status(200).json({
    status: 'SUCCESS',
    kyc: { referenceId: row.kyc_reference_id, applicationNo: row.application_no, message },
  });
};
