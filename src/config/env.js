// ─────────────────────────────────────────────────────────────────────────────
// The single configuration object. Every module in this service reads from
// here; none of them touch process.env directly and none of them contain a
// literal URL, credential or key. The fallbacks live in ./defaults.js.
//
// UAT → production is therefore a `.env` change and nothing else. See
// .env.example for the complete variable list and README.md for which of them
// must change for production.
//
// ── Env loading ─────────────────────────────────────────────────────────────
// dotenv is loaded here, at the root of the config tree, so every entrypoint
// (server, migrate, smoke scripts) gets the same environment simply by
// importing config. dotenv never overwrites a variable that is already set, so
// a real deployment that injects config through the process environment
// (systemd, pm2 ecosystem file, Docker, Kubernetes) is unaffected by the
// presence or absence of a .env file.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';

import {
  NIVABUPA_UAT_DEFAULTS as NB,
  ITGI_DEFAULTS as IT,
  FG_DEFAULTS as FG,
  ICICI_DEFAULTS as IL,
  PROPOSAL_DEFAULTS,
  PAYMENT_DEFAULTS_VALUES,
  TIMEOUT_DEFAULTS,
  APP_DEFAULTS,
  DB_DEFAULTS,
  JOURNEY_DEFAULTS,
} from './defaults.js';

dotenv.config();

// Records which keys fell back to defaults.js instead of coming from the
// environment, so config/validate.js can report them at boot without this file
// needing to know anything about validation. Never holds a value — only a name.
const usedFallbacks = new Set();

// `process.env.NAME || fallback`, with two differences that matter:
//   * an empty string counts as unset (a blank line in .env is not a value)
//   * the fallback is recorded, so boot can say what was not configured
function envOr(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== '') return value;
  usedFallbacks.add(name);
  return fallback;
}

function numberEnvOr(name, fallback) {
  const value = process.env[name];
  if (value !== undefined && value !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
    console.warn(`⚠️  ${name}="${value}" is not a number — using ${fallback}.`);
  }
  usedFallbacks.add(name);
  return fallback;
}

// Read a boolean. Accepts the spellings an operator actually types in a .env
// rather than only "true", and — unlike the `=== '1'` debug flags above — takes
// a default, because two of the Future Generali switches default to ON.
function boolEnvOr(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') {
    usedFallbacks.add(name);
    return fallback;
  }
  return ['true', '1', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

// DB_* are the variable names this service has always used and they stay
// authoritative so an existing .env keeps working unchanged. NIVABUPA_DB_* is
// accepted as a higher-precedence alias: `DB_HOST` is generic enough to collide
// with something else on a shared host, and the prefixed form makes it
// unambiguous which database is meant.
const dbEnv = (suffix, fallback) => {
  const prefixed = process.env[`NIVABUPA_DB_${suffix}`];
  if (prefixed !== undefined && prefixed !== '') return prefixed;
  const plain = process.env[`DB_${suffix}`];
  if (plain !== undefined && plain !== '') return plain;
  usedFallbacks.add(`DB_${suffix}`);
  return fallback;
};

// Password is read separately: '' is a legitimate value (the supplied local
// MySQL root account has no password), so an empty string must not fall through
// to the next source the way it does for a host or a database name.
const dbPassword = () => {
  if (process.env.NIVABUPA_DB_PASSWORD !== undefined) return process.env.NIVABUPA_DB_PASSWORD;
  if (process.env.DB_PASSWORD !== undefined) return process.env.DB_PASSWORD;
  usedFallbacks.add('DB_PASSWORD');
  return '';
};

// Read with NO fallback and NO fallback record: used for values that have no
// bundled default anywhere in this codebase (the two Case API credentials, and
// every environment-dependent IFFCO Tokio and Future Generali value). An empty
// string is unset — a blank line in .env is not a credential.
//
// The difference from envOr() matters: envOr records the name so the boot report
// can say "this came from defaults.js". These have no default to come from, so
// what the report needs to say is "this is missing", which it derives from the
// value being undefined rather than from the fallback set.
function requiredEnv(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

// Trailing slash removed once, here, so no caller has to remember: every ITGI
// URL is built as `${baseUrl}${path}` and `.../ ` + `/partner-services/...`
// would produce a double slash that ITGI's gateway answers 404 to.
function trimTrailingSlash(value) {
  return typeof value === 'string' ? value.replace(/\/+$/, '') : value;
}

// Strict equality, deliberately not `(process.env.NODE_ENV || 'development')`
// like config.env below. The two failure modes are not symmetric: a deployment
// with NODE_ENV unset or empty would take that default and start handing real
// buyers localhost URLs — money moves and they land nowhere. A local run
// without NODE_ENV set merely gets the deployed defaults, which is visible
// immediately. .env sets NODE_ENV explicitly for exactly this reason.
const isDevelopment = process.env.NODE_ENV === 'development';
const localPort = numberEnvOr('PORT', APP_DEFAULTS.port);

const config = {
  env: process.env.NODE_ENV || 'development',
  isDevelopment,
  port: localPort,

  // Where handlePaymentReturn 302s the buyer's browser after decrypting the
  // gateway callback — the frontend origin that hosts the return page.
  //
  // FRONTEND_URL always wins; NODE_ENV only picks the default, so a local run
  // lands on the Vite dev server instead of the deployed site. A deployed
  // instance without FRONTEND_URL set must not send real buyers to a localhost
  // page on their own machine, which is why the default is environment-aware.
  frontendUrl: process.env.FRONTEND_URL
    || (isDevelopment ? APP_DEFAULTS.devFrontendUrl : APP_DEFAULTS.prodFrontendUrl),

  // Path on the frontend the payment callback redirects to, appended to
  // frontendUrl with the payment outcome as a query string.
  frontendReturnPath: envOr('FRONTEND_RETURN_PATH', APP_DEFAULTS.frontendReturnPath),

  // Comma-separated list, or '*' for any origin. The journey endpoints use
  // PATCH/PUT, so any allow-list here must not be narrower than the methods
  // the SPA actually sends.
  corsOrigins: process.env.NIVABUPA_CORS_ORIGINS || process.env.CORS_ORIGINS || APP_DEFAULTS.corsOrigins,

  // Every NivaBupa route is mounted under this prefix, and so is all of the
  // module's middleware.
  //
  // Deliberately NOT env-driven. It is the API contract the frontend is built
  // against — identical in UAT and production — and it is baked into the route
  // tables (routes/*.routes.js) and the journey-path regex in
  // middleware/journeyContext.js. An env var here could not change those, so it
  // would be a setting that silently does nothing.
  pathPrefix: APP_DEFAULTS.pathPrefix,
  // Second mount point serving the identical router. Set to an empty string to
  // disable. Unlike pathPrefix this is a real mount-time choice (app.js mounts
  // the same router twice), so it is env-driven. Exists because a deployed
  // frontend build may still have a base URL ending in /health.
  aliasPrefix: process.env.NIVABUPA_ALIAS_PREFIX !== undefined
    ? process.env.NIVABUPA_ALIAS_PREFIX
    : APP_DEFAULTS.aliasPrefix,

  // Express `trust proxy`. Off by default, which is the behaviour this code has
  // always had. Turn it on (`1`, or a subnet/hop count Express understands)
  // when running behind nginx/ELB so req.ip is the buyer's address rather than
  // the proxy's — req.ip is recorded on journey events and the payment callback.
  trustProxy: process.env.TRUST_PROXY ?? null,

  // MySQL — backs the journey break / resume feature.
  db: {
    connection: dbEnv('CONNECTION', DB_DEFAULTS.connection),
    host: dbEnv('HOST', DB_DEFAULTS.host),
    port: Number(dbEnv('PORT', DB_DEFAULTS.port)),
    database: dbEnv('DATABASE', DB_DEFAULTS.database),
    user: dbEnv('USERNAME', DB_DEFAULTS.username),
    // Intentionally allows '' — the supplied local MySQL root account has no
    // password, and `|| ''` would turn a deliberately-set password of '0' into
    // '' anyway, so read it as-is and only default when truly undefined.
    password: dbPassword(),
    connectionLimit: Number(dbEnv('POOL_SIZE', DB_DEFAULTS.poolSize)),
    // A journey save must never hang a request behind a saturated pool; fail
    // fast and let the controller answer the caller (see db/index.js — a save
    // failure is logged, not thrown at the buyer).
    connectTimeout: Number(dbEnv('CONNECT_TIMEOUT_MS', DB_DEFAULTS.connectTimeoutMs)),
  },

  journey: {
    ttlDays: numberEnvOr('JOURNEY_TTL_DAYS', JOURNEY_DEFAULTS.ttlDays),
    abandonAfterHours: numberEnvOr('JOURNEY_ABANDON_AFTER_HOURS', JOURNEY_DEFAULTS.abandonAfterHours),
    sweepIntervalMinutes: numberEnvOr('JOURNEY_SWEEP_INTERVAL_MINUTES', JOURNEY_DEFAULTS.sweepIntervalMinutes),
  },

  nivabupa: {
    // Dumps the full upstream request/response for every /api/generic/* call to
    // stdout. Off unless explicitly set: these bodies carry PII (PAN, DOB,
    // medical answers) and pm2 keeps stdout on disk indefinitely, so this is a
    // deliberate, temporary diagnostic rather than a default.
    //
    // Failures are logged in full regardless of this flag — see
    // services/genericApi.service.js. api_transactions already persists both
    // outcomes; this exists so a live call can be watched in `pm2 logs` without
    // a database round-trip.
    debug: process.env.NIVABUPA_DEBUG === '1',

    clientId: envOr('NIVABUPA_CLIENT_ID', NB.clientId),
    clientSecret: envOr('NIVABUPA_CLIENT_SECRET', NB.clientSecret),
    identifierCode: envOr('NIVABUPA_IDENTIFIER_CODE', NB.identifierCode),
    tokenUrl: envOr('NIVABUPA_TOKEN_URL', NB.tokenUrl),
    scope: envOr('NIVABUPA_SCOPE', NB.scope),

    premiumUrl: envOr('NIVABUPA_PREMIUM_URL', NB.premiumUrl),
    uwDecisionUrl: envOr('NIVABUPA_UW_DECISION_URL', NB.uwDecisionUrl),
    dataPushUrl: envOr('NIVABUPA_DATAPUSH_URL', NB.dataPushUrl),

    caseApi: {
      tokenUrl: envOr('NIVABUPA_CASEAPI_TOKEN_URL', NB.caseApiTokenUrl),
      // No fallback by design — NivaBupa ship no sample values for these two.
      // caseApiAuth.service.js throws a named error rather than sending
      // "undefined" credentials, and config/validate.js reports them at boot.
      userId: process.env.NIVABUPA_CASEAPI_USER_ID,
      clientId: process.env.NIVABUPA_CASEAPI_CLIENT_ID,
      proposalStatusUrl: envOr('NIVABUPA_PROPOSAL_STATUS_URL', NB.proposalStatusUrl),
      policyDownloadUrl: envOr('NIVABUPA_POLICY_DOWNLOAD_URL', NB.policyDownloadUrl),
    },

    payment: {
      gatewayUrl: envOr('NIVABUPA_PAYMENT_GATEWAY_URL', NB.paymentGatewayUrl),
      // Unlike the URLs above (NivaBupa-hosted), this one is ours — where the
      // gateway sends the buyer once payment completes.
      //
      // The gateway returns the buyer by auto-submitting a form POST from their
      // browser, which is why handlePaymentReturn answers with a 302 into the
      // SPA rather than JSON, and why a localhost address is reachable when the
      // buyer's browser is on that same machine. So the default follows the
      // environment: local runs keep the whole round-trip on this machine,
      // deployments keep the registered public URL.
      //
      // ⚠️ The value is also registered with NivaBupa, and their gateway may
      // validate returnPath against what they hold. If a local payment is
      // rejected at the gateway rather than returning here, that is why — you
      // need a publicly reachable URL they have registered (a tunnel, or the
      // deployed backend) instead of localhost.
      returnUrl: process.env.NIVABUPA_PAYMENT_RETURN_URL
        || (isDevelopment
          ? `http://localhost:${localPort}${APP_DEFAULTS.pathPrefix}/payment/return`
          : APP_DEFAULTS.prodPaymentReturnUrl),
      soapUrl: envOr('NIVABUPA_SOAP_URL', NB.soapUrl),
      encryptionKey: envOr('NIVABUPA_PAYMENT_ENCRYPTION_KEY', NB.paymentEncryptionKey),
      decryptionKey: envOr('NIVABUPA_PAYMENT_DECRYPTION_KEY', NB.paymentDecryptionKey),
      // Gateway-contract constants applied to every payment/initiate body
      // before the caller's own fields are spread over them.
      defaults: {
        paymentType: envOr('NIVABUPA_PAYMENT_TYPE', PAYMENT_DEFAULTS_VALUES.paymentType),
        isjuspay: envOr('NIVABUPA_PAYMENT_ISJUSPAY', PAYMENT_DEFAULTS_VALUES.isjuspay),
      },
    },

    // Channel identity asserted on every UW Decision / Data Push payload.
    proposal: {
      loginBranchCode: envOr('NIVABUPA_LOGIN_BRANCH_CODE', PROPOSAL_DEFAULTS.loginBranchCode),
      nocBranchCode: envOr('NIVABUPA_NOC_BRANCH_CODE', PROPOSAL_DEFAULTS.nocBranchCode),
      agentCode: envOr('NIVABUPA_AGENT_CODE', PROPOSAL_DEFAULTS.agentCode),
      paymentCollectMode: envOr('NIVABUPA_PAYMENT_COLLECT_MODE', PROPOSAL_DEFAULTS.paymentCollectMode),
      paymentReceivedFlag: envOr('NIVABUPA_PAYMENT_RECEIVED_FLAG', PROPOSAL_DEFAULTS.paymentReceivedFlag),
    },
  },

  // ── IFFCO Tokio (ITGI) — Partner Health ────────────────────────────────────
  //
  // Every environment-dependent value below is read from the environment ONLY.
  // There is no bundled host, credential or partner code (see the ITGI note in
  // defaults.js for why this differs from `nivabupa` above), so:
  //
  //   * UAT      → set ITGI_BASE_URL to the staging host + the UAT credentials
  //   * PROD     → change those same four variables, nothing else
  //   * unset    → the /iffcotokio endpoints answer 503 naming what is missing,
  //                and nothing else in this service is affected
  //
  // Nothing here is reachable from the NivaBupa flow and nothing in the
  // NivaBupa flow reads it.
  itgi: {
    // Dumps the full upstream request/response of every ITGI call to stdout.
    // Off unless set: proposal and CKYC bodies carry PAN, Aadhaar, DOB, medical
    // answers and base64 document scans. Failures are logged regardless.
    debug: process.env.ITGI_DEBUG === '1',

    // The four that decide which ITGI environment this process talks to.
    baseUrl: trimTrailingSlash(requiredEnv('ITGI_BASE_URL')),
    username: requiredEnv('ITGI_USERNAME'),
    password: requiredEnv('ITGI_PASSWORD'),
    // Sent as partnerDetail.partnerCode on every request, and the key ITGI hold
    // our registered payment response URL against.
    partnerCode: requiredEnv('ITGI_PARTNER_CODE'),

    // Request paths appended to baseUrl. The API contract, identical in UAT and
    // production — overridable only so an ITGI-side path change stays a .env
    // edit. See defaults.js.
    paths: {
      premium: envOr('ITGI_PREMIUM_PATH', IT.paths.premium),
      proposal: envOr('ITGI_PROPOSAL_PATH', IT.paths.proposal),
      paymentInitiate: envOr('ITGI_PAYMENT_INITIATE_PATH', IT.paths.paymentInitiate),
      paymentConfirmation: envOr('ITGI_PAYMENT_CONFIRMATION_PATH', IT.paths.paymentConfirmation),
      policyDownload: envOr('ITGI_POLICY_DOWNLOAD_PATH', IT.paths.policyDownload),
      kycFetch: envOr('ITGI_KYC_FETCH_PATH', IT.paths.kycFetch),
      kycCreate: envOr('ITGI_KYC_CREATE_PATH', IT.paths.kycCreate),
    },

    defaultContractType: envOr('ITGI_CONTRACT_TYPE', IT.contractType),
    maxRetries: numberEnvOr('ITGI_MAX_RETRIES', IT.maxRetries),
    jsonBodyLimit: envOr('ITGI_JSON_BODY_LIMIT', IT.jsonBodyLimit),

    // Where the buyer's browser is sent to pay. ITGI return this URL on the
    // proposal response as `itgiPaymentUrl` and THAT value is what the buyer is
    // handed; this is only the fallback used when a caller asks this service to
    // rebuild a payment form from an orderNo it no longer has the response for.
    // Left null so it derives from baseUrl + paths.paymentInitiate — set
    // ITGI_PAYMENT_GATEWAY_URL only if ITGI host the gateway somewhere else.
    paymentGatewayUrl: trimTrailingSlash(requiredEnv('ITGI_PAYMENT_GATEWAY_URL')) || null,

    // OURS, not ITGI's: the URL ITGI redirect the buyer back to after payment,
    // registered on THEIR side against our partner code. This service never
    // sends it anywhere — it is here so the boot report can show which URL this
    // deployment believes is registered, because a mismatch between it and the
    // route this process actually serves is invisible until a real payment
    // lands on a 404 and the policy number is lost.
    returnUrl: requiredEnv('ITGI_PAYMENT_RETURN_URL') || null,

    // SPA route the payment return handler 302s the buyer to, appended to
    // FRONTEND_URL with the outcome as a query string.
    frontendReturnPath: envOr('ITGI_FRONTEND_RETURN_PATH', IT.frontendReturnPath),

    // Falls back to the NivaBupa/global list so one origin allow-list covers
    // the whole service; set ITGI_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.ITGI_CORS_ORIGINS
      || process.env.NIVABUPA_CORS_ORIGINS
      || process.env.CORS_ORIGINS
      || APP_DEFAULTS.corsOrigins,
  },

  // ── Future Generali (FG) — TCS BO health service ───────────────────────────
  //
  // Configured the IFFCO Tokio way, not the NivaBupa way: every
  // environment-dependent value below is read from the environment ONLY, with
  // no bundled host, credential, partner code or gateway URL anywhere in this
  // codebase (see the FG note in defaults.js). So:
  //
  //   * UAT    → set FG_BO_BASE_URL and the UAT vendor/agent/branch codes
  //   * PROD   → change those same variables, nothing else
  //   * unset  → the /future-generali endpoints answer 503 naming what is
  //              missing, and neither NivaBupa nor IFFCO Tokio is affected
  //
  // Nothing here is reachable from the NivaBupa or IFFCO Tokio flows, and
  // nothing in either of those reads it.
  fg: {
    // Dumps the full upstream request/response of every FG call to stdout. Off
    // unless set: the <Root> payload carries PAN, Aadhaar, DOB, height/weight
    // and nominee detail in the clear. Failures are logged regardless.
    debug: process.env.FG_DEBUG === '1',

    // ── The four without which no FG call can be made ──
    //
    // FG's BO service is published over http, NOT https, on the UAT host: the
    // WSDL's sole port is BasicHttpBinding_IService with
    // <soap:address location="http://…/BO/Service.svc"/> and no transport
    // security bound. The same host answers a POST over https with a zero-byte
    // 404, because nothing is listening for it there. That is FG's binding, not
    // a preference of ours — set this to https the day FG publish an https one
    // (production may already have it).
    boBaseUrl: trimTrailingSlash(requiredEnv('FG_BO_BASE_URL')),
    vendorCode: requiredEnv('FG_VENDOR_CODE'),
    agentCode: requiredEnv('FG_AGENT_CODE'),
    branchCode: requiredEnv('FG_BRANCH_CODE'),

    // Sent as <VendorUserId>. FG issue it alongside the vendor code; their own
    // samples repeat the vendor code here, so it falls back to that rather than
    // going out empty.
    vendorUserId: requiredEnv('FG_VENDOR_USER_ID') || requiredEnv('FG_VENDOR_CODE') || null,

    // The policy-document service is a DIFFERENT WCF endpoint (contract
    // IService1) that DOES answer over https, so it can legitimately be pointed
    // somewhere the BO service is not. Falls back to the BO host.
    pdfBaseUrl: trimTrailingSlash(requiredEnv('FG_PDF_BASE_URL'))
      || trimTrailingSlash(requiredEnv('FG_BO_BASE_URL')),

    // Service paths appended to the base URLs, and the SOAP namespace. The API
    // contract, identical in UAT and production — overridable only so an
    // FG-side path change stays a .env edit. See defaults.js.
    paths: {
      boService: envOr('FG_BO_SERVICE_PATH', FG.paths.boService),
      pdfService: envOr('FG_PDF_SERVICE_PATH', FG.paths.pdfService),
    },
    soapTempuri: envOr('FG_SOAP_TEMPURI', FG.soapTempuri),

    // ⚠️ REQUIRED by HealthPreCRTValidate and by issuance; quoting works
    // without it. Both fail with "BancaChannel Value INVALID" until it is
    // correct, and the valid code is NOT in the integration kit and cannot be
    // derived — FG must issue it for the configured vendor code. Overridable
    // per request via risk.bancaChannel.
    bancaChannel: requiredEnv('FG_BANCA_CHANNEL') || null,

    // ── UAT TEST SWITCH — leave OFF outside a deliberate experiment ──
    // When on, CRT calls always send an EMPTY <ClientID>, even after FG answer
    // "Please retry with Client ID <n>". Exists to test whether the proposal
    // flow completes on the empty-ClientID path. Nothing else about the request
    // changes. OFF by default, so the shipped behaviour is FG's documented
    // handshake.
    suppressClientIdOnCrt: boolEnvOr('FG_SUPPRESS_CLIENT_ID_ON_CRT', false),

    // Receipt date format — see FG_DEFAULTS.receiptDateWithTime.
    receiptDateWithTime: boolEnvOr('FG_RECEIPT_DATE_WITH_TIME', FG.receiptDateWithTime),

    payment: {
      // Where the buyer's browser is POSTed to pay.
      //
      // ONE variable, no default, and deliberately not a UAT/production pair
      // with a boolean between them: a build must not be one unset flag away
      // from taking real money on a test tenant, or from sending a live buyer
      // to UAT. Whatever is in .env is the only gateway this process can reach.
      gatewayUrl: requiredEnv('FG_PAYMENT_GATEWAY_URL') || null,

      // OURS, not FG's: the ResponseURL posted to their gateway on every
      // payment, which FG then POST the (encrypted) outcome back to. Unlike
      // ITGI's equivalent this one IS sent on every request rather than
      // registered on their side — so it must be reachable from FG's servers,
      // and it must point at THIS service's callback route, never at the SPA
      // (a static page cannot read a POST body).
      returnUrl: requiredEnv('FG_PAYMENT_RETURN_URL') || null,

      // Response encryption (v1.30, revised v1.35). Single DES, expressed as
      // 3DES with the key repeated — see helpers/fgPayment.helper.js. NO
      // bundled default: these are credentials, and .env.example documents the
      // values FG publish for them.
      cryptoKey: requiredEnv('FG_PG_CRYPTO_KEY') || null,
      cryptoIv: requiredEnv('FG_PG_CRYPTO_IV') || null,

      // ── Transaction revalidation (FG's Common Reconciliation Service) ─────
      //
      // ⚠️ THIS IS A SECURITY CONTROL, not a reconciliation nicety, and FG say
      // so themselves in NewPaymentIntegration v1.39:
      //
      //   "As a recommended security measure, you validate each transaction
      //    response via an API call. Transaction revalidation protects from
      //    request/response tampering possible in browser calls."
      //
      // The reason it matters here is specific. The payment outcome arrives as
      // a form POST to a PUBLIC callback route, and the DES key that "protects"
      // it is printed in FG's own integration PDF — the same key for every
      // partner. So the ciphertext authenticates nothing: anyone holding the kit
      // can encrypt Response=Success for a TransactionID and post it. Without
      // revalidation, the only thing standing between that and a free policy is
      // that this service issues solely for a TransactionID it is holding a
      // proposal against — which a buyer who started a payment and abandoned it
      // has.
      //
      // Calling FG server-to-server closes it: their answer is the one thing an
      // attacker cannot forge.
      //
      // No default URL — the live service host belongs in .env like every other
      // FG endpoint. Unset means revalidation is skipped and a loud warning is
      // logged at boot and on every issuance.
      reconcileUrl: requiredEnv('FG_RECONCILE_URL') || null,
      // <source> on the request. A protocol constant: FG's own example sends
      // "webaggregator" (the alternative, "Quickpay", is their retail channel).
      reconcileSource: envOr('FG_RECONCILE_SOURCE', FG.reconcileSource),
      // How much the reconciled amount may differ from the amount collected
      // before it is treated as tampering rather than rounding. FG return the
      // gateway's own figure, which can be a rupee off a paise-level premium.
      reconcileAmountTolerance: numberEnvOr(
        'FG_RECONCILE_AMOUNT_TOLERANCE', FG.reconcileAmountTolerance
      ),

      // Gateway identity issued by FG. 'NA' is FG's own documented value for a
      // partner they have issued none to — but these go INTO the CheckSum, so a
      // partner who was issued real ones and left them unset gets a checksum FG
      // reject. config/validate.js names them at boot when they fall back.
      userIdentifier: envOr('FG_PG_USER_IDENTIFIER', FG.paymentUserIdentifier),
      userId: envOr('FG_PG_USER_ID', FG.paymentUserId),

      // "Vendor Type" — v1.39's request table: "Blank[.Net] or 0[.Net] or
      // 1[PHP]". It declares which reference implementation produced the
      // CheckSum, not who we are, and it is optional.
      //
      // It does NOT switch the response format, though the document's layout
      // invites that reading. The only Response section is unconditional —
      // "Response Parameter will be Encrypted… Response Field Name is
      // ResponseData" — and the changelog dates it to v1.30, "Added Encryption
      // & Decryption process in Response", nine revisions before this. The
      // "For .Net / For PHP / For Java" headings nearby are CheckSum code
      // samples in three languages, not three response contracts.
      vendor: envOr('FG_PG_VENDOR', FG.paymentVendor),

      // How long a parsed payment result stays retrievable by its token.
      resultTtlMs: numberEnvOr('FG_PG_RESULT_TTL_MS', FG.resultTtlMs),
    },

    // Legacy NL-CKYC. Still answers, but mints short `PR_`+10 references, while
    // every working proposal sample FG have sent carries the `PR_`+13 reference
    // only GC-CKYC issues.
    ckyc: {
      baseUrl: trimTrailingSlash(requiredEnv('FG_CKYC_BASE_URL')) || null,
      token: requiredEnv('FG_CKYC_TOKEN') || null,
      clientId: requiredEnv('FG_CKYC_CLIENT_ID') || null,
      systemName: requiredEnv('FG_CKYC_SYSTEM_NAME') || null,
    },

    // GC-CKYC 3.0.0 — Generali Central's current service, and the one that
    // issues the reference FG's own working samples carry. Selected when
    // FG_GCKYC_ENABLED is on AND all four credentials are present; a PARTIAL
    // configuration falls back to the legacy service with a warning rather than
    // failing the KYC step outright.
    gcKyc: {
      enabled: boolEnvOr('FG_GCKYC_ENABLED', false),
      tokenUrl: requiredEnv('FG_GCKYC_TOKEN_URL') || null,
      baseUrl: trimTrailingSlash(requiredEnv('FG_GCKYC_BASE_URL')) || null,
      // Consumer key/secret of the API-manager application (HTTP Basic).
      clientKey: requiredEnv('FG_GCKYC_CLIENT_KEY') || null,
      clientSecret: requiredEnv('FG_GCKYC_CLIENT_SECRET') || null,
      // Resource-owner credentials — a password grant, not client_credentials.
      username: requiredEnv('FG_GCKYC_USERNAME') || null,
      password: requiredEnv('FG_GCKYC_PASSWORD') || null,
      // Drives FG's post-verification redirect. Distinct from legacy "Webagg".
      systemName: requiredEnv('FG_GCKYC_SYSTEM_NAME') || null,
      tokenSkewSeconds: numberEnvOr('FG_GCKYC_TOKEN_SKEW_SECONDS', 60),
    },

    // SPA route the payment return handler 302s the buyer to, appended to
    // FRONTEND_URL with only an opaque token as a query string.
    frontendReturnPath: envOr('FG_FRONTEND_RETURN_PATH', FG.frontendReturnPath),

    jsonBodyLimit: envOr('FG_JSON_BODY_LIMIT', FG.jsonBodyLimit),

    // Falls back to the NivaBupa/global list so one origin allow-list covers the
    // whole service; set FG_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.FG_CORS_ORIGINS
      || process.env.NIVABUPA_CORS_ORIGINS
      || process.env.CORS_ORIGINS
      || APP_DEFAULTS.corsOrigins,
  },

  // ── ICICI Lombard — "Elevate" Health ───────────────────────────────────────
  //
  // Configured the IFFCO Tokio / Future Generali way: every environment-
  // dependent value is read from the environment ONLY, with no bundled host,
  // login, password, key or client name anywhere in this codebase (see the
  // ICICI note in defaults.js). So:
  //
  //   * UAT    → EL_BASE_URL=https://ilesbapigee.insurancearticlez.com + the UAT login
  //   * PROD   → EL_BASE_URL=https://janus.icicilombard.com + the production login
  //   * unset  → the /icici-lombard endpoints answer 503 naming what is missing,
  //              and NivaBupa, IFFCO Tokio and Future Generali are unaffected
  //
  // The variable NAMES are the working implementation's own (EL_*), so its
  // .env block moves across unchanged.
  icici: {
    // Dumps the full upstream request/response of every ICICI call to stdout.
    // Off unless set: premium, proposal and CKYC bodies carry names, DOBs, PAN
    // and Aadhaar numbers. Failures are logged regardless.
    debug: process.env.EL_DEBUG === '1',

    // The host. Every operation appends its own path, so this ONE value moves
    // the whole integration between environments.
    baseUrl: trimTrailingSlash(requiredEnv('EL_BASE_URL')),

    login: requiredEnv('EL_LOGIN'),
    password: requiredEnv('EL_PASSWORD'),

    // IL issue the credential with the password ALREADY AES-encrypted — their
    // auth spec's Password field is "a valid encrypted password", i.e. the
    // ciphertext to send. When this is on the password is sent verbatim and no
    // AES key is needed. Off only if IL share a plaintext password plus the key
    // to encrypt it with.
    passwordPreEncrypted: boolEnvOr('EL_PASSWORD_PRE_ENCRYPTED', false),

    // Shared AES key from IL (base64 or raw) — only needed to encrypt a
    // plaintext password.
    aesKey: requiredEnv('EL_AES_KEY') || null,
    aesMode: envOr('EL_AES_MODE', IL.aesMode), // aes-128-ecb | aes-256-ecb | aes-256-cbc
    aesIv: requiredEnv('EL_AES_IV') || null,   // CBC modes only

    // {clientname} path segment on the COI endpoint. Partner identity issued by
    // IL, so it has no bundled default.
    clientName: requiredEnv('EL_CLIENT_NAME') || null,

    tokenSkewSeconds: numberEnvOr('EL_TOKEN_SKEW_SECONDS', IL.tokenSkewSeconds),
    maxRetries: numberEnvOr('EL_MAX_RETRIES', IL.maxRetries),
    retryBaseDelayMs: numberEnvOr('EL_RETRY_BASE_DELAY_MS', IL.retryBaseDelayMs),

    // Request paths appended to baseUrl. The API contract, identical in UAT and
    // production — overridable only so an IL-side path change stays a .env edit.
    paths: {
      token: envOr('EL_TOKEN_PATH', IL.paths.token),
      premium: envOr('EL_PREMIUM_PATH', IL.paths.premium),
      proposal: envOr('EL_PROPOSAL_PATH', IL.paths.proposal),
      policySync: envOr('EL_POLICY_SYNC_PATH', IL.paths.policySync),
      policyStatus: envOr('EL_POLICY_STATUS_PATH', IL.paths.policyStatus),
      emiDue: envOr('EL_EMI_DUE_PATH', IL.paths.emiDue),
      emiProcess: envOr('EL_EMI_PROCESS_PATH', IL.paths.emiProcess),
      coi: envOr('EL_COI_PATH', IL.paths.coi),
      zone: envOr('EL_ZONE_PATH', IL.paths.zone),
      ckyc: envOr('EL_CKYC_PATH', IL.paths.ckyc),
      ovdInitiate: envOr('EL_OVD_INITIATE_PATH', IL.paths.ovdInitiate),
    },

    jsonBodyLimit: envOr('EL_JSON_BODY_LIMIT', IL.jsonBodyLimit),

    // Falls back to the NivaBupa/global list so one origin allow-list covers the
    // whole service; set EL_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.EL_CORS_ORIGINS
      || process.env.NIVABUPA_CORS_ORIGINS
      || process.env.CORS_ORIGINS
      || APP_DEFAULTS.corsOrigins,
  },

  timeouts: {
    token: numberEnvOr('NIVABUPA_TOKEN_TIMEOUT_MS', TIMEOUT_DEFAULTS.token),
    api: numberEnvOr('NIVABUPA_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.api),
    soap: numberEnvOr('NIVABUPA_SOAP_TIMEOUT_MS', TIMEOUT_DEFAULTS.soap),
    dataPush: numberEnvOr('NIVABUPA_DATAPUSH_TIMEOUT_MS', TIMEOUT_DEFAULTS.dataPush),
    itgi: numberEnvOr('ITGI_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.itgi),
    itgiCkycCreate: numberEnvOr('ITGI_CKYC_CREATE_TIMEOUT_MS', TIMEOUT_DEFAULTS.itgiCkycCreate),
    fg: numberEnvOr('FG_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.fg),
    fgIssuance: numberEnvOr('FG_ISSUANCE_TIMEOUT_MS', TIMEOUT_DEFAULTS.fgIssuance),
    fgCkyc: numberEnvOr('FG_CKYC_TIMEOUT_MS', TIMEOUT_DEFAULTS.fgCkyc),
    fgPdf: numberEnvOr('FG_PDF_TIMEOUT_MS', TIMEOUT_DEFAULTS.fgPdf),
    icici: numberEnvOr('EL_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.icici),
  },
};

// The four variables without which no ITGI call can be made, by name.
//
// One definition, two readers: config/validate.js reports them at boot, and
// services/itgiApi.service.js refuses the call at request time. Keeping it here
// rather than in either of them is what stops the two from disagreeing about
// what "configured" means.
//
// Returns [] when ITGI is fully configured. Names only — never values.
export function missingItgiVariables() {
  const missing = [];
  if (!config.itgi.baseUrl) missing.push('ITGI_BASE_URL');
  if (!config.itgi.username) missing.push('ITGI_USERNAME');
  if (!config.itgi.password) missing.push('ITGI_PASSWORD');
  if (!config.itgi.partnerCode) missing.push('ITGI_PARTNER_CODE');
  return missing;
}

// True when NONE of the four are set — an entirely NivaBupa deployment that has
// simply not been given ITGI credentials. Distinguished from a PARTIAL
// configuration, which is a mistake worth warning about at boot.
export function itgiIsUnconfigured() {
  return missingItgiVariables().length === 4;
}

// The four variables without which no Future Generali SOAP call can be made.
//
// One definition, three readers — config/validate.js reports them at boot,
// services/fgApi.service.js refuses the call at request time, and
// GET /future-generali/config/test answers with them. Keeping it here rather
// than in any of those is what stops them disagreeing about what "configured"
// means. Names only, never values.
export function missingFgVariables() {
  const missing = [];
  if (!config.fg.boBaseUrl) missing.push('FG_BO_BASE_URL');
  if (!config.fg.vendorCode) missing.push('FG_VENDOR_CODE');
  if (!config.fg.agentCode) missing.push('FG_AGENT_CODE');
  if (!config.fg.branchCode) missing.push('FG_BRANCH_CODE');
  return missing;
}

// True when NONE of the four are set — a deployment that was simply never given
// Future Generali credentials. Distinguished from a PARTIAL configuration.
export function fgIsUnconfigured() {
  return missingFgVariables().length === 4;
}

// What the PAYMENT leg additionally needs, over and above the four above.
//
// Separate from missingFgVariables() because the legs fail independently and an
// operator needs to know which one is broken: quoting and proposing work
// perfectly with no gateway configured, and the first sign of the gap would
// otherwise be a buyer who cannot pay. The crypto pair is the sharpest case —
// without it FG's callback cannot be decrypted, which is reported as
// `unverified` (money may have moved) rather than as a failed payment.
export function missingFgPaymentVariables() {
  const missing = [];
  if (!config.fg.payment.gatewayUrl) missing.push('FG_PAYMENT_GATEWAY_URL');
  if (!config.fg.payment.returnUrl) missing.push('FG_PAYMENT_RETURN_URL');
  if (!config.fg.payment.cryptoKey) missing.push('FG_PG_CRYPTO_KEY');
  if (!config.fg.payment.cryptoIv) missing.push('FG_PG_CRYPTO_IV');
  return missing;
}

// Which CKYC service this process will actually use, and whether it can.
//
// GC-CKYC only when it is switched on AND fully credentialed: a half-configured
// GC-CKYC falls back to the legacy service rather than failing the KYC step, so
// a missing secret degrades instead of breaking the flow. It matters which one
// runs — every working proposal sample FG have sent carries a 13-character
// `PR_` reference, which only GC-CKYC issues.
export function fgCkycFlavour() {
  const gc = config.fg.gcKyc;
  const ready = gc.enabled
    && Boolean(gc.tokenUrl && gc.baseUrl && gc.clientKey && gc.clientSecret && gc.username && gc.password);
  if (ready) return 'gc-ckyc-3.0.0';
  return config.fg.ckyc.baseUrl ? 'nl-ckyc' : 'none';
}

// GC-CKYC variables that are set to be used but are not usable. Empty when
// GC-CKYC is off (nothing is expected of it) or fully configured.
export function partialFgGcKycVariables() {
  const gc = config.fg.gcKyc;
  if (!gc.enabled) return [];
  const byKey = {
    tokenUrl: 'FG_GCKYC_TOKEN_URL',
    baseUrl: 'FG_GCKYC_BASE_URL',
    clientKey: 'FG_GCKYC_CLIENT_KEY',
    clientSecret: 'FG_GCKYC_CLIENT_SECRET',
    username: 'FG_GCKYC_USERNAME',
    password: 'FG_GCKYC_PASSWORD',
  };
  return Object.entries(byKey).filter(([key]) => !gc[key]).map(([, name]) => name);
}

// The variables without which no ICICI Lombard call can be made, by name —
// the working implementation's missingConfigFor('elevate'), unchanged.
//
// One definition, three readers: config/validate.js reports them at boot,
// services/iciciApi.service.js refuses the call at request time, and
// GET /icici-lombard/config/test answers with them. Names only, never values.
export function missingIciciVariables() {
  const missing = [];
  if (!config.icici.baseUrl) missing.push('EL_BASE_URL');
  if (!config.icici.login) missing.push('EL_LOGIN');
  if (!config.icici.password) missing.push('EL_PASSWORD');
  // Only needed to encrypt a plaintext password. When IL have supplied the
  // ciphertext directly there is nothing to encrypt and no key to require.
  if (!config.icici.aesKey && !config.icici.passwordPreEncrypted) missing.push('EL_AES_KEY');
  return missing;
}

// True when none of the connection variables are set — a deployment that was
// simply never given ICICI credentials. Distinguished from a PARTIAL
// configuration, which is a mistake worth warning about at boot.
export function iciciIsUnconfigured() {
  return !config.icici.baseUrl && !config.icici.login && !config.icici.password;
}

// Names only — never values. Consumed by config/validate.js.
export function fallbackVariableNames() {
  return [...usedFallbacks].sort();
}

export default config;
