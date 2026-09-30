import express from 'express';
import * as controller from '../controllers/chola.controller.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS (Cholamandalam MS General Insurance) routes.
//
// Each route is named after the Chola operation it wraps — the last segment of
// Chola's own API kit URL (…/v1.0.0/PremiumComputation, …/KYC/CholaMS_CKYC_Verify)
// — so a call in the browser's Network tab reads as the Chola API behind it,
// the same move the NivaBupa KYC routes made. The working implementation's
// short names, which the SPA's api/chola.js calls, answer too: the same
// handlers, registered once more.
//
//   was (novacred-insurance-integrations :4002)       now
//   POST /api/chola/PremiumComputation  | /quote      →  POST /chola-ms/PremiumComputation | /quote
//   POST /api/chola/ProposalSave        | /proposal   →  POST /chola-ms/ProposalSave       | /proposal
//   POST /api/chola/PolicyGeneration    | /issue      →  POST /chola-ms/PolicyGeneration   | /issue
//   POST /api/chola/PolicySchedule      | /policy/schedule
//                                                     →  POST /chola-ms/PolicySchedule     | /policy/schedule
//   POST /api/chola/CholaMS_CKYC_Verify | /ckyc/verify
//                                                     →  POST /chola-ms/CholaMS_CKYC_Verify | /ckyc/verify
//   POST /api/chola/CholaMS_CKYC_Query  | /ckyc/query →  POST /chola-ms/CholaMS_CKYC_Query  | /ckyc/query
//   /api/chola/ops/*                                  →  /chola-ms/ops/*
//   GET  /ops/chola  (ops screen)                     →  GET  /chola-ms/ops
//
// There is no Chola payment callback route, and none is missing: PolicyGeneration
// takes no return URL, and Chola's hosted payment page returns the buyer to the
// SPA's /chola-return page directly. Under APD there is no payment page at all.
// ─────────────────────────────────────────────────────────────────────────────

// GET /chola-ms/config/test — can this process reach Chola at all? Prints no values.
router.get('/chola-ms/config/test', controller.testConfig);

// ── The flow ────────────────────────────────────────────────────────────────
//   1 PremiumComputation → 2 CKYC → 3 ProposalSave → 4 PolicyGeneration
//   → (Chola's hosted payment, or APD) → 5 PolicySchedule

// Pricing only — nothing is created at Chola.
router.post('/chola-ms/PremiumComputation', controller.getQuote);

// CKYC on the separate e-policy portal. Verify answers a CKYC number or an
// eKYC redirection URL; Query reads the outcome of the hosted page by App_Ref_No.
router.post('/chola-ms/CholaMS_CKYC_Verify', controller.ckycVerify);
router.post('/chola-ms/CholaMS_CKYC_Query', controller.ckycQuery);

// Writes to Gencon. Returns GENCONProposalNumber and the re-priced premium.
router.post('/chola-ms/ProposalSave', controller.createProposal);

// ⚠️ NOT IDEMPOTENT — tags the payment against a saved proposal. Only
// TaggingMode PG is accepted from a browser; APD is chosen by the server.
router.post('/chola-ms/PolicyGeneration', controller.issuePolicy);

// The policy document links, by POLICY number.
router.post('/chola-ms/PolicySchedule', controller.policySchedule);

// The working implementation's short names — what the SPA's api/chola.js
// calls. Same handlers.
router.post('/chola-ms/quote', controller.getQuote);
router.post('/chola-ms/proposal', controller.createProposal);
router.post('/chola-ms/issue', controller.issuePolicy);
router.post('/chola-ms/policy/schedule', controller.policySchedule);
router.post('/chola-ms/ckyc/verify', controller.ckycVerify);
router.post('/chola-ms/ckyc/query', controller.ckycQuery);

// ── Ops: backend-built PolicyGeneration (APD) ───────────────────────────────
//
// Never called by the website. X-Ops-Key guarded, and switched off (503) while
// CHOLA_OPS_KEY is unset. PolicyGeneration here is built in CHOLA_PAYMENT_MODE
// and sent exactly once — see services/cholaPolicyIssuer.service.js.

// The ops screen and its script. Static and holding no data, so not guarded:
// the page asks for the key and sends it on every call below.
router.get('/chola-ms/ops', controller.opsScreen);
router.get('/chola-ms/ops/chola-ops.js', controller.opsScript);

router.post('/chola-ms/ops/PolicyGeneration', controller.requireOpsKey, controller.opsPolicyGeneration);
router.get('/chola-ms/ops/PolicyGeneration/logs', controller.requireOpsKey, controller.opsListLogs);
router.get('/chola-ms/ops/proposals', controller.requireOpsKey, controller.opsListProposals);
router.get('/chola-ms/ops/proposals/:proposalNo/PolicyGeneration', controller.requireOpsKey, controller.opsProposalLogs);
router.get('/chola-ms/ops/proposals/:proposalNo/pdf', controller.requireOpsKey, controller.opsProposalPdf);

export default router;
