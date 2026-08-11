import express from 'express';
import * as controller from '../controllers/payment.controller.js';

const router = express.Router();

router.post('/nivabupa/payment/initiate', controller.initiatePayment);
// NivaBupa's gateway POSTs here — this is the URL registered with them as
// `returnPath`, so it must stay publicly reachable at a stable address.
router.post('/nivabupa/payment/return', controller.handlePaymentReturn);

export default router;
