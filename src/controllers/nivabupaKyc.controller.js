import config from '../config/env.js';
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
    res.status(404).json({ status: 'ERROR', message: 'No KYC request found for this reference — start KYC again.' });
    return null;
  }
  return row;
}

// POST /nivabupa/kyc/RedirectionLinkEnc
//
// Body: { fullName* (or firstName*/lastName*), dob*, gender*, email*, mobile*,
//         pan*, city*, address?, state?, pincode?, applicationNo?, kycType? }
//
// Asks NivaBupa (RedirectionLinkEnc) for a link to THEIR OWN KYC page for this
// buyer, and answers it to the SPA, which sends the buyer there. Nothing is
// verified at this point: the outcome is read back from GetKycStatusEnc by
// POST /nivabupa/kyc/GetKycStatusEnc, because a buyer who finishes and closes
// the tab never returns to CallBack_URL and their KYC is complete all the same.
//
// applicationNo is reused when supplied, so a buyer who starts KYC again keeps
// the application number the proposal will carry.
export const redirectionLinkEnc = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const input = req.body || {};
  const errors = kycService.validateRedirectRequest(input);
  if (errors.length) {
    return res.status(400).json({ status: 'ERROR', message: errors.join(' '), errors });
  }

  const kycReferenceId = kycService.newKycReferenceId();
  const partnerRequestId = kycService.newPartnerRequestId();
  const applicationNo = String(input.applicationNo || '').trim() || kycService.newApplicationNo();
  const pan = String(input.pan).trim().toUpperCase();
  const mobile = String(input.mobile).trim();
  const context = { journeyId: req.journeyId, correlationId: kycReferenceId };

  try {
    await kycRepo.createRedirectPending({ kycReferenceId, applicationNo, journeyId: req.journeyId, pan, mobile, partnerRequestId });
  } catch (error) {
    return databaseError(res, error);
  }

  const body = kycService.buildRedirectBody(input, {
    applicationNo,
    partnerRequestId,
    callbackUrl: config.nivabupa.kyc.callbackUrl,
  });

  let response;
  try {
    response = await kycService.redirectionLinkEnc(body, context);
  } catch (error) {
    await kycRepo.markFailed(kycReferenceId, { message: error.message }).catch(() => {});
    return upstreamError(res, error, 'NivaBupa KYC link request failed');
  }

  const message = kycService.redirectMessage(response);
  if (!kycService.isRedirectIssued(response)) {
    await kycRepo.markFailed(kycReferenceId, { message }).catch(() => {});
    // 422, not 502: NivaBupa answered, and the answer is about this buyer's
    // details ("Proposer EmailId field is Mandatory" and friends).
    return res.status(422).json({
      status: 'ERROR',
      message: message || 'Niva Bupa could not open a KYC page for these details.',
    });
  }

  try {
    await kycRepo.markLinkIssued(kycReferenceId, {
      nbhiReferenceNo: response.NBHIReferenceNo,
      redirectUrl: response.RedirectUrl,
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
    kyc: {
      referenceId: kycReferenceId,
      applicationNo,
      redirectUrl: response.RedirectUrl,
      verified: false,
      message,
    },
  });
};

// POST /nivabupa/kyc/GetKycStatusEnc
//
// Body: { referenceId* }
//
// Asks NivaBupa (GetKycStatusEnc) what their hosted page ended in. Polled by
// the SPA while the buyer is on that page, and again when they come back.
//
// Safe to call any number of times: a row already VERIFIED answers from what
// was stored instead of calling NivaBupa again, and an unfinished one is left
// exactly as it was.
export const getKycStatusEnc = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const row = await loadAttempt(req, res);
  if (!row) return undefined;

  if (row.status === 'VERIFIED') {
    const response = db.fromJson(row.verified_response);
    return res.status(200).json({ status: 'SUCCESS', kyc: kycService.summarize(row, { verified: true, response }) });
  }
  if (!row.partner_request_id) {
    return res.status(409).json({
      status: 'ERROR',
      message: 'This KYC request was not started on Niva Bupa\'s KYC page — verify the OTP instead.',
    });
  }

  let response;
  try {
    response = await kycService.getKycStatusEnc(
      { applicationNo: row.application_no, partnerRequestId: row.partner_request_id },
      { journeyId: req.journeyId, correlationId: row.kyc_reference_id }
    );
  } catch (error) {
    return upstreamError(res, error, 'NivaBupa KYC status check failed');
  }

  const verified = kycService.isHostedKycComplete(response);
  const message = kycService.hostedStatusMessage(response) || (verified ? 'KYC verified' : 'KYC is not complete yet.');
  // Blank on an Aadhaar/OVD/document-upload KYC — stored as NULL, not '', and
  // never made up.
  const ckycNumber = response?.CKYCID || response?.CKYC_NUMBER || null;

  let saved = row;
  try {
    if (verified) {
      saved = await kycRepo.markVerified(row.kyc_reference_id, {
        ckycNumber,
        ckycStatus: kycService.hostedKycStatus(response),
        message,
        response: kycService.storableResponse(response),
      });
    } else {
      // No attempt counted: polling a page the buyer is still on is not a
      // failed verification.
      await kycRepo.saveMessage(row.kyc_reference_id, { ckycStatus: kycService.hostedKycStatus(response), message });
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
      ckycNumber,
      panNumber: row.pan,
    }, req.journeyContext);
  }

  return res.status(200).json({
    status: 'SUCCESS',
    kyc: {
      ...kycService.summarize(saved, { verified, message, response }),
      // The link stays usable for 72 hours, so a buyer who abandoned the page
      // can be sent back to the same one rather than starting a second record.
      redirectUrl: verified ? null : row.redirect_url || null,
    },
  });
};

// POST /nivabupa/kyc/EKYCOTPDetailEnc
//
// Body: { pan*, mobile*, applicationNo? }
//
// Asks NivaBupa (EKYCOTPDetailEnc) to send an OTP to the mobile registered on
// the PAN's CKYC record. applicationNo is reused when supplied, so a buyer who
// has to start again keeps the application number the proposal will carry.
export const ekycOtpDetailEnc = async (req, res) => {
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
    response = await kycService.ekycOtpDetailEnc({ pan, mobile }, context);
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

// POST /nivabupa/kyc/EKYCDetailEnc
//
// Body: { referenceId*, otp* }
//
// Submits the OTP to NivaBupa (EKYCDetailEnc). `verified` is NivaBupa's answer:
// true only when they return the CKYC record.
export const ekycDetailEnc = async (req, res) => {
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
    response = await kycService.ekycDetailEnc(
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

// POST /nivabupa/kyc/ReSendOTPEnc
//
// Body: { referenceId* }
export const reSendOtpEnc = async (req, res) => {
  if (notConfigured(res)) return undefined;

  const row = await loadAttempt(req, res);
  if (!row) return undefined;
  if (row.status !== 'OTP_SENT') {
    return res.status(409).json({ status: 'ERROR', message: 'No OTP is pending for this KYC request — send the OTP again.' });
  }

  let response;
  try {
    response = await kycService.reSendOtpEnc(
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
