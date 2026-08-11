// Startup configuration report.
//
// Answers one question at boot, in plain language, instead of leaving it to be
// discovered as a 502 on a buyer's first quote: is this process configured to
// talk to the environment its operator thinks it is?
//
// Three levels:
//   MISSING  — no value at all. The call that needs it will throw at request
//              time. Reported, and fatal only in production or under
//              STRICT_ENV=1.
//   FALLBACK — the value came from src/config/defaults.js, not the environment.
//              Harmless in UAT (the defaults ARE the UAT values); in production
//              it means real buyers would transact against NivaBupa's UAT
//              tenant, so it is fatal there.
//   OK       — came from the environment.
//
// No value is ever printed. Secrets are reported by name and by a
// non-reversible shape summary (length, and the first two characters for URLs
// only), which is enough to tell "the wrong key is set" from "no key is set"
// without putting a live partner credential in a log pm2 keeps on disk.

import config, { fallbackVariableNames } from './env.js';

// Without these, the named flow cannot work at all — there is no fallback and
// no way to synthesise one.
const REQUIRED = [
  { name: 'NIVABUPA_CASEAPI_USER_ID', value: config.nivabupa.caseApi.userId, breaks: 'Proposal Status + Policy Download (Case API)' },
  { name: 'NIVABUPA_CASEAPI_CLIENT_ID', value: config.nivabupa.caseApi.clientId, breaks: 'Proposal Status + Policy Download (Case API)' },
];

// Variables whose bundled default is a UAT value. Leaving any of them unset in
// production means transacting against UAT with real buyers, so production
// treats it as fatal rather than as a warning.
const PRODUCTION_REQUIRED = new Set([
  'NIVABUPA_CLIENT_ID',
  'NIVABUPA_CLIENT_SECRET',
  'NIVABUPA_IDENTIFIER_CODE',
  'NIVABUPA_TOKEN_URL',
  'NIVABUPA_SCOPE',
  'NIVABUPA_PREMIUM_URL',
  'NIVABUPA_UW_DECISION_URL',
  'NIVABUPA_DATAPUSH_URL',
  'NIVABUPA_CASEAPI_TOKEN_URL',
  'NIVABUPA_PROPOSAL_STATUS_URL',
  'NIVABUPA_POLICY_DOWNLOAD_URL',
  'NIVABUPA_PAYMENT_GATEWAY_URL',
  'NIVABUPA_SOAP_URL',
  'NIVABUPA_PAYMENT_ENCRYPTION_KEY',
  'NIVABUPA_PAYMENT_DECRYPTION_KEY',
]);

// Everything a UAT run wants set for the endpoints to be reachable. Used only
// to shape the report, never to block a boot.
const NOTABLE = [
  'NIVABUPA_CLIENT_ID', 'NIVABUPA_CLIENT_SECRET', 'NIVABUPA_IDENTIFIER_CODE',
  'NIVABUPA_TOKEN_URL', 'NIVABUPA_SCOPE', 'NIVABUPA_PREMIUM_URL',
  'NIVABUPA_UW_DECISION_URL', 'NIVABUPA_DATAPUSH_URL',
  'NIVABUPA_CASEAPI_TOKEN_URL', 'NIVABUPA_PROPOSAL_STATUS_URL',
  'NIVABUPA_POLICY_DOWNLOAD_URL', 'NIVABUPA_PAYMENT_GATEWAY_URL',
  'NIVABUPA_SOAP_URL', 'NIVABUPA_PAYMENT_ENCRYPTION_KEY',
  'NIVABUPA_PAYMENT_DECRYPTION_KEY', 'NIVABUPA_PAYMENT_RETURN_URL',
  'FRONTEND_URL',
];

// A secret is described, never shown. Length alone distinguishes "the staging
// key is still in .env" from "nothing is set", which is the whole diagnostic
// need — and it cannot be turned back into the key.
function describeSecret(value) {
  if (value === undefined || value === null || value === '') return 'not set';
  return `set (${String(value).length} chars)`;
}

// URLs are not secrets and the host is the single most useful thing to see at
// boot — "digitaluat.nivabupa.com" vs a production host is the difference this
// whole report exists to surface. The path is kept, any credentials in the
// userinfo component are not.
function describeUrl(value) {
  if (!value) return 'not set';
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '(unparseable URL)';
  }
}

function looksLikeUat(value) {
  return typeof value === 'string' && /uat|staging|localhost|127\.0\.0\.1/i.test(value);
}

/**
 * Validate configuration and print the boot report.
 *
 * @param {{ strict?: boolean }} [options] strict → throw instead of warn on any
 *   problem, regardless of NODE_ENV. Also set by STRICT_ENV=1.
 * @returns {{ ok: boolean, missing: string[], fallbacks: string[], fatal: string[] }}
 */
export function validateConfig({ strict = process.env.STRICT_ENV === '1' } = {}) {
  const isProduction = config.env === 'production';
  const fallbacks = fallbackVariableNames();
  const missing = REQUIRED.filter((entry) => !entry.value);

  console.log('───────────────────────────────────────────────────────');
  console.log(`⚙️  Configuration — NODE_ENV=${config.env}`);
  console.log('');
  console.log('  Upstream NivaBupa endpoints');
  console.log('    token          :', describeUrl(config.nivabupa.tokenUrl));
  console.log('    premium        :', describeUrl(config.nivabupa.premiumUrl));
  console.log('    uwDecision     :', describeUrl(config.nivabupa.uwDecisionUrl));
  console.log('    datapush       :', describeUrl(config.nivabupa.dataPushUrl));
  console.log('    caseapi token  :', describeUrl(config.nivabupa.caseApi.tokenUrl));
  console.log('    proposalStatus :', describeUrl(config.nivabupa.caseApi.proposalStatusUrl));
  console.log('    policyDownload :', describeUrl(config.nivabupa.caseApi.policyDownloadUrl));
  console.log('    payment SOAP   :', describeUrl(config.nivabupa.payment.soapUrl));
  console.log('    payment gateway:', describeUrl(config.nivabupa.payment.gatewayUrl));
  console.log('');
  console.log('  Credentials (values never logged)');
  console.log('    NIVABUPA_CLIENT_ID              :', describeSecret(config.nivabupa.clientId));
  console.log('    NIVABUPA_CLIENT_SECRET          :', describeSecret(config.nivabupa.clientSecret));
  console.log('    NIVABUPA_IDENTIFIER_CODE        :', describeSecret(config.nivabupa.identifierCode));
  console.log('    NIVABUPA_CASEAPI_USER_ID        :', describeSecret(config.nivabupa.caseApi.userId));
  console.log('    NIVABUPA_CASEAPI_CLIENT_ID      :', describeSecret(config.nivabupa.caseApi.clientId));
  console.log('    NIVABUPA_PAYMENT_ENCRYPTION_KEY :', describeSecret(config.nivabupa.payment.encryptionKey));
  console.log('    NIVABUPA_PAYMENT_DECRYPTION_KEY :', describeSecret(config.nivabupa.payment.decryptionKey));
  console.log('');
  console.log('  Ours');
  console.log('    payment returnPath :', config.nivabupa.payment.returnUrl);
  console.log('    frontend redirect  :', `${config.frontendUrl}${config.frontendReturnPath}`);
  console.log('    CORS origins       :', config.corsOrigins);
  console.log('    MySQL              :', `${config.db.user}@${config.db.host}:${config.db.port}/${config.db.database}`);
  console.log('');

  const fatal = [];

  if (missing.length > 0) {
    console.warn('  ⚠️  Missing required variables:');
    for (const entry of missing) {
      console.warn(`       ${entry.name} — ${entry.breaks} will fail with a named error at request time.`);
    }
    console.warn('');
    if (isProduction || strict) fatal.push(...missing.map((entry) => entry.name));
  }

  const notableFallbacks = fallbacks.filter((name) => NOTABLE.includes(name));
  if (notableFallbacks.length > 0) {
    console.warn(`  ⚠️  ${notableFallbacks.length} value(s) came from src/config/defaults.js, not the environment:`);
    console.warn(`       ${notableFallbacks.join(', ')}`);
    console.warn('       These are UAT values. Set them in .env for any non-UAT deployment.');
    console.warn('');
    const productionGaps = notableFallbacks.filter((name) => PRODUCTION_REQUIRED.has(name));
    if ((isProduction || strict) && productionGaps.length > 0) fatal.push(...productionGaps);
  }

  // The check that catches the actual accident: NODE_ENV says production, the
  // endpoints say UAT. Reached whether the URL came from .env or from the
  // fallback table, so it also catches a production .env copied from UAT.
  const uatEndpoints = [
    ['NIVABUPA_TOKEN_URL', config.nivabupa.tokenUrl],
    ['NIVABUPA_PREMIUM_URL', config.nivabupa.premiumUrl],
    ['NIVABUPA_UW_DECISION_URL', config.nivabupa.uwDecisionUrl],
    ['NIVABUPA_DATAPUSH_URL', config.nivabupa.dataPushUrl],
    ['NIVABUPA_SOAP_URL', config.nivabupa.payment.soapUrl],
  ].filter(([, value]) => looksLikeUat(value)).map(([name]) => name);

  if (isProduction && uatEndpoints.length > 0) {
    console.error('  ❌ NODE_ENV=production but these endpoints still point at UAT:');
    console.error(`       ${uatEndpoints.join(', ')}`);
    console.error('');
    fatal.push(...uatEndpoints);
  }

  const unique = [...new Set(fatal)];
  if (unique.length > 0) {
    console.error('───────────────────────────────────────────────────────');
    console.error('❌ Refusing to start — configuration is not safe for this NODE_ENV.');
    console.error(`   Fix in .env: ${unique.join(', ')}`);
    console.error('   (Set STRICT_ENV=0 and NODE_ENV=uat to run against UAT deliberately.)');
    console.error('───────────────────────────────────────────────────────');
    const error = new Error(`Invalid configuration: ${unique.join(', ')}`);
    error.invalidVariables = unique;
    throw error;
  }

  if (missing.length === 0 && notableFallbacks.length === 0) {
    console.log('  ✅ Every NivaBupa variable came from the environment.');
  }
  console.log('───────────────────────────────────────────────────────');

  return {
    ok: true,
    missing: missing.map((entry) => entry.name),
    fallbacks: notableFallbacks,
    fatal: unique,
  };
}

export { describeSecret, describeUrl };
