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
import config, { missingItgiVariables, itgiIsUnconfigured } from './config/env.js';
import db from './db/index.js';
import * as journeyService from './services/journey.service.js';
import { paymentGatewayUrl as itgiPaymentGatewayUrl } from './helpers/itgi.helper.js';

export {
  createNivabupaRouter,
  createItgiRouter,
  createNivabupaProbeRouter,
  NIVABUPA_PATH_PREFIX,
  ITGI_PATH_PREFIX,
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

  reportItgi(alias);

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
