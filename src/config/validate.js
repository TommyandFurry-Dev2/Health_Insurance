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

import config, {
  fallbackVariableNames,
  missingItgiVariables,
  itgiIsUnconfigured,
  missingFgVariables,
  missingFgPaymentVariables,
  fgIsUnconfigured,
  fgCkycFlavour,
  partialFgGcKycVariables,
  missingIciciVariables,
  iciciIsUnconfigured,
  missingCholaVariables,
  cholaIsUnconfigured,
  missingCholaCkycVariables,
} from './env.js';
import { CHOLA_PAYMENT_MODES } from '../constants/chola.constants.js';

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

  // ── IFFCO Tokio ──
  //
  // Reported separately because it is configured differently: it has NO bundled
  // fallbacks at all (see defaults.js), so there is no FALLBACK level here —
  // a value is either set or missing, and missing means those endpoints answer
  // 503 while everything else keeps working.
  const itgiMissing = missingItgiVariables();
  console.log('  IFFCO Tokio (optional — Niva Bupa is unaffected either way)');
  if (itgiIsUnconfigured()) {
    console.log('    not configured — /iffcotokio endpoints answer 503');
  } else {
    console.log('    base URL           :', describeUrl(config.itgi.baseUrl));
    console.log('    ITGI_USERNAME      :', describeSecret(config.itgi.username));
    console.log('    ITGI_PASSWORD      :', describeSecret(config.itgi.password));
    console.log('    ITGI_PARTNER_CODE  :', describeSecret(config.itgi.partnerCode));
    console.log('    payment redirect   :', config.itgi.returnUrl || '(ITGI_PAYMENT_RETURN_URL not set)');
    // Resolved the same way the handler resolves it (ITGI's own base, else the
    // global one) — this line is the only startup signal for the value, so it
    // must not report a base the redirect will not actually use.
    console.log('    frontend redirect  :', `${config.itgi.frontendUrl || config.frontendUrl}${config.itgi.frontendReturnPath}`);
  }
  console.log('');

  // ── Future Generali ──
  //
  // Reported the IFFCO Tokio way and for the same reason: no bundled fallbacks,
  // so there is no FALLBACK level here — a value is either set or missing, and
  // missing means those endpoints answer 503 while everything else keeps
  // working.
  //
  // The legs are reported SEPARATELY because they fail independently. A
  // deployment can quote perfectly with no gateway configured, and the first
  // sign of that gap would otherwise be a buyer who cannot pay.
  const fgMissing = missingFgVariables();
  const fgPaymentMissing = missingFgPaymentVariables();
  console.log('  Future Generali (optional — Niva Bupa and IFFCO Tokio are unaffected either way)');
  if (fgIsUnconfigured()) {
    console.log('    not configured — /future-generali endpoints answer 503');
  } else {
    console.log('    BO service        :', describeUrl(`${config.fg.boBaseUrl || ''}${config.fg.paths.boService}`));
    console.log('    document service  :', describeUrl(`${config.fg.pdfBaseUrl || ''}${config.fg.paths.pdfService}`));
    console.log('    FG_VENDOR_CODE    :', describeSecret(config.fg.vendorCode));
    console.log('    FG_AGENT_CODE     :', describeSecret(config.fg.agentCode));
    console.log('    FG_BRANCH_CODE    :', describeSecret(config.fg.branchCode));
    console.log('    FG_BANCA_CHANNEL  :', describeSecret(config.fg.bancaChannel));
    console.log('    CKYC service      :', fgCkycFlavour());
    console.log('    payment gateway   :', describeUrl(config.fg.payment.gatewayUrl));
    console.log('    payment ResponseURL:', config.fg.payment.returnUrl || '(FG_PAYMENT_RETURN_URL not set)');
    console.log('    frontend redirect :', `${config.frontendUrl}${config.fg.frontendReturnPath}`);
  }
  console.log('');

  // ── ICICI Lombard ──
  //
  // Reported the IFFCO Tokio / Future Generali way and for the same reason: no
  // bundled fallbacks, so a value is either set or missing, and missing means
  // the /icici-lombard endpoints answer 503 while everything else keeps working.
  const iciciMissing = missingIciciVariables();
  console.log('  ICICI Lombard (optional — every other insurer is unaffected either way)');
  if (iciciIsUnconfigured()) {
    console.log('    not configured — /icici-lombard endpoints answer 503');
  } else {
    console.log('    base URL           :', describeUrl(config.icici.baseUrl));
    console.log('    EL_LOGIN           :', describeSecret(config.icici.login));
    console.log('    EL_PASSWORD        :', describeSecret(config.icici.password));
    console.log('    password sent      :', config.icici.passwordPreEncrypted ? 'pre-encrypted (EL_PASSWORD_PRE_ENCRYPTED)' : `encrypted here with ${config.icici.aesMode}`);
    if (!config.icici.passwordPreEncrypted) {
      console.log('    EL_AES_KEY         :', describeSecret(config.icici.aesKey));
    }
    console.log('    EL_CLIENT_NAME     :', describeSecret(config.icici.clientName));
  }
  console.log('');

  // ── Chola MS ──
  //
  // Reported the ICICI way and for the same reason: no bundled fallbacks, so a
  // value is either set or missing, and missing means the /chola-ms endpoints
  // answer 503 while everything else keeps working. The CKYC portal has its own
  // credentials and is reported as its own leg.
  const cholaMissing = missingCholaVariables();
  const cholaCkycMissing = missingCholaCkycVariables();
  console.log('  Chola MS (optional — every other insurer is unaffected either way)');
  if (cholaIsUnconfigured()) {
    console.log('    not configured — /chola-ms endpoints answer 503');
  } else {
    console.log('    base URL                :', describeUrl(config.chola.baseUrl));
    console.log('    CHOLA_CLIENT_ID         :', describeSecret(config.chola.clientId));
    console.log('    CHOLA_CLIENT_SECRET     :', describeSecret(config.chola.clientSecret));
    console.log('    CHOLA_INTERMEDIARY_CODE :', describeSecret(config.chola.intermediaryCode));
    console.log('    Super Topup ProposalSave:', describeUrl(config.chola.topupProposalUrl));
    console.log('    CKYC portal             :', describeUrl(config.chola.ckyc.baseUrl));
    console.log('    CHOLA_CKYC_PRIVATE_KEY  :', describeSecret(config.chola.ckyc.privateKey));
    console.log('    payment mode            :', config.chola.paymentMode);
    console.log('    CHOLA_OPS_KEY           :', describeSecret(config.chola.opsKey));
  }
  console.log('');

  const fatal = [];

  if (!cholaIsUnconfigured()) {
    if (cholaMissing.length > 0) {
      console.warn('  ⚠️  Chola MS is PARTIALLY configured — missing:');
      console.warn(`       ${cholaMissing.join(', ')}`);
      console.warn('       The /chola-ms endpoints will answer 503 until these are set.');
      console.warn('');
      // Not fatal in production, for the same reason a half-configured ICICI is
      // not: it must not stop a working deployment of the others booting.
      if (strict) fatal.push(...cholaMissing);
    }
    if (cholaCkycMissing.length > 0) {
      console.warn(`  ⚠️  Chola MS CKYC is not configured — missing ${cholaCkycMissing.join(', ')}.`);
      console.warn('       Quote, proposal and PolicyGeneration work; the CKYC routes do not.');
      console.warn('');
    }
    if (!CHOLA_PAYMENT_MODES.includes(config.chola.paymentMode)) {
      console.warn(`  ⚠️  CHOLA_PAYMENT_MODE "${config.chola.paymentMode}" is not one of ${CHOLA_PAYMENT_MODES.join(', ')}.`);
      console.warn('       Backend-built PolicyGeneration (the ops route) will answer 503.');
      console.warn('');
    }
    // Refused at request time rather than here: a boot failure would take every
    // other insurer down with it. Said loudly, because it is the accident.
    if (isProduction && config.chola.paymentMode === 'APD') {
      console.error('  ❌ CHOLA_PAYMENT_MODE=APD with NODE_ENV=production. APD is UAT-only and is refused:');
      console.error('       every Chola PolicyGeneration will answer 503 until the mode is changed.');
      console.error('');
    }
    // The accident this whole report exists for: NODE_ENV says production, a
    // Chola host says UAT. The Super Topup host is "genconpreprod", which none of
    // looksLikeUat()'s words cover, so pre-prod is named explicitly.
    const cholaUatEndpoints = [
      ['CHOLA_BASE_URL', config.chola.baseUrl],
      ['CHOLA_CKYC_BASE_URL', config.chola.ckyc.baseUrl],
      ['CHOLA_TOPUP_PROPOSAL_URL', config.chola.topupProposalUrl],
    ].filter(([, value]) => looksLikeUat(value) || /preprod/i.test(value || '')).map(([name]) => name);
    if (isProduction && cholaUatEndpoints.length > 0) {
      console.error('  ❌ NODE_ENV=production but these Chola MS endpoints still point at UAT/pre-prod:');
      console.error(`       ${cholaUatEndpoints.join(', ')}`);
      console.error('');
      fatal.push(...cholaUatEndpoints);
    }
  }

  if (!iciciIsUnconfigured()) {
    if (iciciMissing.length > 0) {
      console.warn('  ⚠️  ICICI Lombard is PARTIALLY configured — missing:');
      console.warn(`       ${iciciMissing.join(', ')}`);
      console.warn('       The /icici-lombard endpoints will answer 503 until these are set.');
      console.warn('');
      // Not fatal in production, for the same reason a half-configured ITGI or
      // FG is not: it must not stop a working deployment of the others booting.
      if (strict) fatal.push(...iciciMissing);
    }
    if (!config.icici.clientName) {
      console.warn('  ⚠️  EL_CLIENT_NAME is not set. Quote, CKYC, proposal and status work; the');
      console.warn('       certificate-of-insurance path carries an empty {clientname} segment.');
      console.warn('');
    }
    // The accident this whole report exists for: NODE_ENV says production, the
    // host says UAT. ICICI's UAT host (…insurancearticlez.com) contains none of
    // the words looksLikeUat() knows, so it is named explicitly.
    const iciciUat = looksLikeUat(config.icici.baseUrl) || /insurancearticlez/i.test(config.icici.baseUrl || '');
    if (isProduction && iciciUat) {
      console.error('  ❌ NODE_ENV=production but EL_BASE_URL still points at ICICI Lombard UAT:');
      console.error(`       ${describeUrl(config.icici.baseUrl)}`);
      console.error('');
      fatal.push('EL_BASE_URL');
    }
  }

  if (!fgIsUnconfigured()) {
    if (fgMissing.length > 0) {
      console.warn('  ⚠️  Future Generali is PARTIALLY configured — missing:');
      console.warn(`       ${fgMissing.join(', ')}`);
      console.warn('       The /future-generali endpoints will answer 503 until these are set.');
      console.warn('');
      // Not fatal in production, for the same reason a half-configured ITGI is
      // not: it must not stop a working Niva Bupa deployment from booting.
      if (strict) fatal.push(...fgMissing);
    }

    // ⚠️ Quoting works without this; the proposal and issuance legs do not.
    // Both fail with "BancaChannel Value INVALID", and the correct value is not
    // in FG's integration kit and cannot be derived — FG must issue it for the
    // configured vendor code. Worth saying at boot, because a deployment can
    // look entirely healthy right up to the first proposal.
    if (!config.fg.bancaChannel) {
      console.warn('  ⚠️  FG_BANCA_CHANNEL is not set. Future Generali QUOTES will work; every');
      console.warn('       PROPOSAL and ISSUANCE will fail with "BancaChannel Value INVALID".');
      console.warn('       The value is not in FG\'s kit — ask Future Generali to issue it for');
      console.warn('       the configured FG_VENDOR_CODE.');
      console.warn('');
    }

    if (fgMissing.length === 0 && fgPaymentMissing.length > 0) {
      console.warn('  ⚠️  Future Generali payment is not configured — missing:');
      console.warn(`       ${fgPaymentMissing.join(', ')}`);
      console.warn('       Quote, proposal and CKYC work; /future-generali/payment/* answers 503.');
      console.warn('');
      if (strict) fatal.push(...fgPaymentMissing);
    }

    // ⚠️ Transaction revalidation is a SECURITY control, and its absence is
    // invisible until someone abuses it — so it is said plainly at boot rather
    // than left to be discovered. See services/fgReconcile.service.js for why
    // the encrypted callback authenticates nothing on its own.
    if (fgMissing.length === 0 && !config.fg.payment.reconcileUrl
        && config.fg.payment.gatewayUrl) {
      console.warn('  ⚠️  FG_RECONCILE_URL is not set. Future Generali payments will be issued on');
      console.warn('       the browser callback alone, with no server-to-server confirmation.');
      console.warn('       FG recommend revalidating every transaction precisely because that');
      console.warn('       callback can be tampered with — and the key that encrypts it is');
      console.warn('       published in their integration document, identical for every partner.');
      console.warn('');
      if (strict) fatal.push('FG_RECONCILE_URL');
    }

    // The DES key and IV are checked for SHAPE at boot, not just presence.
    //
    // This is not defensive padding — it catches a specific, silent accident.
    // FG's key contains a '#', and in a .env file an UNQUOTED '#' starts a
    // COMMENT: the variable is then set, looks set in every report, and is two
    // bytes long. Nothing notices until FG's callback arrives and cannot be
    // decrypted, at which point the payment is reported as `unverified` — money
    // may have moved — for a reason that has nothing to do with FG.
    //
    // The fix is to wrap the value in single quotes. The value itself is in
    // .env.example, not here: no credential-shaped literal belongs in source.
    if (config.fg.payment.cryptoKey) {
      const keyBytes = Buffer.byteLength(config.fg.payment.cryptoKey, 'utf8');
      if (keyBytes !== 8) {
        console.error(`  ❌ FG_PG_CRYPTO_KEY is ${keyBytes} bytes; Future Generali's key is 8.`);
        console.error("     If the value contains '#', WRAP IT IN SINGLE QUOTES — an unquoted #");
        console.error('     starts a .env comment and silently truncates the key. The value FG');
        console.error('     publish is in .env.example.');
        console.error('     Left wrong, every payment callback decrypts to nothing and is');
        console.error('     reported as unverified rather than as the successful payment it was.');
        console.error('');
        fatal.push('FG_PG_CRYPTO_KEY');
      }
    }
    if (config.fg.payment.cryptoIv) {
      const parts = String(config.fg.payment.cryptoIv).split(',').map((n) => Number(n.trim()));
      const valid = parts.length === 8
        && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255);
      if (!valid) {
        console.error('  ❌ FG_PG_CRYPTO_IV must be 8 comma-separated byte values (0-255).');
        console.error(`       got ${parts.length} value(s)`);
        console.error('');
        fatal.push('FG_PG_CRYPTO_IV');
      }
    }

    const gcKycGaps = partialFgGcKycVariables();
    if (gcKycGaps.length > 0) {
      console.warn('  ⚠️  FG_GCKYC_ENABLED is on but GC-CKYC 3.0.0 is not fully credentialed:');
      console.warn(`       ${gcKycGaps.join(', ')}`);
      console.warn('       Falling back to the legacy NL-CKYC service, which mints short PR_');
      console.warn('       references — every working FG proposal sample carries the 13-character');
      console.warn('       reference only GC-CKYC issues.');
      console.warn('');
    }

    // The ResponseURL this service SENDS to FG's gateway has to name a path this
    // process actually serves. Unlike ITGI's registered URL there is no third
    // party holding a copy, which makes this cheaper to get wrong and just as
    // expensive when it is: FG post the outcome to whatever they were handed,
    // and a callback that lands on a 404 takes WS_P_ID and PGID with it.
    if (config.fg.payment.returnUrl) {
      const expectedTail = '/future-generali/payment/return';
      if (!config.fg.payment.returnUrl.endsWith(expectedTail)) {
        console.warn(`  ⚠️  FG_PAYMENT_RETURN_URL does not end in ${expectedTail}:`);
        console.warn(`       ${config.fg.payment.returnUrl}`);
        console.warn('       Future Generali POST the payment outcome to exactly this URL. If it');
        console.warn('       is not a route this service serves, a paid buyer\'s WS_P_ID and PGID');
        console.warn('       are lost and the policy cannot be issued.');
        console.warn('');
      } else if (config.aliasPrefix && !config.fg.payment.returnUrl.includes(`${config.aliasPrefix}${expectedTail}`)) {
        // Informational, not a warning: both mounts are served, so the
        // alias-less form works — as long as whatever sits in front of this
        // process proxies it. The deployed Apache proxies only /health.
        console.log(`  ℹ️  FG_PAYMENT_RETURN_URL does not go through the ${config.aliasPrefix} alias.`);
        console.log('       Both mounts are served here, but a reverse proxy in front of this');
        console.log(`       process may only forward ${config.aliasPrefix}/*.`);
        console.log('');
      }
    }
  }

  if (itgiMissing.length > 0 && !itgiIsUnconfigured()) {
    console.warn('  ⚠️  IFFCO Tokio is PARTIALLY configured — missing:');
    console.warn(`       ${itgiMissing.join(', ')}`);
    console.warn('       The /iffcotokio endpoints will answer 503 until these are set.');
    console.warn('');
    // Not fatal in production: a half-configured ITGI must not stop a working
    // Niva Bupa deployment from booting. STRICT_ENV=1 makes it fatal for a
    // deployment that wants both or neither.
    if (strict) fatal.push(...itgiMissing);
  }

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

  // Same check for IFFCO Tokio, and it applies only when ITGI is configured at
  // all — an unconfigured deployment has no URL to be wrong about.
  if (isProduction && !itgiIsUnconfigured() && looksLikeUat(config.itgi.baseUrl)) {
    console.error('  ❌ NODE_ENV=production but ITGI_BASE_URL still points at UAT/staging:');
    console.error(`       ${describeUrl(config.itgi.baseUrl)}`);
    console.error('');
    fatal.push('ITGI_BASE_URL');
  }

  // Same check for Future Generali, across every host that can be pointed
  // independently plus the payment gateway. The gateway is the sharpest of
  // them: a production build pointed at FG's UAT gateway would take real money
  // on a test tenant, which is the most expensive way this integration can be
  // misconfigured. Applies only when FG is configured at all — an unconfigured
  // deployment has no URL to be wrong about.
  if (isProduction && !fgIsUnconfigured()) {
    const fgUatEndpoints = [
      ['FG_BO_BASE_URL', config.fg.boBaseUrl],
      ['FG_PDF_BASE_URL', config.fg.pdfBaseUrl],
      ['FG_PAYMENT_GATEWAY_URL', config.fg.payment.gatewayUrl],
      ['FG_GCKYC_BASE_URL', config.fg.gcKyc.baseUrl],
      ['FG_CKYC_BASE_URL', config.fg.ckyc.baseUrl],
    ].filter(([, value]) => looksLikeUat(value)).map(([name]) => name);

    if (fgUatEndpoints.length > 0) {
      console.error('  ❌ NODE_ENV=production but these Future Generali endpoints still point at UAT/staging:');
      console.error(`       ${fgUatEndpoints.join(', ')}`);
      console.error('');
      fatal.push(...fgUatEndpoints);
    }
  }

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
