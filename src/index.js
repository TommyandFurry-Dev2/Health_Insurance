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
import config from './config/env.js';
import db from './db/index.js';
import * as journeyService from './services/journey.service.js';

export {
  createNivabupaRouter,
  createNivabupaProbeRouter,
  NIVABUPA_PATH_PREFIX,
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
