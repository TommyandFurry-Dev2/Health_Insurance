import express from 'express';
import * as controller from '../controllers/nivabupaKyc.controller.js';

const router = express.Router();

// Each route is named after the NivaBupa KYC operation it wraps, so a call in
// the browser's Network tab reads as the NivaBupa API behind it. Every one of
// them runs GenerateTokenEnc first, server-side.

// Hosted KYC — NivaBupa's own KYC page. The flow the SPA uses.
router.post('/nivabupa/kyc/RedirectionLinkEnc', controller.redirectionLinkEnc);
router.post('/nivabupa/kyc/GetKycStatusEnc', controller.getKycStatusEnc);

// CKYC OTP, in this service. Kept as the fallback for a buyer the hosted page
// cannot serve.
router.post('/nivabupa/kyc/EKYCOTPDetailEnc', controller.ekycOtpDetailEnc);
router.post('/nivabupa/kyc/EKYCDetailEnc', controller.ekycDetailEnc);
router.post('/nivabupa/kyc/ReSendOTPEnc', controller.reSendOtpEnc);

// The previous names, kept so a frontend build deployed before the rename keeps
// working. Same handlers — remove once every deployed build calls the names
// above.
router.post('/nivabupa/kyc/redirect', controller.redirectionLinkEnc);
router.post('/nivabupa/kyc/status', controller.getKycStatusEnc);
router.post('/nivabupa/kyc/otp/send', controller.ekycOtpDetailEnc);
router.post('/nivabupa/kyc/otp/verify', controller.ekycDetailEnc);
router.post('/nivabupa/kyc/otp/resend', controller.reSendOtpEnc);

export default router;
