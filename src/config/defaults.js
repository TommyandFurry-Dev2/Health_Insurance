// ─────────────────────────────────────────────────────────────────────────────
// Bundled fallbacks — the ONLY place in this codebase where a NivaBupa URL,
// credential, key or channel constant appears as a literal.
//
// Nothing outside this file reads a literal endpoint or secret: every module
// goes through config/env.js, which resolves `process.env.X || DEFAULTS.x`. So
// moving UAT → production is `.env` changes and nothing else.
//
// Why the fallbacks exist at all, rather than requiring every variable:
// this is inherited behaviour from the working implementation and removing it
// would change it. Production's `.env` is gitignored and the deploy pipeline
// never edits it, so a newly-added variable silently never reaches production —
// falling back to the known-good UAT value means a plain deploy keeps serving
// instead of erroring on a variable nobody knew to add. `process.env` always
// wins when it is set.
//
// ⚠️ These are UAT values. A production deployment MUST override every entry
// under `nivabupa` in its own `.env` — otherwise it will quietly transact
// against UAT. config/validate.js prints a warning at boot naming every value
// that came from this table instead of the environment, and refuses to start
// when NODE_ENV=production leaves a production-critical one unset.
//
// The two deliberate exceptions with NO fallback are caseApi.userId and
// caseApi.clientId: NivaBupa ship no sample values for those
// (24_PROPOSAL_STATUS_POLICY_DOWNLOAD.txt labels them "Partner specific to be
// shared separately on mail"), so they fail loudly rather than sending
// "undefined" credentials.
// ─────────────────────────────────────────────────────────────────────────────

// Values that must differ between UAT and production. Every one of these is
// listed in config/validate.js's PRODUCTION_REQUIRED set.
export const NIVABUPA_UAT_DEFAULTS = {
  // OAuth client_credentials pair for the /api/generic/* family
  // (token / premium / uwDecision / datapush).
  clientId: 'cdceaca20073415586ed9e28c7337ae1',
  clientSecret: 'idcscs-91476a29-94d2-494f-bbb4-990c28984050',
  identifierCode: 'BR08860001',
  tokenUrl: 'https://digitaluat.nivabupa.com/api/generic/token',
  scope: 'https://uat.nbhi.ohi.ocs.oraclecloud.com/uat/urn::ohi-components-apis',

  premiumUrl: 'https://digitaluat.nivabupa.com/api/generic/premium',
  uwDecisionUrl: 'https://digitaluat.nivabupa.com/api/generic/uwDecision',
  dataPushUrl: 'https://digitaluat.nivabupa.com/api/generic/datapush',

  // Case API (Proposal Status / Policy Download) — different host prefix
  // (/caseapi/), different credential pair, token goes in an `access_token`
  // header rather than `Authorization`.
  caseApiTokenUrl: 'https://digitaluat.nivabupa.com/caseapi/api/auth/v1/getauthtoken',
  proposalStatusUrl: 'https://digitaluat.nivabupa.com/caseapi/api/common/getpreissuancestatus',
  policyDownloadUrl: 'https://digitaluat.nivabupa.com/caseapi/api/document/getalldocument',

  // Payment — Juspay-backed gateway page plus the WCF SOAP service that
  // encrypts the outbound querystring and decrypts the return callback.
  paymentGatewayUrl: 'https://paymbhid.nivabupa.com/Pages/getPaymentValues.aspx',
  soapUrl: 'https://uat-transactions.nivabupa.com/websiteService/Service1.svc',
  paymentEncryptionKey: 'nivabupauat@(!!*()@',
  // "!max#bupa@" confirmed working 2026-07-28 by direct test — cleanly
  // decrypted a real returnMessage (sourcingsystem=TOMMYANDFURRY, the old
  // value). NivaBupa support's "!max#bupaNovacred@" (for sourcingsystem=
  // Novacred) has NOT decrypted anything successfully in testing.
  paymentDecryptionKey: '!max#bupa@',
};

// ─────────────────────────────────────────────────────────────────────────────
// IFFCO Tokio (ITGI) — Partner Health.
//
// Deliberately NOT symmetrical with NIVABUPA_UAT_DEFAULTS above: there is no
// host, no credential, no partner code here, and there must never be one.
//
// The NivaBupa table holds UAT values because that behaviour was inherited from
// a working deployment and removing it would change it (see its own note). ITGI
// arrives new, so it starts with the property that table cannot have: nothing
// in this codebase knows an ITGI hostname. A process without ITGI_BASE_URL,
// ITGI_USERNAME, ITGI_PASSWORD and ITGI_PARTNER_CODE cannot reach ITGI at all —
// the endpoints answer 503 naming the missing variables instead of quietly
// transacting against staging, which is what a bundled default would do the
// first time somebody deployed without setting them.
//
// What IS here is the API contract: the request paths appended to the base URL.
// Those are identical in UAT and production — they are what the endpoints are
// CALLED, not where they live — so they are not environment configuration. They
// stay overridable all the same (ITGI_*_PATH), so a path change on ITGI's side
// is still a .env edit rather than a release.
// ─────────────────────────────────────────────────────────────────────────────
export const ITGI_DEFAULTS = {
  // Appended to ITGI_BASE_URL. Verified against ITGI_PARTNER_HEALTH_KIT v3.5
  // (health) and Partner CKYC Kit v1.4.1 (kyc).
  paths: {
    premium: '/partner-services/health/premium',
    proposal: '/partner-services/health/proposal',
    // The hosted gateway page the buyer's browser is POSTed to. Not called
    // server-to-server — ITGI return the same URL on the proposal response as
    // `itgiPaymentUrl`, and that value is preferred over this one.
    paymentInitiate: '/partner-services/transaction/initiate',
    paymentConfirmation: '/partner-services/payment/confirmation',
    policyDownload: '/partner-services/policy/download',
    // CKYC. Only source of `itgiKYCReferenceNo`, which every proposal needs.
    kycFetch: '/partner-services/kyc/fetch',
    kycCreate: '/partner-services/kyc/create',
  },

  // FHP (family floater, one policy-level sum insured) or IHP (individual, one
  // sum insured per member). Applied when a caller sends no contractType.
  contractType: 'FHP',

  // Every ITGI route lives under this prefix. Not env-driven, for the same
  // reason APP_DEFAULTS.pathPrefix is not: it is baked into the route table
  // (routes/itgi.routes.js) AND it is the tail of the response URL registered
  // with ITGI against our partner code — an env var here could change neither.
  pathPrefix: '/iffcotokio',

  // SPA route the payment return redirects to, appended to FRONTEND_URL.
  frontendReturnPath: '/iffcotokio-return',

  // CKYC create carries base64 document uploads (PAN/address proof/photograph),
  // which do not fit the 100kb express.json default the NivaBupa router uses.
  jsonBodyLimit: '6mb',

  // Retries on transport failures and 502/503/504 only — never on a 200 that
  // carried a validation error[], which would just repeat the rejection.
  maxRetries: 2,
};

// Novacred's own channel identity on every UW Decision / Data Push request
// (NivaBupa's observations on our payload, 2026-08-07). Not per-buyer data —
// there is no form field or API response any of them could come from.
//
// NivaBupa could reassign the branch/agent codes per partner, so all three are
// env-overridable; the values here are authoritative until they do.
export const PROPOSAL_DEFAULTS = {
  // POLICY.POLICY_OTHER_DETAILS.LOGIN_BRANCH_CODE / NOC_BRANCH_CODE — both were
  // going out null.
  loginBranchCode: '511101',
  nocBranchCode: '511101',
  // POLICY.SOURCING_INFO.AGENT_INFO.AGENT_CODE — was null. Same value as the
  // OAuth Identifier_code (NIVABUPA_IDENTIFIER_CODE).
  agentCode: 'BR08860001',
  // POLICY.PAYMENT_INFO.PAYMENT_COLLECT_MODE — was ''. "OL" = collected online,
  // which every payment through the Juspay gateway is.
  paymentCollectMode: 'OL',
  // POLICY.PAYMENT_INFO.PAYMENT_RECEIVED_FLAG — was 'N'. Data Push only runs
  // after a SUCCESS callback, so the money is always in by then.
  paymentReceivedFlag: 'Y',
};

// Applied to every payment/initiate request before the caller's own body is
// spread over them. Gateway-contract values, not per-buyer data.
export const PAYMENT_DEFAULTS_VALUES = {
  paymentType: 'mxbpofflinewithoutemi',
  isjuspay: 'yes',
};

// Per-attempt HTTP budgets, milliseconds.
export const TIMEOUT_DEFAULTS = {
  token: 15000,
  api: 20000,
  soap: 20000,
  // Data Push gets its own, much longer budget. 20s is fine for Premium and
  // UW, which compute and answer; Data Push writes a proposal and, when
  // underwriting comes back NSTP, hands it to a manual workflow — measured
  // live on 2026-08-06 as still not answering at 20s, which aborted the call
  // with no idea whether the proposal had been created.
  //
  // That ambiguity is the expensive failure here: payment has already been
  // taken by the time this runs, so giving up early risks money moving
  // against a policy nobody can account for. Waiting is strictly better than
  // guessing.
  //
  // Kept under the frontend's own 60s axios timeout (nivabupaClient.js) so
  // this server is what gives up first and can report why, rather than the
  // browser cutting a live request and leaving no server-side record.
  dataPush: 55000,

  // ── IFFCO Tokio ──
  // Premium and proposal answer in ~1s on staging, but the same host has been
  // seen taking far longer under load, and a proposal that times out has an
  // unknown outcome (an orderNo may exist). 60s rather than 20s.
  itgi: 60000,
  // CKYC create is the outlier: measured at 44 SECONDS on ITGI staging
  // (2026-08-25, the run that returned IURN UVXPSRBNIFZ2JK) against ~1s for
  // every health call. It writes to CERSAI through ITGI, and a timeout costs
  // the customer their document uploads, so it gets triple the health budget.
  itgiCkycCreate: 120000,
};

// Ours, not NivaBupa's — see config/env.js for why each default is what it is.
export const APP_DEFAULTS = {
  port: 4000,
  devFrontendUrl: 'http://localhost:5173',
  prodFrontendUrl: 'https://insurance.tommyandfurry.com',
  // Where handlePaymentReturn 302s the buyer after decrypting the callback.
  frontendReturnPath: '/nivabupa-return',
  // The public URL registered with NivaBupa as `returnPath`.
  prodPaymentReturnUrl: 'https://ondc.healthinsurance.tommyandfurry.com/health/nivabupa/payment/return',
  // Every NivaBupa route lives under this prefix.
  pathPrefix: '/nivabupa',
  // Compatibility alias: the ONDC backend served every route under /health too,
  // so a deployed frontend build whose base URL still ends in /health keeps
  // working without a rebuild. Empty string disables the alias.
  aliasPrefix: '/health',
  corsOrigins: '*',
};

// MySQL — the journey tables live in the host Laravel application's schema
// (policy_db), which owns the `users` table journeys attach to.
export const DB_DEFAULTS = {
  connection: 'mysql',
  host: '127.0.0.1',
  port: 3306,
  database: 'policy_db',
  username: 'root',
  poolSize: 10,
  connectTimeoutMs: 10000,
};

export const JOURNEY_DEFAULTS = {
  // How long a broken journey stays resumable. 7 days: long enough to cover
  // a buyer who abandons at payment and comes back the following weekend,
  // short enough that stale quotes (whose premium is only valid for the
  // premiumCalculationDate sent upstream) are not silently resumed months
  // later at a price NivaBupa would no longer honour.
  ttlDays: 7,
  // Journeys idle longer than this are swept to ABANDONED by the sweeper so
  // funnel reporting distinguishes "still deciding" from "gone".
  abandonAfterHours: 48,
  sweepIntervalMinutes: 60,
};
