// ─────────────────────────────────────────────────────────────────────────────
// NivaBupa (Reassure 3.0) partner-API module — the whole integration behind one
// boundary. app.js/server.js import only from this file: the router to mount,
// and the two background-lifecycle functions the entrypoint drives.
//
// The module is self-contained (own config, own MySQL pool, own middleware, own
// token caches) and imports nothing outside src/. That boundary is what let it
// be lifted out of the tf-api process it previously shared, and keeping it is
// what would let it be embedded again.
//
// Layout:
//   config/     env resolution + the single table of bundled fallbacks
//   constants/  journey step machine, payment querystring field order
//   helpers/    payment querystring build/parse, minimal SOAP XML primitives
//   utils/      token cache, JWT exp decode, redaction/coercion helpers
//   db/         mysql2 pool + transaction runner (policy_db)
//   repositories/  raw SQL per journey table
//   services/   NivaBupa auth, generic API, case API, SOAP, journey persistence
//   middleware/ journey context resolution, access log, error/404 envelopes
//   controllers/ auth, quote, proposal, payment, case, journey
//   routes/     one file per family + the composed router
// ─────────────────────────────────────────────────────────────────────────────
import config, {
  missingItgiVariables, itgiIsUnconfigured,
  missingFgVariables, missingFgPaymentVariables, fgIsUnconfigured, fgCkycFlavour,
  missingIciciVariables, iciciIsUnconfigured,
  missingCholaVariables, cholaIsUnconfigured, missingCholaCkycVariables,
} from './config/env.js';
import db from './db/index.js';
import * as journeyService from './services/journey.service.js';
import { missingKycVariables } from './services/nivabupaKyc.service.js';
import { paymentGatewayUrl as itgiPaymentGatewayUrl } from './helpers/itgi.helper.js';

export {
  createNivabupaRouter,
  createItgiRouter,
  createFgRouter,
  createIciciRouter,
  createCholaRouter,
  createNivabupaProbeRouter,
  NIVABUPA_PATH_PREFIX,
  ITGI_PATH_PREFIX,
  FG_PATH_PREFIX,
  ICICI_PATH_PREFIX,
  CHOLA_PATH_PREFIX,
} from './routes/index.js';

let sweeper = null;

// Called once after the HTTP listener is up.
//
// Resume must survive a restart, and it does: no journey state lives in process
// memory. Everything the SPA needs to rehydrate is read from MySQL on demand
// (see services/journey.service.buildSnapshot), so a fresh process serves the
// same snapshot the old one would have. The only in-memory state in this module
// is the NivaBupa auth token cache, which is disposable by design.
//
// The database is checked here rather than lazily so a misconfigured one shows
// up at boot instead of as a silent loss of journey saves on the buyer's first
// quote. A failure is reported, never thrown: the eight NivaBupa pass-through
// endpoints worked before journey persistence existed and must keep working
// when MySQL is down.
export async function startNivabupa() {
  const alias = config.aliasPrefix;

  console.log('───────────────────────────────────────────────────────');
  console.log('🩺 NivaBupa Partner API (Reassure 3.0)');
  console.log('');
  console.log('  AUTH     : GET  /nivabupa/token/test');
  console.log('  QUOTE    : POST /nivabupa/premium');
  console.log('  PROPOSAL : POST /nivabupa/uw-decision');
  console.log('  DATAPUSH : POST /nivabupa/datapush');
  console.log('  PAYMENT  : POST /nivabupa/payment/initiate');
  console.log('  CALLBACK : POST /nivabupa/payment/return');
  console.log('  CASE API : POST /nivabupa/proposal-status');
  console.log('  CASE API : POST /nivabupa/policy-download');
  console.log('  KYC      : POST /nivabupa/kyc/RedirectionLinkEnc   (Niva Bupa-hosted KYC page)');
  console.log('  KYC      : POST /nivabupa/kyc/GetKycStatusEnc');
  console.log('  KYC      : POST /nivabupa/kyc/EKYCOTPDetailEnc');
  console.log('  KYC      : POST /nivabupa/kyc/EKYCDetailEnc');
  console.log('  KYC      : POST /nivabupa/kyc/ReSendOTPEnc');
  console.log('  LIVENESS : GET  /healthz');
  console.log('  READY    : GET  /readyz        (includes MySQL check)');
  console.log('');
  console.log('  ── Journey break / resume ──');
  console.log('  JOURNEY  : POST   /nivabupa/journey');
  console.log('  RESUME   : POST   /nivabupa/journey/resume');
  console.log('  RESUME   : POST   /nivabupa/journey/resume-by-mobile');
  console.log('  RESTORE  : GET    /nivabupa/journey/:journeyId');
  console.log('  AUTOSAVE : PATCH  /nivabupa/journey/:journeyId/step');
  console.log('  SELECT   : POST   /nivabupa/journey/:journeyId/select-quote');
  console.log('  PROPOSAL : PUT    /nivabupa/journey/:journeyId/proposal');
  console.log('  KYC      : PUT    /nivabupa/journey/:journeyId/kyc');
  console.log('  DOCUMENT : GET    /nivabupa/journey/:journeyId/policy-document');
  console.log('  TIMELINE : GET    /nivabupa/journey/:journeyId/timeline');
  console.log('  ABANDON  : POST   /nivabupa/journey/:journeyId/abandon');
  console.log('');
  if (alias) {
    console.log(`  (every /nivabupa route is also served under the ${alias} prefix)`);
  }
  console.log(`  Payment returnPath → ${config.nivabupa.payment.returnUrl}`);
  console.log(`  Frontend redirect  → ${config.frontendUrl}${config.frontendReturnPath}`);
  const kycMissing = missingKycVariables();
  if (kycMissing.length) {
    console.warn(`  ⚠️  NivaBupa KYC not configured — missing ${kycMissing.join(', ')}.`);
    console.warn('     /nivabupa/kyc/* answer 503 and /nivabupa/uw-decision refuses proposals until set.');
  } else {
    console.log(`  KYC API            → ${config.nivabupa.kyc.baseUrl}`);
  }

  reportItgi(alias);
  reportFg(alias);
  reportIcici(alias);
  reportChola(alias);

  const dbStatus = await db.verifyConnection();
  if (dbStatus.ok) {
    console.log(`  🗄️  MySQL: connected → ${dbStatus.db} (server ${dbStatus.version})`);
    console.log(`  💾 Journey persistence: ENABLED (resume TTL ${config.journey.ttlDays}d, abandon after ${config.journey.abandonAfterHours}h)`);
    startSweeper();
  } else {
    console.error(`  ⚠️  MySQL: NOT connected — ${dbStatus.error}`);
    console.error('  ⚠️  Journey persistence DISABLED. NivaBupa pass-through endpoints still work;');
    console.error('     journeys will not be saved or resumable. Run: npm run migrate');
  }
  console.log('───────────────────────────────────────────────────────');

  return dbStatus;
}

// The IFFCO Tokio half of the boot banner.
//
// Printed even when ITGI is not configured, and it says so: an operator who
// expected the endpoints to be live needs to see that they are not, and an
// operator who never set ITGI up needs to see that nothing is broken. Neither
// state affects NivaBupa or stops this process starting.
//
// No value is printed. The endpoint host is — that is the single most useful
// line here, because "staging.iffcotokio.co.in" against a production NODE_ENV
// is the accident this whole report exists to surface (and config/validate.js
// refuses to start on it).
function reportItgi(alias) {
  const missing = missingItgiVariables();

  console.log('');
  console.log('🩺 IFFCO Tokio Partner Health (FHP / IHP)');
  console.log('');

  if (itgiIsUnconfigured()) {
    console.log('  Not configured — the /iffcotokio endpoints answer 503 naming what is missing.');
    console.log('  Set ITGI_BASE_URL, ITGI_USERNAME, ITGI_PASSWORD and ITGI_PARTNER_CODE to enable.');
    console.log('  Niva Bupa is unaffected.');
    return;
  }

  console.log('  CONFIG   : GET  /iffcotokio/config/test');
  console.log('  QUOTE    : POST /iffcotokio/premium');
  console.log('  PROPOSAL : POST /iffcotokio/proposal');
  console.log('  PAYMENT  : POST /iffcotokio/payment/initiate     (builds the gateway form)');
  console.log('  CALLBACK : GET  /iffcotokio/payment/return       ⚠️ registered with ITGI');
  console.log('  CONFIRM  : POST /iffcotokio/payment/confirmation (partner-end collection only)');
  console.log('  DOCUMENT : POST /iffcotokio/policy-download');
  console.log('  CKYC     : POST /iffcotokio/kyc/fetch');
  console.log('  CKYC     : POST /iffcotokio/kyc/create');
  console.log('');
  if (alias) {
    console.log(`  (every /iffcotokio route is also served under the ${alias} prefix)`);
  }
  console.log(`  Upstream base      → ${config.itgi.baseUrl}`);
  console.log(`  Payment gateway    → ${itgiPaymentGatewayUrl()}`);
  console.log(`  Frontend redirect  → ${config.frontendUrl}${config.itgi.frontendReturnPath}`);

  // ITGI hold the response URL on their side, keyed to the partner code. If it
  // does not end in the path this process actually serves, a successful payment
  // lands on a 404 and the policy number — which reaches us nowhere else — is
  // lost. Six live UAT payments were lost exactly this way on 2026-08-26, which
  // is why this is checked at boot rather than discovered afterwards.
  const expectedTail = `${alias || ''}/iffcotokio/payment/return`;
  if (config.itgi.returnUrl) {
    const matches = config.itgi.returnUrl.endsWith('/iffcotokio/payment/return');
    console.log(`  ITGI redirects to  → ${config.itgi.returnUrl} ${matches ? '✅' : '❌ NOT a route this service serves'}`);
    if (!matches) {
      console.error('  ❌ ITGI_PAYMENT_RETURN_URL does not end in /iffcotokio/payment/return.');
      console.error('     A successful payment will 404 and the policy number will be lost —');
      console.error('     it reaches this service through that redirect and nowhere else.');
    }
  } else {
    console.warn('  ⚠️  ITGI_PAYMENT_RETURN_URL is not set, so the URL ITGI redirect buyers to');
    console.warn(`     cannot be checked against this service. It must end in ${expectedTail}`);
  }

  if (missing.length > 0) {
    console.error(`  ❌ Partially configured — missing ${missing.join(', ')}. These endpoints answer 503.`);
  }
}

// The Future Generali half of the boot banner.
//
// Printed even when FG is not configured, and it says so — same reasoning as
// reportItgi: an operator who expected the endpoints to be live needs to see
// that they are not, and one who never set FG up needs to see that nothing is
// broken. Neither state affects Niva Bupa or IFFCO Tokio, and neither stops this
// process starting.
//
// No credential, vendor code or agent code is printed. The endpoint hosts are —
// those are the lines that surface the accident this report exists for.
function reportFg(alias) {
  console.log('');
  console.log('🩺 Future Generali Health (TCS BO service)');
  console.log('');

  if (fgIsUnconfigured()) {
    console.log('  Not configured — the /future-generali endpoints answer 503 naming what is missing.');
    console.log('  Set FG_BO_BASE_URL, FG_VENDOR_CODE, FG_AGENT_CODE and FG_BRANCH_CODE to enable.');
    console.log('  Niva Bupa and IFFCO Tokio are unaffected.');
    return;
  }

  const missing = missingFgVariables();
  const paymentMissing = missingFgPaymentVariables();

  console.log('  CONFIG   : GET  /future-generali/config/test');
  console.log('  QUOTE    : POST /future-generali/quote            CreatePolicy  METHOD=ENQ');
  console.log('  PROPOSAL : POST /future-generali/proposal         HealthPreCRTValidate');
  console.log('  ISSUE    : POST /future-generali/issue            CreatePolicy  METHOD=CRT');
  console.log('  CKYC     : POST /future-generali/ckyc/create');
  console.log('  CKYC     : POST /future-generali/ckyc/status');
  console.log('  PAYMENT  : POST /future-generali/payment/session  (builds the gateway form)');
  console.log('  CALLBACK : ALL  /future-generali/payment/return   ⚠️ FG POST the outcome here');
  console.log('  RESULT   : GET  /future-generali/payment/result/:token');
  console.log('  ISSUE    : POST /future-generali/payment/issue    (at most once per payment)');
  console.log('  DOCUMENT : GET  /future-generali/policy/:policyNo/pdf');
  console.log('  DOCUMENT : GET  /future-generali/policy/:policyNo/pdf/download');
  console.log('');
  if (alias) {
    console.log(`  (every /future-generali route is also served under the ${alias} prefix)`);
  }
  console.log(`  BO service         → ${config.fg.boBaseUrl}${config.fg.paths.boService}`);
  console.log(`  Document service   → ${config.fg.pdfBaseUrl}${config.fg.paths.pdfService}`);
  console.log(`  CKYC service       → ${fgCkycFlavour()}`);
  console.log(`  Payment gateway    → ${config.fg.payment.gatewayUrl || '(FG_PAYMENT_GATEWAY_URL not set)'}`);
  console.log(`  Frontend redirect  → ${config.frontendUrl}${config.fg.frontendReturnPath}`);

  // Unlike ITGI, FG hold no registered return URL: this service SENDS the
  // ResponseURL on every payment form, so this variable alone decides where the
  // outcome lands. If it does not name a route this process serves, a paid
  // buyer's WS_P_ID and PGID — which issuance is impossible without — are lost.
  if (config.fg.payment.returnUrl) {
    const matches = config.fg.payment.returnUrl.endsWith('/future-generali/payment/return');
    console.log(`  FG posts outcome to → ${config.fg.payment.returnUrl} ${matches ? '✅' : '❌ NOT a route this service serves'}`);
    if (!matches) {
      console.error('  ❌ FG_PAYMENT_RETURN_URL does not end in /future-generali/payment/return.');
      console.error('     A completed payment will 404 and its references will be lost.');
    }
  } else {
    console.warn('  ⚠️  FG_PAYMENT_RETURN_URL is not set — the payment routes answer 503.');
    console.warn(`     It must end in ${alias || ''}/future-generali/payment/return`);
  }

  // Quoting works without this; proposal and issuance do not.
  if (!config.fg.bancaChannel) {
    console.warn('  ⚠️  FG_BANCA_CHANNEL is not set — quotes work, but every PROPOSAL and');
    console.warn('     ISSUANCE fails with "BancaChannel Value INVALID". Ask FG to issue it.');
  }

  if (missing.length > 0) {
    console.error(`  ❌ Partially configured — missing ${missing.join(', ')}. These endpoints answer 503.`);
  }
  if (missing.length === 0 && paymentMissing.length > 0) {
    console.warn(`  ⚠️  Payment not configured — missing ${paymentMissing.join(', ')}.`);
    console.warn('     Quote, proposal and CKYC work; /future-generali/payment/* answers 503.');
  }
}

// The ICICI Lombard half of the boot banner.
//
// Printed even when ICICI is not configured, and it says so — same reasoning as
// reportItgi and reportFg. Neither state affects any other insurer, and neither
// stops this process starting.
//
// No login, password, AES key or client name is printed. The host is — it is
// the line that shows UAT against a production NODE_ENV.
function reportIcici(alias) {
  console.log('');
  console.log('🩺 ICICI Lombard — Elevate Health');
  console.log('');

  if (iciciIsUnconfigured()) {
    console.log('  Not configured — the /icici-lombard endpoints answer 503 naming what is missing.');
    console.log('  Set EL_BASE_URL, EL_LOGIN and EL_PASSWORD (+ EL_PASSWORD_PRE_ENCRYPTED or EL_AES_KEY).');
    console.log('  Niva Bupa, IFFCO Tokio and Future Generali are unaffected.');
    return;
  }

  const missing = missingIciciVariables();

  console.log('  CONFIG   : GET  /icici-lombard/config/test');
  console.log('  QUOTE    : POST /icici-lombard/quote             premium (mints TransactionId bnc_…)');
  console.log('  CKYC     : POST /icici-lombard/ckyc');
  console.log('  CKYC     : POST /icici-lombard/ckyc/ovd          (document-upload fallback)');
  console.log('  PROPOSAL : POST /icici-lombard/proposal          proposal-payment → PaymentUrl');
  console.log('  STATUS   : POST /icici-lombard/policy/status     authoritative after hosted payment');
  console.log('  ISSUE    : POST /icici-lombard/issue             policy sync (partner-collected payment)');
  console.log('  DOCUMENT : GET  /icici-lombard/coi/:transactionId');
  console.log('  EMI      : POST /icici-lombard/emi/due');
  console.log('  EMI      : POST /icici-lombard/emi/process');
  console.log('  ZONE     : POST /icici-lombard/zone');
  console.log('');
  if (alias) {
    console.log(`  (every /icici-lombard route is also served under the ${alias} prefix)`);
  }
  console.log(`  Upstream base      → ${config.icici.baseUrl || '(EL_BASE_URL not set)'}`);
  console.log(`  Password           → ${config.icici.passwordPreEncrypted ? 'sent pre-encrypted' : `encrypted here (${config.icici.aesMode})`}`);

  if (!config.icici.clientName) {
    console.warn('  ⚠️  EL_CLIENT_NAME is not set — the certificate-of-insurance path will carry an');
    console.warn('     empty {clientname} segment and /icici-lombard/coi will fail.');
  }
  if (missing.length > 0) {
    console.error(`  ❌ Partially configured — missing ${missing.join(', ')}. These endpoints answer 503.`);
  }
}

// The Chola MS half of the boot banner.
//
// Printed even when Chola is not configured, and it says so — same reasoning as
// the other insurers. Neither state affects any other insurer, and neither
// stops this process starting.
//
// No client id, secret, intermediary code, CKYC key or ops key is printed. The
// hosts and the payment mode are — the mode decides whether the website's
// PolicyGeneration spends NovaCred's deposit.
function reportChola(alias) {
  console.log('');
  console.log('🩺 Chola MS — Flexi Health / Supreme / Super Topup');
  console.log('');

  if (cholaIsUnconfigured()) {
    console.log('  Not configured — the /chola-ms endpoints answer 503 naming what is missing.');
    console.log('  Set CHOLA_BASE_URL, CHOLA_CLIENT_ID, CHOLA_CLIENT_SECRET and CHOLA_INTERMEDIARY_CODE.');
    console.log('  Niva Bupa, IFFCO Tokio, Future Generali and ICICI Lombard are unaffected.');
    return;
  }

  const missing = missingCholaVariables();
  const ckycMissing = missingCholaCkycVariables();

  console.log('  CONFIG   : GET  /chola-ms/config/test');
  console.log('  QUOTE    : POST /chola-ms/PremiumComputation     (also /chola-ms/quote)');
  console.log('  CKYC     : POST /chola-ms/CholaMS_CKYC_Verify    (also /chola-ms/ckyc/verify)');
  console.log('  CKYC     : POST /chola-ms/CholaMS_CKYC_Query     (also /chola-ms/ckyc/query)');
  console.log('  PROPOSAL : POST /chola-ms/ProposalSave           (also /chola-ms/proposal)');
  console.log('  PAYMENT  : POST /chola-ms/PolicyGeneration       (also /chola-ms/issue) ⚠️ not idempotent');
  console.log('  DOCUMENT : POST /chola-ms/PolicySchedule         (also /chola-ms/policy/schedule)');
  console.log('  OPS      : /chola-ms/ops/*                       X-Ops-Key; screen at GET /chola-ms/ops');
  console.log('');
  if (alias) {
    console.log(`  (every /chola-ms route is also served under the ${alias} prefix)`);
  }
  console.log(`  Upstream base      → ${config.chola.baseUrl || '(CHOLA_BASE_URL not set)'}`);
  console.log(`  Super Topup save   → ${config.chola.topupProposalUrl || '(CHOLA_TOPUP_PROPOSAL_URL not set — Super Topup ProposalSave answers 503)'}`);
  console.log(`  CKYC portal        → ${config.chola.ckyc.baseUrl || '(CHOLA_CKYC_BASE_URL not set)'}`);
  console.log(`  Payment mode       → ${config.chola.paymentMode}`);
  console.log(`  Ops routes         → ${config.chola.opsKey ? 'enabled' : 'disabled (CHOLA_OPS_KEY not set)'}`);

  if (config.chola.paymentMode === 'APD') {
    console.warn('  ⚠️  CHOLA_PAYMENT_MODE=APD — the website\'s PolicyGeneration issues from NovaCred\'s');
    console.warn('     Advance Premium Deposit with Chola: no payment page, the deposit is debited.');
    if (config.env === 'production') {
      console.error('  ❌ APD is UAT-only and is REFUSED when NODE_ENV=production — every PolicyGeneration');
      console.error('     will answer 503 until CHOLA_PAYMENT_MODE is changed.');
    }
  } else if (!config.chola.publicUrlBase) {
    console.warn('  ⚠️  CHOLA_PUBLIC_URL_BASE is not set. Chola return the hosted payment page on their');
    console.warn('     INTERNAL address (http://10.105.63.69 on UAT); it is passed through unchanged.');
  }
  if (ckycMissing.length > 0) {
    console.warn(`  ⚠️  CKYC not configured — missing ${ckycMissing.join(', ')}. /chola-ms CKYC routes will fail.`);
  }
  if (missing.length > 0) {
    console.error(`  ❌ Partially configured — missing ${missing.join(', ')}. These endpoints answer 503.`);
  }
}

// Ages idle journeys to ABANDONED and past-expiry ones to EXPIRED. Runs
// in-process on an interval because there is no scheduler; unref() so a
// pending timer never holds the process open during shutdown.
function startSweeper() {
  const intervalMs = config.journey.sweepIntervalMinutes * 60 * 1000;
  sweeper = setInterval(async () => {
    const result = await journeyService.sweepStaleJourneys();
    if (result && (result.abandoned > 0 || result.expired > 0)) {
      console.log(`🧹 Journey sweep: ${result.abandoned} abandoned, ${result.expired} expired`);
    }
  }, intervalMs);
  sweeper.unref();
}

// Called from graceful shutdown, after the HTTP server has closed.
//
// Draining the pool matters for resume correctness: a transaction killed
// mid-commit could leave a journey pointing at a step whose rows are
// half-written, which is the one state buildSnapshot cannot recover from.
export async function stopNivabupa() {
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
  try {
    await db.closePool();
    console.log('🗄️  NivaBupa MySQL pool closed.');
  } catch (error) {
    console.error('⚠️  Error closing NivaBupa MySQL pool:', error.message);
  }
}
