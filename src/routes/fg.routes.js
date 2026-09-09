import express from 'express';
import * as controller from '../controllers/fg.controller.js';

const router = express.Router();

// GET /future-generali/config/test — can this process reach Future Generali at
// all? FG have no token endpoint (they identify the caller by codes inside the
// payload), so what is testable is the configuration. Prints no values, and
// reports the quote, payment, CKYC and document legs separately because they
// fail independently.
router.get('/future-generali/config/test', controller.testConfig);

// ── The flow ────────────────────────────────────────────────────────────────
//   1 quote → 2 CKYC → 3 proposal → 4 payment → 5 issuance → 6 document

// CreatePolicy / METHOD=ENQ. Premium enquiry only; nothing is created at FG.
router.post('/future-generali/quote', controller.getQuote);

// HealthPreCRTValidate / METHOD=CRT. Validates the full proposal and returns
// FG's transaction reference. The service completes FG's client handshake
// transparently, so this is one logical call.
router.post('/future-generali/proposal', controller.createProposal);

// CreatePolicy / METHOD=CRT with a filled Receipt — the RAW issuance call, for
// reconciliation and support. The normal journey uses /payment/issue below,
// which maps FG's payment references into the receipt and will not issue twice.
router.post('/future-generali/issue', controller.issuePolicy);

// ── CKYC ────────────────────────────────────────────────────────────────────
// GC-CKYC 3.0.0 or the legacy NL-CKYC service depending on configuration; both
// normalise to the same response, so a caller never branches on which answered.
router.post('/future-generali/ckyc/create', controller.createCkyc);
router.post('/future-generali/ckyc/status', controller.getCkycStatus);

// ── Payment ─────────────────────────────────────────────────────────────────
//
// FG expose no payment API: the browser is handed to their gateway page and the
// outcome comes back as an encrypted form POST. Three routes cover what a
// single-page app cannot do on its own — build the form and its CheckSum,
// receive and decrypt the callback, and hand the page a result by opaque token
// — plus a fourth that issues from a verified payment.
router.post('/future-generali/payment/session', controller.createPaymentSession);

// ⚠️ FG POST the payment outcome here, at the ResponseURL this service sends on
// every payment form. It must stay publicly reachable at a stable address and
// must NEVER 404 or rate-limit: a callback that lands on nothing is a buyer who
// paid and whose WS_P_ID and PGID — the two references issuance is impossible
// without — are gone.
//
// `all`, not `post`: the observed callback is a form POST, but a payment outcome
// is not the place to assume the method will never change.
router.all('/future-generali/payment/return', controller.handlePaymentReturn);

router.get('/future-generali/payment/result/:token', controller.getPaymentResult);
router.post('/future-generali/payment/issue', controller.issueAfterPayment);

// ── Policy document ─────────────────────────────────────────────────────────
//
// A different FG service (/TCSPDFService/Service1.svc, contract IService1),
// keyed on the PolicyNo issuance returns.
//
// JSON by default so a caller can see what FG answered; `?meta=1` reports that
// without pulling the document down with it, which is what makes polling cheap.
// Polling is necessary: FG generate the document 15–25s AFTER issuance.
router.get('/future-generali/policy/:policyNo/pdf', controller.getPolicyPdf);

// Streams a real application/pdf. `?download=1` asks for
// Content-Disposition: attachment — which has to be asked of the SERVER,
// because the SPA is a different origin and a browser ignores <a download>
// cross-origin.
router.get('/future-generali/policy/:policyNo/pdf/download', controller.downloadPolicyPdf);

export default router;
