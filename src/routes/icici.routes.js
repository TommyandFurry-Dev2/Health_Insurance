import express from 'express';
import * as controller from '../controllers/icici.controller.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard ("Elevate") routes.
//
// Each path is the working implementation's own `/api/icici/<op>` route with
// the `/api` removed and the insurer prefix spelled out — the same move Future
// Generali made from /api/future-generali/* to /future-generali/*. Methods,
// request bodies and response bodies are unchanged.
//
//   was (novacred-insurance-integrations :4002)   now
//   POST /api/icici_quote            →           POST /icici-lombard/quote
//   POST /api/icici_proposal         →           POST /icici-lombard/proposal
//   POST /api/icici_issue            →           POST /icici-lombard/issue
//   POST /api/icici_policy_status    →           POST /icici-lombard/policy/status
//   POST /api/icici_emi_due          →           POST /icici-lombard/emi/due
//   POST /api/icici_emi_process      →           POST /icici-lombard/emi/process
//   POST /api/icici_zone             →           POST /icici-lombard/zone
//   GET  /api/icici_coi/:txnId       →           GET  /icici-lombard/coi/:transactionId
//   POST /api/icici_ckyc             →           POST /icici-lombard/ckyc
//   POST /api/icici_ckyc_ovd         →           POST /icici-lombard/ckyc/ovd
//
// There is no ICICI payment callback route, and none is missing: ICICI's hosted
// gateway returns the buyer straight to the SPA on the SuccessUrl the proposal
// carries, and the SPA confirms the outcome through /policy/status.
// ─────────────────────────────────────────────────────────────────────────────

// GET /icici-lombard/config/test — can this process reach ICICI at all?
// Prints no values.
router.get('/icici-lombard/config/test', controller.testConfig);

// ── The flow ────────────────────────────────────────────────────────────────
//   1 quote → 2 CKYC → 3 proposal → 4 ICICI's hosted payment → 5 policy status
//   → 6 certificate of insurance

// Premium. Mints ICICI's TransactionId (bnc_…), which every later call is keyed by.
router.post('/icici-lombard/quote', controller.getQuote);

// CKYC — a hard gate: ICICI refuse a proposal on a TransactionId whose KYC has
// not resolved. OVD is ICICI's document-upload fallback.
router.post('/icici-lombard/ckyc', controller.ckyc);
router.post('/icici-lombard/ckyc/ovd', controller.ovdInitiate);

// Proposal-payment. Returns ProposalId + PaymentUrl (ICICI's hosted gateway).
router.post('/icici-lombard/proposal', controller.createProposal);

// Proposal / policy status by TransactionId — the authoritative read after a
// hosted payment.
router.post('/icici-lombard/policy/status', controller.policyStatus);

// Policy Sync — issuance for PARTNER-collected payment only.
router.post('/icici-lombard/issue', controller.issuePolicy);

// Certificate of insurance, as base64.
router.get('/icici-lombard/coi/:transactionId', controller.coi);

// ── Servicing ───────────────────────────────────────────────────────────────
router.post('/icici-lombard/emi/due', controller.emiDue);
router.post('/icici-lombard/emi/process', controller.processEmi);
router.post('/icici-lombard/zone', controller.zone);

export default router;
