import express from 'express';
import * as controller from '../controllers/itgi.controller.js';

const router = express.Router();

// GET /iffcotokio/config/test — is this process able to reach ITGI at all?
// ITGI use HTTP Basic and have no token endpoint, so what is testable is the
// configuration rather than a credential exchange. Prints no values.
router.get('/iffcotokio/config/test', controller.testConfig);

// The quote → proposal → pay → download flow.
router.post('/iffcotokio/premium', controller.getPremium);
router.post('/iffcotokio/proposal', controller.submitProposal);

// Assembles the hosted-gateway form. No upstream call — the proposal response
// already carries the same thing; this serves a caller that kept the orderNo
// but not the response.
router.post('/iffcotokio/payment/initiate', controller.initiatePayment);

// ⚠️ ITGI redirect the buyer here after payment, at the response URL registered
// on THEIR side against our partner code — so this path is fixed by them and
// must stay publicly reachable. It is the only channel by which a policy number
// reaches this service (partner-end confirmation is disabled for our partner
// code), and six live UAT payments were lost to its absence on 2026-08-26.
//
// Both methods: the observed redirects are GETs carrying ?ITGIResponse=…, but a
// payment outcome is not the place to assume that will never change.
router.get('/iffcotokio/payment/return', controller.handlePaymentReturn);
router.post('/iffcotokio/payment/return', controller.handlePaymentReturn);

// Partner-end payment confirmation. Answers "Payment at partner end is not
// allowed for this product." until ITGI enable it for our partner code.
router.post('/iffcotokio/payment/confirmation', controller.confirmPayment);

router.post('/iffcotokio/policy-download', controller.downloadPolicy);

// CKYC — the only source of the itgiKYCReferenceNo every proposal must carry.
router.post('/iffcotokio/kyc/fetch', controller.fetchCkyc);
router.post('/iffcotokio/kyc/create', controller.createCkyc);

export default router;
