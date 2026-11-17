// ─────────────────────────────────────────────────────────────────────────────
// Chola MS (Cholamandalam MS General Insurance) — Health constants.
//
// Verified from the NovaCred Postman collections (Flexi Health / Supreme /
// Super Topup) and the UAT_CKYC collection, and carried over unchanged from the
// working NovaCred implementation (src/providers/chola/constants.js there).
//
// Nothing here is environment-dependent: no host, no client id, no key. The
// request PATHS moved to config (defaults.js CHOLA_DEFAULTS.paths, overridable
// by CHOLA_*_PATH) the same way ICICI's did.
//
// Product APIs (OAuth2 bearer):
//   Token   : POST {CHOLA_BASE_URL}/oauth2/token  (Basic clientId:clientSecret,
//             grant_type=client_credentials)
//   Product : POST {CHOLA_BASE_URL}/endpoint/<productPath>/v1.0.0/<Operation>
//             for PremiumComputation, ProposalSave, PolicyGeneration,
//             PolicySchedule
//
// Super Topup's ProposalSave lives on a different (Portal .svc) host, supplied
// as an absolute URL via CHOLA_TOPUP_PROPOSAL_URL.
//
// CKYC (separate e-policy portal, its own auth):
//   {CHOLA_CKYC_BASE_URL}/epolicyv3api/api/KYC/CholaMS_CKYC_Auth   → TokenKey
//   {CHOLA_CKYC_BASE_URL}/Epolicyv3API/api/KYC/CholaMS_CKYC_Verify (header TokenKey)
//   {CHOLA_CKYC_BASE_URL}/Epolicyv3API/api/KYC/CholaMS_CKYC_Query  (header TokenKey)
// ─────────────────────────────────────────────────────────────────────────────

// product key → path segment used under /endpoint/<path>/v1.0.0/
const CHOLA_PRODUCTS = {
  FLEXI_HEALTH: { path: 'Health-flexiretail', label: 'Chola Flexi Health (Retail)' },
  SUPREME: { path: 'health-flexi-supreme', label: 'Chola Flexi Health Supreme' },
  SUPER_TOPUP: { path: 'Health-supertopup', label: 'Chola Flexi Super Topup' },
};

// Applied when a request names no `product`.
const CHOLA_DEFAULT_PRODUCT = 'FLEXI_HEALTH';

// Operations under each product path.
const CHOLA_OPERATIONS = ['PremiumComputation', 'ProposalSave', 'PolicyGeneration', 'PolicySchedule'];

// The provider key the working implementation stamped on every response and
// error envelope. Kept verbatim: the SPA's Chola pages (utils/cholaQuote.js,
// utils/cholaCkyc.js) were written against those envelopes.
const CHOLA_PROVIDER = 'chola';

// api_transactions.api_name for each Chola call. Prefixed so one query
// separates insurers in a table they all write to.
const CHOLA_API_NAMES = {
  QUOTE: 'CHOLA_PREMIUM_COMPUTATION',
  PROPOSAL: 'CHOLA_PROPOSAL_SAVE',
  POLICY_GENERATION: 'CHOLA_POLICY_GENERATION',
  POLICY_SCHEDULE: 'CHOLA_POLICY_SCHEDULE',
  CKYC_VERIFY: 'CHOLA_CKYC_VERIFY',
  CKYC_QUERY: 'CHOLA_CKYC_QUERY',
  OPS_POLICY_GENERATION: 'CHOLA_OPS_POLICY_GENERATION',
  FREECHARGE_CHECKOUT: 'CHOLA_FREECHARGE_CHECKOUT',
  FREECHARGE_CALLBACK: 'CHOLA_FREECHARGE_CALLBACK',
  FREECHARGE_STATUS: 'CHOLA_FREECHARGE_TXN_STATUS',
  FREECHARGE_REFUND: 'CHOLA_FREECHARGE_REFUND',
  FREECHARGE_PAYLINK: 'CHOLA_FREECHARGE_PAYLINK',
};

/**
 * How the backend tags payment when IT builds a PolicyGeneration request
 * (CHOLA_PAYMENT_MODE — see services/cholaPolicyIssuer.service.js). The website
 * builds its own PG request and is not steered by this, except under APD.
 *
 *   PG_CHOLA   TaggingMode PG, PayMode "Chola" — Chola host the payment page
 *              and answer a URL (on their internal 10.105.63.69 in UAT).
 *   PG_DIRECT  TaggingMode PG, PayMode "Direct" — we collected the premium and
 *              are tagging it; Chola answer the policy number.
 *   APD        TaggingMode APD — the premium is debited from NovaCred's Advance
 *              Premium Deposit with Chola. No payment URL is involved.
 */
const CHOLA_PAYMENT_MODES = ['PG_CHOLA', 'PG_DIRECT', 'APD'];

/**
 * The PolicyGeneration fields each product's own Postman sample spells
 * differently. Taken from those samples, and identical to the map the website's
 * PG builder uses (buildCholaPolicyGenerationRequest in the frontend's
 * utils/cholaQuote.js) — so the backend and the website send one spelling per
 * product, whichever of them builds the request.
 *
 * Flexi Health's cheque field really is "ChequeorDDnumber " WITH a trailing
 * space, and its BT advice field has a lower-case 'n'. Not typos to fix: they
 * are the names the product was sampled with.
 *
 * `btAdviceEmpty` is the empty value each sample sends. Supreme's is the number
 * 0 and Super Topup's the string "0": the WCF contract answers an HTTP 400
 * deserialization fault for "" on an Int64 field, so "" is only used where the
 * product's own sample sends "".
 */
const CHOLA_POLICY_GENERATION_FIELDS = {
  FLEXI_HEALTH: {
    chequeNumber: 'ChequeorDDnumber ',
    btAdviceNumber: 'BTAdvicenumber',
    transactionDate: 'Dateoftransaction',
    btAdviceEmpty: '',
  },
  SUPREME: {
    chequeNumber: 'ChequeOrDDNumber',
    btAdviceNumber: 'BTAdviceNumber',
    transactionDate: 'Dateoftransaction',
    btAdviceEmpty: 0,
  },
  SUPER_TOPUP: {
    chequeNumber: 'ChequeOrDDNumber',
    btAdviceNumber: 'BTAdviceNumber',
    transactionDate: 'DateOfTransaction',
    btAdviceEmpty: '0',
  },
};

// Gencon bank code carried by every PG sample in the kit — the collection
// account a gateway payment settles into, not a customer's bank.
const CHOLA_PG_BANK_CODE = '3719';

/**
 * health_chola_proposals.status — what came of a backend-built PolicyGeneration.
 *
 *   POLICY_GENERATION_SENT  claimed, request going out (or the process died)
 *   POLICY_ISSUED           Success with a policy number
 *   PAYMENT_PENDING         Success with Chola's payment page (PG_CHOLA)
 *   PAYMENT_FAILED          Chola refused it, or it was never sent — the only
 *                           state a deliberate re-attempt is allowed from
 *   NEEDS_REVIEW            outcome unknown (timeout, 5xx, Success without a
 *                           policy number) — Chola may have acted on it, so it
 *                           is reconciled with them, never re-sent
 */
const CHOLA_PROPOSAL_STATUS = {
  POLICY_GENERATION_SENT: 'POLICY_GENERATION_SENT',
  POLICY_ISSUED: 'POLICY_ISSUED',
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PAYMENT_FAILED: 'PAYMENT_FAILED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

// ── Freecharge (FCPG) ───────────────────────────────────────────────────────
//
// The gateway Chola collect premium through (services/cholaFreechargePayment
// .service.js). The request bodies are Chola's "Free Charge APIs" Postman
// collection; the status codes are FCPG's published table
// (https://www.freechargepg.in/developer/bank-codes).

/**
 * health_chola_freecharge_payments.status — what we know of one checkout.
 *
 *   INITIATED     encrypted and handed to the browser; no answer yet
 *   PENDING       FCPG say pending, or could not be asked
 *   SUCCESS       FCPG's txn/status said SPG-0000 for exactly this amount
 *   FAILED        FCPG said failed (or the checkout never left us)
 *   NEEDS_REVIEW  money may have moved but something does not add up (amount
 *                 or transaction mismatch, callback and status disagree) —
 *                 reconciled by a person, never issued automatically
 */
const CHOLA_FREECHARGE_STATUS = {
  INITIATED: 'INITIATED',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

/**
 * health_chola_freecharge_payments.issue_status — PolicyGeneration for a paid
 * checkout (PG_DIRECT, tagged with FCPG's txnReferenceId).
 *
 *   IN_PROGRESS    claimed; PolicyGeneration going out
 *   POLICY_ISSUED  Chola answered a policy number
 *   ISSUE_FAILED   Chola refused it, or it never left — ops may re-send
 *   NEEDS_REVIEW   outcome unknown; reconcile with Chola, never re-send
 */
const CHOLA_FREECHARGE_ISSUE_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  POLICY_ISSUED: 'POLICY_ISSUED',
  ISSUE_FAILED: 'ISSUE_FAILED',
  NEEDS_REVIEW: 'NEEDS_REVIEW',
};

const FREECHARGE_SUCCESS_CODE = 'SPG-0000';

// Every code FCPG's table marks PENDING. Anything else that is not SPG-0000 is
// FAILED by the same table.
const FREECHARGE_PENDING_CODES = new Set([
  'SPG-0002', // PENDING
  'SPG-0011', // Socket Timeout
  'SPG-0032', // Error while making HTTP call
  'SPG-0038', // Client error
  'SPG-0040', // SSL setup error
  'SPG-0136', // No Settlement for given transactionId
  'SPG-5000', // Internal server error
  'SPG-5001', // Duplicate PG response
  'SPG-5218', // Transaction Pending at Bank end
  'SPG-8000', // Payment authorisation pending
]);

// Codes FCPG's table marks FAILED that describe OUR REQUEST being refused, not
// the buyer's payment. On a status check they prove nothing about whether the
// money moved, so they are read as "not confirmed" rather than as a failed
// payment — a buyer told "failed" pays again.
const FREECHARGE_REQUEST_ERROR_CODES = new Set([
  'SPG-0003', // Invalid merchant id
  'SPG-0004', // Signature is absent in the request
  'SPG-0005', // Invalid signature
  'SPG-0006', // Invalid session/ Session expired
  'SPG-0008', // Error while validating request
  'SPG-0009', // Transaction declined because of expired key
  'SPG-0010', // Invalid request field[s]
  'SPG-0013', // Request data has been tampered with
  'SPG-0015', // Unable to process request
  'SPG-0023', // Unable to process request
  'SPG-0030', // Invalid combination of txn reference id & merchant txn
  'SPG-0041', // Merchant not authorised for the API
  'SPG-0044', // Merchant Id in request does not match that of in pay request
  'SPG-0057', // Invalid argument
  'SPG-0071', // Invalid data type
  'SPG-0092', // Provide valid data
  'SPG-0155', // Invalid timestamp field value
  'SPG-0180', // Unable to process data
  'SPG-0230', // Invalid combination of txn reference id & merchant txn id
  'SPG-4000', // Bad request
  'SPG-4001', // Merchant Id does not match that of transaction
  'SPG-4204', // Error while Json processing
]);

// The return page's name on every frontend this backend serves (the new site
// keeps the old app's route under its health base).
const CHOLA_RETURN_PAGE = '/chola-return';

export {
  CHOLA_PRODUCTS,
  CHOLA_DEFAULT_PRODUCT,
  CHOLA_OPERATIONS,
  CHOLA_PROVIDER,
  CHOLA_API_NAMES,
  CHOLA_PAYMENT_MODES,
  CHOLA_POLICY_GENERATION_FIELDS,
  CHOLA_PG_BANK_CODE,
  CHOLA_PROPOSAL_STATUS,
  CHOLA_FREECHARGE_STATUS,
  CHOLA_FREECHARGE_ISSUE_STATUS,
  FREECHARGE_SUCCESS_CODE,
  FREECHARGE_PENDING_CODES,
  FREECHARGE_REQUEST_ERROR_CODES,
  CHOLA_RETURN_PAGE,
};
