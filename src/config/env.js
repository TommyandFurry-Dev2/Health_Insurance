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

  timeouts: {
    token: numberEnvOr('NIVABUPA_TOKEN_TIMEOUT_MS', TIMEOUT_DEFAULTS.token),
    api: numberEnvOr('NIVABUPA_API_TIMEOUT_MS', TIMEOUT_DEFAULTS.api),
    soap: numberEnvOr('NIVABUPA_SOAP_TIMEOUT_MS', TIMEOUT_DEFAULTS.soap),
    dataPush: numberEnvOr('NIVABUPA_DATAPUSH_TIMEOUT_MS', TIMEOUT_DEFAULTS.dataPush),
  },
};

// Names only — never values. Consumed by config/validate.js.
export function fallbackVariableNames() {
  return [...usedFallbacks].sort();
}

export default config;
