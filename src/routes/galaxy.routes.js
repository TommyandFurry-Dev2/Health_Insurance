import express from 'express';
import * as controller from '../controllers/galaxy.controller.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health Insurance (GHI, CBOS-GX V2) routes.
//
// Each route is named after the GHI operation it wraps — the last segment of
// GHI's own URL (…/cbosgx-quote/api/v2/quickQuote) — so a call in the browser's
// Network tab reads as the GHI API behind it, the move the Chola routes made.
// The working implementation's short names answer too: the same handlers.
//
//   was (novacred-insurance-integrations :4002)   now
//   POST /api/galaxy/quote                  →    POST /galaxy-health/quickQuote        | /quote
//   POST /api/galaxy/proposal               →    POST /galaxy-health/saveFullProposal  | /proposal
//   POST /api/galaxy/issue                  →    POST /galaxy-health/createOrder       | /issue
//   POST /api/galaxy/document/upload        →    POST /galaxy-health/uploadDocument    | /document/upload
//   POST /api/galaxy/document/download      →    POST /galaxy-health/downloadDocument  | /document/download
//   POST /api/galaxy/document/search        →    POST /galaxy-health/searchDocument    | /document/search
//   POST /api/galaxy/pubkey/current         →    POST /galaxy-health/ops/getCurrentPubKey  (X-Ops-Key)
//   POST /api/galaxy/pubkey/next            →    POST /galaxy-health/ops/getNextPubKey     (X-Ops-Key)
//   POST /api/galaxy/pubkey/rotate          →    POST /galaxy-health/ops/rotateKeys        (X-Ops-Key)
//
// Request and response bodies are unchanged. The payment leg after createOrder
// (token API, callback, redirect, status) is this service's own — see below and
// services/galaxyPayment.service.js.
// ─────────────────────────────────────────────────────────────────────────────

// GET /galaxy-health/config/test — configured? today's key fetched? Prints no values.
router.get('/galaxy-health/config/test', controller.testConfig);

// ── The flow ────────────────────────────────────────────────────────────────
//   (daily getCurrentPubKey) → 1 quickQuote → 2 saveFullProposal
//   → 3 createOrder → GHI's payment page

// Pricing only — nothing is created at GHI.
router.post('/galaxy-health/quickQuote', controller.quickQuote);

// Creates a DRAFT proposal at GHI: proposal number, refId, the proposer's party code.
router.post('/galaxy-health/saveFullProposal', controller.saveFullProposal);

// A payment order on the proposal: GHI's payment page (returnUrl) and orderId.
router.post('/galaxy-health/createOrder', controller.createOrder);

// ── Documents ───────────────────────────────────────────────────────────────
router.post('/galaxy-health/uploadDocument', controller.uploadDocument);
router.post('/galaxy-health/downloadDocument', controller.downloadDocument);
router.post('/galaxy-health/searchDocument', controller.searchDocument);

// The working implementation's short names. Same handlers.
router.post('/galaxy-health/quote', controller.quickQuote);
router.post('/galaxy-health/proposal', controller.saveFullProposal);
router.post('/galaxy-health/issue', controller.createOrder);
router.post('/galaxy-health/document/upload', controller.uploadDocument);
router.post('/galaxy-health/document/download', controller.downloadDocument);
router.post('/galaxy-health/document/search', controller.searchDocument);

// ── Payment: the URLs GHI configure for our channel ─────────────────────────
//
// ⚠️ GHI hold these three URLs. They must stay publicly reachable at a stable
// address (through the /health alias on the deployed host) and must never 404
// or rate-limit: a result that lands on nothing is a buyer who paid.

// Client credentials (issued by us to GHI) → a Bearer token for the callback.
router.post('/galaxy-health/payment/token', controller.paymentToken);

// GHI's server-to-server payment result. Bearer token required. `all`, not
// `post`: the method is not documented yet.
router.all('/galaxy-health/payment/callback', controller.paymentCallback);

// The buyer's browser after GHI's payment page → the SPA's /galaxy-return page.
router.all('/galaxy-health/payment/return', controller.paymentReturn);

// What the /galaxy-return page reads, by GHI's orderId.
router.get('/galaxy-health/payment/status/:orderId', controller.paymentStatus);

// ── Ops: GHI key rotation ───────────────────────────────────────────────────
// Never called by the website. Each getCurrentPubKey registers a new NovaCred
// key with GHI and uses one of GHI's 3 a day. X-Ops-Key guarded, and switched
// off (503) while GX_OPS_KEY is unset.
router.post('/galaxy-health/ops/getCurrentPubKey', controller.requireOpsKey, controller.opsGetCurrentPubKey);
router.post('/galaxy-health/ops/getNextPubKey', controller.requireOpsKey, controller.opsGetNextPubKey);
router.post('/galaxy-health/ops/rotateKeys', controller.requireOpsKey, controller.opsRotateKeys);

export default router;
