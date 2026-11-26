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
//
// .env.local is read first, so its values win over .env's (first value seen is
// kept). It holds a developer's localhost overrides — FRONTEND_URL, the FG
// ResponseURL — so .env can stay identical to the deployed one and never carry
// a localhost value onto a server. Missing, it is silently skipped; a server
// never has one. Gitignored.
// ─────────────────────────────────────────────────────────────────────────────
import dotenv from 'dotenv';

import {
  NIVABUPA_UAT_DEFAULTS as NB,
  ITGI_DEFAULTS as IT,
  FG_DEFAULTS as FG,
  ICICI_DEFAULTS as IL,
  CHOLA_DEFAULTS as CH,
  CHOLA_FREECHARGE_DEFAULTS as CF,
  GALAXY_DEFAULTS as GX,
  PROPOSAL_DEFAULTS,
  PAYMENT_DEFAULTS_VALUES,
  TIMEOUT_DEFAULTS,
  APP_DEFAULTS,
  DB_DEFAULTS,
  JOURNEY_DEFAULTS,
} from './defaults.js';

dotenv.config({ path: ['.env.local', '.env'] });

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

// 'a, b,,c' → ['a', 'b', 'c'].
function splitList(value) {
  return String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
}

// Whether a URL points at this machine.
function isLoopbackUrl(value) {
  try {
    return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

// Strict equality, deliberately not `(process.env.NODE_ENV || 'development')`
// like config.env below. The two failure modes are not symmetric: a deployment
// with NODE_ENV unset or empty would take that default and start handing real
// buyers localhost URLs — money moves and they land nowhere. A local run
// without NODE_ENV set merely gets the deployed defaults, which is visible
// immediately. .env sets NODE_ENV explicitly for exactly this reason.
const isDevelopment = process.env.NODE_ENV === 'development';
const localPort = numberEnvOr('PORT', APP_DEFAULTS.port);

// Read once here rather than off `config` below, because two entries of the
// literal need it and one of them (the KYC callback) is built from it.
const frontendUrl = process.env.FRONTEND_URL
  || (isDevelopment ? APP_DEFAULTS.devFrontendUrl : APP_DEFAULTS.prodFrontendUrl);

// Each ICICI path and the variable that sets it — one table for both profiles
// (UAT EL_*_PATH, production EL_PROD_*_PATH), so a path and the variable named
// when it is missing cannot disagree.
export const ICICI_PATH_VARIABLES = {
  token: 'EL_TOKEN_PATH',
  premium: 'EL_PREMIUM_PATH',
  proposal: 'EL_PROPOSAL_PATH',
  policySync: 'EL_POLICY_SYNC_PATH',
  policyStatus: 'EL_POLICY_STATUS_PATH',
  emiDue: 'EL_EMI_DUE_PATH',
  emiProcess: 'EL_EMI_PROCESS_PATH',
  coi: 'EL_COI_PATH',
  zone: 'EL_ZONE_PATH',
  ckyc: 'EL_CKYC_PATH',
  ovdInitiate: 'EL_OVD_INITIATE_PATH',
};

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
  frontendUrl,

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
      // Origins of the frontends that may name their own return page on
      // payment/initiate (frontendReturnUrl, checked by resolveFrontendReturnUrl
      // in helpers/payment.helper.js). A payment that names none, or one not on
      // this list, still returns to FRONTEND_URL + FRONTEND_RETURN_PATH, so one
      // backend serves both frontends without FRONTEND_URL moving. Read like
      // NIVABUPA_CORS_ORIGINS, not through envOr: it is optional, and its
      // default is not a UAT value production would have to replace.
      //
      // A local run adds the local Vite dev server. Local means NODE_ENV=development
      // or a FRONTEND_URL on this machine: a developer's .env mirrors the server's,
      // NODE_ENV=uat included, and only .env.local points FRONTEND_URL at a local
      // dev server. A deployed backend never has a localhost FRONTEND_URL.
      frontendReturnOrigins: [
        ...splitList(process.env.NIVABUPA_FRONTEND_RETURN_ORIGINS || APP_DEFAULTS.frontendReturnOrigins),
        ...(isDevelopment || isLoopbackUrl(frontendUrl) ? splitList(APP_DEFAULTS.devFrontendReturnOrigins) : []),
      ],
      // Where the page each payment named waits for its callback
      // (services/nivabupaReturnTarget.service.js), and for how long.
      returnTargets: {
        dir: process.env.NIVABUPA_RETURN_TARGET_DIR || APP_DEFAULTS.returnTargetDir,
        ttlHours: APP_DEFAULTS.returnTargetTtlHours,
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

    // KYC — NivaBupa's "KYC APIs Integration Document" (KYCNew CKYC OTP flow).
    // A third auth mechanism, separate from both the generic OAuth token and the
    // caseapi token: its own Username/Password, a PartnerName header, and every
    // body wrapped in an AES-encrypted { payload } envelope.
    //
    // No bundled fallbacks. While any of the five credentials is unset,
    // /nivabupa/kyc/* answer 503 naming what is missing and /nivabupa/uw-decision
    // refuses proposals — underwriting requires KYC that NivaBupa has verified.
    kyc: {
      baseUrl: trimTrailingSlash(requiredEnv('NIVABUPA_KYC_BASE_URL')),
      partnerName: requiredEnv('NIVABUPA_KYC_PARTNER_NAME'),
      username: requiredEnv('NIVABUPA_KYC_USERNAME'),
      password: requiredEnv('NIVABUPA_KYC_PASSWORD'),
      encryptionKey: requiredEnv('NIVABUPA_KYC_ENCRYPTION_KEY'),
      timeoutMs: numberEnvOr('NIVABUPA_KYC_TIMEOUT_MS', TIMEOUT_DEFAULTS.kyc),

      // CallBack_URL on RedirectionLinkEnc — where NivaBupa's hosted KYC page
      // sends the buyer once they are done. Unlike the payment return this is
      // not a route of ours: it is a page of the SPA, and nothing is read from
      // whatever NivaBupa append to it. The result is always fetched from
      // GetKycStatusEnc, because a buyer who closes the tab never lands here at
      // all and the KYC is still complete.
      //
      // Defaults to the SPA's KYC return page under FRONTEND_URL, so a local
      // run lands on the dev server and a deployment on the deployed site.
      // Optional to NivaBupa — unset, their page simply ends on itself.
      callbackUrl: envOr(
        'NIVABUPA_KYC_CALLBACK_URL',
        `${trimTrailingSlash(frontendUrl)}${APP_DEFAULTS.frontendKycReturnPath}`
      ),
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

    // Base the payment return handler prepends to frontendReturnPath.
    //
    // ITGI-only, and null unless ITGI_FRONTEND_URL is set — an unset value
    // falls back to the global frontendUrl in the handler, so a deployment
    // that does not set it behaves exactly as it did before this existed. That
    // is the expected configuration: all three return pages now live in the
    // same app under the same /health-insurance base, so FRONTEND_URL carries
    // the value for NivaBupa, FG and ITGI alike.
    //
    // It exists as an escape hatch for the one case FRONTEND_URL cannot
    // express — ITGI served by a different app, or from a different deploy
    // path, than the other two. Without it the only way to move ITGI alone
    // would be to move FRONTEND_URL, which silently relocates the other two
    // insurers' return URLs; a payment callback is not the place for that kind
    // of blast radius.
    //
    // When set, the value carries the '#' and the in-app base path, e.g.
    // https://insurance.tommyandfurry.com/tommyandfurryuat/#/health-insurance
    // The redirect is plain concatenation, so it goes out verbatim: no
    // trailing slash, and the query string lands after the hash route, where
    // the SPA's own router reads it.
    frontendUrl: trimTrailingSlash(process.env.ITGI_FRONTEND_URL) || null,

    // SPA route the payment return handler 302s the buyer to, appended to
    // the base above (or FRONTEND_URL) with the outcome as a query string.
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

    // Request paths appended to baseUrl — UAT's, the kit's `generic` paths.
    // Production's differ (/…/finofinins/…, /auth-api/v2/token) and live in
    // iciciProduction below, never here. Overridable only so an IL-side UAT path
    // change stays a .env edit.
    paths: Object.fromEntries(
      Object.entries(ICICI_PATH_VARIABLES).map(([key, name]) => [key, envOr(name, IL.paths[key])])
    ),

    jsonBodyLimit: envOr('EL_JSON_BODY_LIMIT', IL.jsonBodyLimit),

    // Falls back to the NivaBupa/global list so one origin allow-list covers the
    // whole service; set EL_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.EL_CORS_ORIGINS
      || process.env.NIVABUPA_CORS_ORIGINS
      || process.env.CORS_ORIGINS
      || APP_DEFAULTS.corsOrigins,
  },

  // ── ICICI Lombard PRODUCTION — on this same backend ────────────────────────
  //
  // This one process serves the UAT SPA and the production SPA, so it holds both
  // ICICI environments and picks one PER REQUEST
  // (middleware/iciciClientEnvironment.js): a production build declares
  // X-App-Env: prod and gets this profile; the UAT build declares nothing and
  // keeps `icici` above, exactly as before. Off until EL_PRODUCTION_ENABLED=true.
  //
  // Connection values only — retries, timeouts, debug, CORS and the body limit
  // are shared with UAT. The names mirror EL_* as EL_PROD_*, and NONE has a
  // default: not the host, not the credential, not one path. An operation ICICI
  // have not issued a production path for answers 503 rather than fall back to
  // UAT's.
  iciciProduction: {
    enabled: boolEnvOr('EL_PRODUCTION_ENABLED', false),
    baseUrl: trimTrailingSlash(requiredEnv('EL_PROD_BASE_URL')),
    login: requiredEnv('EL_PROD_LOGIN'),
    password: requiredEnv('EL_PROD_PASSWORD'),
    // Not assumed to match UAT's: set it from what ICICI issued for production.
    passwordPreEncrypted: boolEnvOr('EL_PROD_PASSWORD_PRE_ENCRYPTED', false),
    aesKey: requiredEnv('EL_PROD_AES_KEY') || null,
    aesMode: envOr('EL_PROD_AES_MODE', IL.aesMode),
    aesIv: requiredEnv('EL_PROD_AES_IV') || null,
    clientName: requiredEnv('EL_PROD_CLIENT_NAME') || null,
    paths: Object.fromEntries(
      Object.entries(ICICI_PATH_VARIABLES)
        .map(([key, name]) => [key, requiredEnv(name.replace(/^EL_/, 'EL_PROD_')) || null])
    ),
  },

  // ── Chola MS (Cholamandalam MS General Insurance) — Health ─────────────────
  //
  // Configured the IFFCO Tokio / Future Generali / ICICI way: every
  // environment-dependent value is read from the environment ONLY, with no
  // bundled host, client id/secret, intermediary code or CKYC key anywhere in
  // this codebase (see the Chola note in defaults.js). So:
  //
  //   * UAT    → CHOLA_BASE_URL=https://developeruat.cholainsurance.com + the UAT
  //              client credentials and intermediary code
  //   * PROD   → the production host and credentials Chola issue
  //   * unset  → the /chola-ms endpoints answer 503 naming what is missing, and
  //              every other insurer is unaffected
  //
  // The variable NAMES are the working implementation's own (CHOLA_*), so its
  // .env block moves across unchanged.
  chola: {
    // Dumps the full upstream request/response of every Chola call to stdout.
    // Off unless set: ProposalSave and CKYC bodies carry names, DOBs, PAN,
    // Aadhaar and bank details. Failures are logged regardless.
    debug: process.env.CHOLA_DEBUG === '1',

    // The product API host (Chola's WSO2 gateway). The token call and every
    // product operation append their own path to it.
    baseUrl: trimTrailingSlash(requiredEnv('CHOLA_BASE_URL')),

    // OAuth2 client_credentials pair, sent as HTTP Basic on the token call.
    clientId: requiredEnv('CHOLA_CLIENT_ID'),
    clientSecret: requiredEnv('CHOLA_CLIENT_SECRET'),

    // Injected into every quote/proposal/policy body that does not carry one.
    // Partner identity issued by Chola, so it has no bundled default.
    intermediaryCode: requiredEnv('CHOLA_INTERMEDIARY_CODE'),

    // Super Topup's ProposalSave is served from a different (Portal .svc) host,
    // as an absolute URL. Only that one call needs it; unset, it answers a named
    // CONFIG_ERROR and every other operation is unaffected.
    topupProposalUrl: requiredEnv('CHOLA_TOPUP_PROPOSAL_URL') || null,

    // Chola answer PolicyGeneration (PayMode "Chola") and PolicySchedule with
    // links on their own INTERNAL address — on UAT both come back on
    // http://10.105.63.69, which no browser outside their network can resolve.
    // Setting this rewrites the scheme/host of those links only, leaving path
    // and query untouched.
    //
    // Deliberately unset by default: passing the link through unchanged lets
    // the caller see the real host and say so, which is better than handing a
    // buyer a link that silently fails to load.
    publicUrlBase: requiredEnv('CHOLA_PUBLIC_URL_BASE') || '',

    // How the BACKEND tags payment when it builds PolicyGeneration itself (the
    // ops route and scripts/uat-chola-apd.js — see
    // services/cholaPolicyIssuer.service.js): PG_CHOLA | PG_DIRECT | APD. The
    // website sends its own PG request, except under APD, where its route issues
    // through the backend too. APD is refused when NODE_ENV=production.
    paymentMode: String(envOr('CHOLA_PAYMENT_MODE', CH.paymentMode)).trim().toUpperCase(),

    // Shared secret for /chola-ms/ops/* (X-Ops-Key header). Unset = those
    // routes are switched off, not open.
    opsKey: requiredEnv('CHOLA_OPS_KEY') || '',

    tokenSkewSeconds: numberEnvOr('CHOLA_TOKEN_SKEW_SECONDS', CH.tokenSkewSeconds),
    maxRetries: numberEnvOr('CHOLA_MAX_RETRIES', CH.maxRetries),
    retryBaseDelayMs: numberEnvOr('CHOLA_RETRY_BASE_DELAY_MS', CH.retryBaseDelayMs),

    // Request paths appended to the base URLs. The API contract, identical in
    // UAT and production — overridable only so a Chola-side path change stays a
    // .env edit.
    paths: {
      token: envOr('CHOLA_TOKEN_PATH', CH.paths.token),
      product: envOr('CHOLA_PRODUCT_PATH', CH.paths.product),
      ckycAuth: envOr('CHOLA_CKYC_AUTH_PATH', CH.paths.ckycAuth),
      ckycVerify: envOr('CHOLA_CKYC_VERIFY_PATH', CH.paths.ckycVerify),
      ckycQuery: envOr('CHOLA_CKYC_QUERY_PATH', CH.paths.ckycQuery),
    },

    // CKYC lives on a separate e-policy portal with its own auth: a PrivateKey
    // (+ optional UserID) exchanged for a TokenKey header.
    ckyc: {
      baseUrl: trimTrailingSlash(requiredEnv('CHOLA_CKYC_BASE_URL')) || null,
      privateKey: requiredEnv('CHOLA_CKYC_PRIVATE_KEY') || null,
      userId: requiredEnv('CHOLA_CKYC_USER_ID') || '',
    },

    jsonBodyLimit: envOr('CHOLA_JSON_BODY_LIMIT', CH.jsonBodyLimit),

    // Freecharge (FCPG), the gateway Chola collect premium through — see
    // services/cholaFreechargePayment.service.js. Its APIs sit on Chola's WSO2
    // gateway under a SEPARATE OAuth2 client: the product client above answers
    // 900908 "API Subscription validation failed" on every /free-charge path
    // (UAT, 2026-11-17). Unset, the /chola-ms/freecharge routes answer 503 and
    // nothing else is affected.
    freecharge: {
      // Chola's gateway. Same host as the product APIs on UAT.
      baseUrl: trimTrailingSlash(requiredEnv('CHOLA_FREECHARGE_BASE_URL') || requiredEnv('CHOLA_BASE_URL')) || null,
      // Absolute. Chola are to share the final token URL separately, so it is
      // its own variable; unset, the token is minted at baseUrl + paths.token.
      tokenUrl: requiredEnv('CHOLA_FREECHARGE_TOKEN_URL') || null,
      // The OAuth2 client_credentials pair, sent as HTTP Basic — or the Basic
      // value exactly as Chola issued it (base64 of id:secret), which wins.
      clientId: requiredEnv('CHOLA_FREECHARGE_CLIENT_ID') || null,
      clientSecret: requiredEnv('CHOLA_FREECHARGE_CLIENT_SECRET') || null,
      basicAuth: requiredEnv('CHOLA_FREECHARGE_BASIC_AUTH') || null,
      // Chola's Freecharge merchant id (UAT MER6dca324492).
      merchantId: requiredEnv('CHOLA_FREECHARGE_MERCHANT_ID') || null,
      // FCPG's hosted checkout, which the buyer's browser form-POSTs clientId +
      // encData to: https://sandbox-axispg.freecharge.in/payment/v1/checkout on
      // UAT, https://secure-axispg.freecharge.in/payment/v1/checkout live.
      checkoutUrl: requiredEnv('CHOLA_FREECHARGE_CHECKOUT_URL') || null,
      // The public address of /chola-ms/freecharge/return on this service, sent
      // as callbackUrl on every checkout. FCPG return the buyer there.
      callbackUrl: requiredEnv('CHOLA_FREECHARGE_CALLBACK_URL') || null,
      // Where a callback that cannot be matched to a payment sends the buyer
      // (absolute, a /chola-return page). Matched callbacks go to the page the
      // checkout named.
      fallbackReturnUrl: requiredEnv('CHOLA_FREECHARGE_FRONTEND_RETURN_URL') || null,
      // Origins whose /chola-return page a checkout may name. Defaults to the
      // list NivaBupa's payment/initiate uses (the new site, UAT and live), plus
      // the local Vite dev server on a local run.
      frontendReturnOrigins: [
        ...splitList(process.env.CHOLA_FREECHARGE_FRONTEND_RETURN_ORIGINS
          || process.env.NIVABUPA_FRONTEND_RETURN_ORIGINS
          || APP_DEFAULTS.frontendReturnOrigins),
        ...(isDevelopment || isLoopbackUrl(frontendUrl) ? splitList(APP_DEFAULTS.devFrontendReturnOrigins) : []),
      ],
      currency: envOr('CHOLA_FREECHARGE_CURRENCY', CF.currency),
      paths: {
        token: envOr('CHOLA_FREECHARGE_TOKEN_PATH', CF.paths.token),
        encrypt: envOr('CHOLA_FREECHARGE_ENCRYPT_PATH', CF.paths.encrypt),
        decrypt: envOr('CHOLA_FREECHARGE_DECRYPT_PATH', CF.paths.decrypt),
        txnStatus: envOr('CHOLA_FREECHARGE_TXN_STATUS_PATH', CF.paths.txnStatus),
        payLinkCreate: envOr('CHOLA_FREECHARGE_PAYLINK_CREATE_PATH', CF.paths.payLinkCreate),
        payLinkStatus: envOr('CHOLA_FREECHARGE_PAYLINK_STATUS_PATH', CF.paths.payLinkStatus),
        refund: envOr('CHOLA_FREECHARGE_REFUND_PATH', CF.paths.refund),
      },
    },

    // Falls back to the NivaBupa/global list so one origin allow-list covers the
    // whole service; set CHOLA_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.CHOLA_CORS_ORIGINS
      || process.env.NIVABUPA_CORS_ORIGINS
      || process.env.CORS_ORIGINS
      || APP_DEFAULTS.corsOrigins,
  },

  // My Policies on the website. After a Niva Bupa datapush (paid, policy code)
  // and once proposal status reports the policy issued, the policy is sent to
  // insuranceapi's POST /api/internal/health-policies (services/myPolicies.service.js),
  // so the customer sees it even if their browser never came back to the site.
  // Off while either is empty. Never blocks or fails a sale.
  myPolicies: {
    // e.g. https://insuranceapi.tommyandfurry.com/api/internal/health-policies
    url: process.env.MY_POLICIES_INTAKE_URL || '',
    // The same value as HEALTH_POLICY_SECRET on insuranceapi (both servers).
    secret: process.env.HEALTH_POLICY_SECRET || '',
    timeoutMs: Number(process.env.MY_POLICIES_INTAKE_TIMEOUT_MS) || 8000,
  },

  // Health purchase store (migrations 008–014, services/healthPurchase.service.js).
  // Every insurer call that moves a purchase forward is saved to the common
  // health_* tables and the insurer's own health_<insurer>_* tables, with
  // personal data encrypted. Off while either key is empty, and then every
  // insurer flow runs exactly as before. Keys never reach the database; losing
  // them makes the encrypted columns unreadable, so back them up.
  healthStore: {
    // "1:<base64 32 bytes>"; to rotate, append "2:<new key>" and keep 1 for reading.
    encKeys: process.env.HEALTH_DATA_ENC_KEYS || '',
    // base64, at least 32 bytes, different from every encryption key.
    hashKey: process.env.HEALTH_DATA_HASH_KEY || '',
    // How long a buyer's response may wait for the store before going out
    // without the X-Purchase-Id header; the write still completes afterwards.
    waitMs: Number(process.env.HEALTH_STORE_WAIT_MS) || 1500,
  },

  // ── Galaxy Health Insurance (GHI, CBOS-GX V2) ─────────────────────────────
  // Moved from the working implementation (novacred-insurance-integrations,
  // :4002) with its GX_* variable NAMES unchanged, so its .env block copies
  // across as-is. GHI-issued values have no bundled default (see defaults.js):
  //
  //   * UAT    → GX_BASE_URL=https://uat-gxapi.galaxyhealth.com + the UAT
  //              channel, appKey and static public key GHI issued
  //   * PROD   → https://gxapi.galaxyhealth.com and GHI's production values
  //   * unset  → the /galaxy-health endpoints answer 503 naming what is missing,
  //              and every other insurer is unaffected
  galaxy: {
    // Logs the decrypt / retry lines too. Request and response bodies are never
    // printed: a proposal is a person's KYC.
    debug: process.env.GX_DEBUG === '1',

    baseUrl: trimTrailingSlash(requiredEnv('GX_BASE_URL')) || null,
    // Channel 2522 on UAT: the requestUID prefix and GH-CLIENT-CONTEXT channelID.
    channelId: requiredEnv('GX_CHANNEL_ID') || null,
    srcSystemName: envOr('GX_SRC_SYSTEM_NAME', GX.srcSystemName),
    srcClientId: envOr('GX_SRC_CLIENT_ID', GX.srcClientId),
    userAgent: envOr('GX_USER_AGENT', GX.userAgent),
    // The server's public IP as GHI whitelisted it, sent in GH-CLIENT-CONTEXT.
    clientIp: envOr('GX_CLIENT_IP', GX.clientIp),
    // quickQuote's basicDetails.producerCode when the caller sends none
    // (GHI00000001 since GHI's mail of 19 Nov 2026).
    producerCode: requiredEnv('GX_PRODUCER_CODE') || '',
    // "Authorization: Basic <appKey>" (GHI mail, 28 Oct 2026). A credential.
    appKey: requiredEnv('GX_APP_KEY') || null,
    // GHI's bootstrap public key, used only before the first key rotation.
    ghiStaticPublicKey: requiredEnv('GX_GHI_STATIC_PUBLIC_KEY') || null,

    crypto: {
      rsaPadding: envOr('GX_RSA_PADDING', GX.crypto.rsaPadding),
      oaepHash: envOr('GX_OAEP_HASH', GX.crypto.oaepHash),
      aesMode: envOr('GX_AES_MODE', GX.crypto.aesMode),
      aesIvLength: numberEnvOr('GX_AES_IV_LENGTH', GX.crypto.aesIvLength),
      aesTagLength: numberEnvOr('GX_AES_TAG_LENGTH', GX.crypto.aesTagLength),
    },

    keyStoreDir: envOr('GX_KEY_STORE_DIR', GX.keyStoreDir),
    keyScheduler: boolEnvOr('GX_KEY_SCHEDULER', GX.keyScheduler),
    keyRefreshAt: envOr('GX_KEY_REFRESH_AT', GX.keyRefreshAt),
    keyRetryMinutes: numberEnvOr('GX_KEY_RETRY_MINUTES', GX.keyRetryMinutes),

    // X-Ops-Key for /galaxy-health/ops/*; those routes are off (503) while unset.
    opsKey: requiredEnv('GX_OPS_KEY') || '',

    maxRetries: numberEnvOr('GX_MAX_RETRIES', GX.maxRetries),
    retryBaseDelayMs: numberEnvOr('GX_RETRY_BASE_DELAY_MS', GX.retryBaseDelayMs),
    jsonBodyLimit: envOr('GX_JSON_BODY_LIMIT', GX.jsonBodyLimit),

    // The payment leg after createOrder (services/galaxyPayment.service.js).
    // The URLs GHI configure on their side are this service's own routes:
    //   redirect  https://<host>/health/galaxy-health/payment/return
    //   callback  https://<host>/health/galaxy-health/payment/callback
    //   token     https://<host>/health/galaxy-health/payment/token
    payment: {
      // Issued BY US to GHI for the token API. Unset = token API answers 503
      // and every callback is refused (but still captured).
      clientId: requiredEnv('GX_PAYMENT_CLIENT_ID') || null,
      clientSecret: requiredEnv('GX_PAYMENT_CLIENT_SECRET') || null,
      tokenTtlSeconds: numberEnvOr('GX_PAYMENT_TOKEN_TTL_SECONDS', GX.payment.tokenTtlSeconds),
      // Only if GHI encrypt the result with a static AES key they issue.
      aesKey: requiredEnv('GX_PAYMENT_AES_KEY') || null,
      // Where the buyer goes when the order's own /galaxy-return page is not
      // known (absolute, a /galaxy-return page).
      frontendReturnUrl: requiredEnv('GX_PAYMENT_FRONTEND_RETURN_URL') || null,
      // Origins whose /galaxy-return page a createOrder may name.
      frontendReturnOrigins: [
        ...splitList(process.env.GX_PAYMENT_FRONTEND_RETURN_ORIGINS
          || process.env.NIVABUPA_FRONTEND_RETURN_ORIGINS
          || APP_DEFAULTS.frontendReturnOrigins),
        ...(isDevelopment || isLoopbackUrl(frontendUrl) ? splitList(APP_DEFAULTS.devFrontendReturnOrigins) : []),
      ],
      storeDir: envOr('GX_PAYMENT_STORE_DIR', GX.payment.storeDir),
    },

    // Falls back to the NivaBupa/global list so one origin allow-list covers the
    // whole service; set GX_CORS_ORIGINS only to diverge from it.
    corsOrigins: process.env.GX_CORS_ORIGINS
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
    chola: numberEnvOr('CHOLA_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.chola),
    cholaPolicyGeneration: numberEnvOr('CHOLA_POLICY_GENERATION_TIMEOUT_MS', TIMEOUT_DEFAULTS.cholaPolicyGeneration),
    galaxy: numberEnvOr('GX_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.galaxy),
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
//
// `environment` is 'uat' (the EL_* profile, and the default — every caller
// that names none gets exactly the answer it always got) or 'production'
// (EL_PROD_*, which also needs its token path: it has no default).
export function missingIciciVariables(environment = 'uat') {
  const profile = iciciProfile(environment);
  const name = (base) => iciciVariable(base, environment);
  const missing = [];
  if (!profile.baseUrl) missing.push(name('EL_BASE_URL'));
  if (!profile.login) missing.push(name('EL_LOGIN'));
  if (!profile.password) missing.push(name('EL_PASSWORD'));
  // Only needed to encrypt a plaintext password. When IL have supplied the
  // ciphertext directly there is nothing to encrypt and no key to require.
  if (!profile.aesKey && !profile.passwordPreEncrypted) missing.push(name('EL_AES_KEY'));
  // Every call needs a token. UAT's path always has its default.
  if (!profile.paths.token) missing.push(name('EL_TOKEN_PATH'));
  return missing;
}

// The connection profile for an ICICI environment: 'uat' → config.icici,
// 'production' → config.iciciProduction.
export function iciciProfile(environment = 'uat') {
  return environment === 'production' ? config.iciciProduction : config.icici;
}

// A variable's name in an environment: EL_BASE_URL → EL_PROD_BASE_URL for
// production, unchanged for UAT. Names only, never values.
export function iciciVariable(name, environment = 'uat') {
  return environment === 'production' ? name.replace(/^EL_/, 'EL_PROD_') : name;
}

// Production paths not set, as variable names — the operations ICICI have not
// issued a production path for (EMI, so far). Those answer 503.
export function iciciProductionPathsNotSet() {
  return Object.entries(ICICI_PATH_VARIABLES)
    .filter(([key]) => !config.iciciProduction.paths[key])
    .map(([, name]) => iciciVariable(name, 'production'));
}

// True when none of the production connection variables are set.
export function iciciProductionIsUnconfigured() {
  const p = config.iciciProduction;
  return !p.baseUrl && !p.login && !p.password;
}

// Why an ICICI environment must not be used right now, or null.
//
// The hosts are checked against ICICI's own domains so neither profile can be
// pointed at the other ICICI: the UAT profile is what the UAT SPA reaches, so
// it must never be production (outside a NODE_ENV=production process, where
// EL_* is the only profile there is); the production profile takes real
// buyers' money, so it must never be UAT.
export function iciciEnvironmentRefusal(environment = 'uat') {
  const host = iciciProfile(environment).baseUrl || '';
  if (environment === 'production') {
    if (!config.iciciProduction.enabled) {
      return 'Production ICICI Lombard is not enabled on this server (EL_PRODUCTION_ENABLED).';
    }
    if (/insurancearticlez/i.test(host)) {
      return 'EL_PROD_BASE_URL points at ICICI Lombard UAT; production buyers must not reach it.';
    }
  } else if (config.env !== 'production' && /icicilombard\.com/i.test(host)) {
    return 'EL_BASE_URL points at ICICI Lombard production, but it is the UAT profile the UAT SPA reaches. Production belongs in EL_PROD_BASE_URL.';
  }
  return null;
}

// True when none of the connection variables are set — a deployment that was
// simply never given ICICI credentials. Distinguished from a PARTIAL
// configuration, which is a mistake worth warning about at boot.
export function iciciIsUnconfigured() {
  return !config.icici.baseUrl && !config.icici.login && !config.icici.password;
}

// The variables without which no Chola MS product call can be made, by name —
// the working implementation's missingConfigFor('chola'), unchanged.
//
// One definition, three readers: config/validate.js reports them at boot,
// services/cholaApi.service.js refuses the call at request time, and
// GET /chola-ms/config/test answers with them. Names only, never values.
export function missingCholaVariables() {
  const missing = [];
  if (!config.chola.baseUrl) missing.push('CHOLA_BASE_URL');
  if (!config.chola.clientId) missing.push('CHOLA_CLIENT_ID');
  if (!config.chola.clientSecret) missing.push('CHOLA_CLIENT_SECRET');
  if (!config.chola.intermediaryCode) missing.push('CHOLA_INTERMEDIARY_CODE');
  return missing;
}

// True when none of the connection variables are set — a deployment that was
// simply never given Chola credentials. Distinguished from a PARTIAL
// configuration, which is a mistake worth warning about at boot.
export function cholaIsUnconfigured() {
  return !config.chola.baseUrl && !config.chola.clientId && !config.chola.clientSecret;
}

// What the CKYC leg additionally needs. Separate from missingCholaVariables()
// because it is a different portal with different credentials, and the legs
// fail independently: quoting works with no CKYC key at all.
export function missingCholaCkycVariables() {
  const missing = [];
  if (!config.chola.ckyc.baseUrl) missing.push('CHOLA_CKYC_BASE_URL');
  if (!config.chola.ckyc.privateKey) missing.push('CHOLA_CKYC_PRIVATE_KEY');
  return missing;
}

// What the Freecharge payment leg needs. Separate again: a different OAuth2
// client from the product APIs, and quoting, CKYC and proposals all work
// without it. Either the id/secret pair or the issued Basic value will do.
export function missingCholaFreechargeVariables() {
  const fc = config.chola.freecharge;
  const missing = [];
  if (!fc.baseUrl && !fc.tokenUrl) missing.push('CHOLA_FREECHARGE_BASE_URL');
  if (!fc.basicAuth && (!fc.clientId || !fc.clientSecret)) {
    missing.push('CHOLA_FREECHARGE_CLIENT_ID + CHOLA_FREECHARGE_CLIENT_SECRET (or CHOLA_FREECHARGE_BASIC_AUTH)');
  }
  if (!fc.merchantId) missing.push('CHOLA_FREECHARGE_MERCHANT_ID');
  if (!fc.checkoutUrl) missing.push('CHOLA_FREECHARGE_CHECKOUT_URL');
  if (!fc.callbackUrl) missing.push('CHOLA_FREECHARGE_CALLBACK_URL');
  return missing;
}

// True when nothing Freecharge-specific is set — a deployment that does not
// take Chola payments through Freecharge at all.
export function cholaFreechargeIsUnconfigured() {
  const fc = config.chola.freecharge;
  return !fc.tokenUrl && !fc.clientId && !fc.clientSecret && !fc.basicAuth && !fc.merchantId
    && !fc.checkoutUrl && !fc.callbackUrl;
}

// The variables without which no Galaxy Health call can be made, by name — the
// working implementation's missingConfigFor('galaxy'), unchanged.
//
// One definition, three readers: config/validate.js reports them at boot,
// services/galaxyApi.service.js refuses the call at request time, and
// GET /galaxy-health/config/test answers with them. Names only, never values.
export function missingGalaxyVariables() {
  const missing = [];
  if (!config.galaxy.baseUrl) missing.push('GX_BASE_URL');
  if (!config.galaxy.channelId) missing.push('GX_CHANNEL_ID');
  if (!config.galaxy.appKey) missing.push('GX_APP_KEY');
  if (!config.galaxy.ghiStaticPublicKey) missing.push('GX_GHI_STATIC_PUBLIC_KEY');
  return missing;
}

// True when none of them are set — a deployment that was simply never given
// Galaxy credentials. Distinguished from a PARTIAL configuration, which is a
// mistake worth warning about at boot.
export function galaxyIsUnconfigured() {
  return missingGalaxyVariables().length === 4;
}

// Names only — never values. Consumed by config/validate.js.
export function fallbackVariableNames() {
  return [...usedFallbacks].sort();
}

export default config;
