import express from 'express';
import * as controller from '../controllers/nivabupaKyc.controller.js';

const router = express.Router();

// Hosted KYC — NivaBupa's own KYC page. The flow the SPA uses.
router.post('/nivabupa/kyc/redirect', controller.startRedirect);
router.post('/nivabupa/kyc/status', controller.checkStatus);

// CKYC OTP, in this service. Kept as the fallback for a buyer the hosted page
// cannot serve.
router.post('/nivabupa/kyc/otp/send', controller.sendOtp);
router.post('/nivabupa/kyc/otp/verify', controller.verifyOtp);
router.post('/nivabupa/kyc/otp/resend', controller.resendOtp);

export default router;
