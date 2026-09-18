import express from 'express';
import * as controller from '../controllers/nivabupaKyc.controller.js';

const router = express.Router();

router.post('/nivabupa/kyc/otp/send', controller.sendOtp);
router.post('/nivabupa/kyc/otp/verify', controller.verifyOtp);
router.post('/nivabupa/kyc/otp/resend', controller.resendOtp);

export default router;
