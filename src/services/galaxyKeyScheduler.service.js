import config from '../config/env.js';
import { GALAXY_KEY_FETCHES_PER_DAY } from '../constants/galaxy.constants.js';
import { galaxyLog as logger } from '../helpers/galaxy.helper.js';
import { istDate, istTime } from '../helpers/galaxyKeyDay.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The daily getCurrentPubKey job. GHI mail, 29 Oct 2026: schedule it "Non-PRD:
// 5:05 AM onwards, PRD: 12:05 AM onwards" (IST); a GHI key is valid only on its
// day, and the day's key must be fetched before any business call.
//
// Moved unchanged from the working implementation (src/providers/galaxy/
// gxKeyScheduler.js). Started by index.js only when GX_KEY_SCHEDULER is on.
//
// Fetches at `at` (HH:MM, IST) every day, and at start-up when today's key is
// missing and `at` has passed. A timeout, network failure or 5xx is retried
// every `retryMinutes` while today's key fetches last (GALAXY_KEY_FETCHES_PER_DAY,
// counted in the key store, so restarts cannot exceed them). Any other failure
// would fail the same way again, so the job waits for the next day and leaves
// the remaining fetches for a manual one after the fix.
//
// Run it on ONE instance only: every fetch registers a new NovaCred key with
// GHI, which breaks business calls made from any other key store. Its timer is
// unref'd, so it never holds the process open.
//
// @param {import('./galaxyClient.service.js').GxClient} client
// @returns {{ stop: () => void }}
// ─────────────────────────────────────────────────────────────────────────────
export function startGxKeyScheduler(client, { at = config.galaxy.keyRefreshAt, retryMinutes = config.galaxy.keyRetryMinutes } = {}) {
  istTime(at); // a bad GX_KEY_REFRESH_AT fails here, at start-up
  let timer = null;
  let stopped = false;

  const wait = (ms, when) => {
    if (stopped) return;
    timer = setTimeout(tick, Math.max(ms, 1000));
    timer.unref?.();
    logger.info(`next getCurrentPubKey check: ${when}, in ${Math.round(ms / 60000)} min`);
  };
  const tomorrow = () => wait(istTime(at, new Date(), 1) - Date.now(), `tomorrow ${at} IST`);

  async function run() {
    const ks = client.keyStore;
    const now = new Date();
    if (ks.hasGhiKeyFor(now, at)) return tomorrow();
    const untilToday = istTime(at, now) - now;
    if (untilToday > 0) return wait(untilToday, `today ${at} IST`);
    if (ks.keyFetchesOn(now) >= GALAXY_KEY_FETCHES_PER_DAY) {
      logger.error(`no GHI key for ${istDate(now)} and today's ${GALAXY_KEY_FETCHES_PER_DAY} getCurrentPubKey calls are used; business calls stay blocked until tomorrow`);
      return tomorrow();
    }
    try {
      await client.getCurrentPubKey();
      logger.info(`GHI public key for ${istDate(now)} fetched`);
      return tomorrow();
    } catch (e) {
      const left = GALAXY_KEY_FETCHES_PER_DAY - ks.keyFetchesOn();
      logger.error(`scheduled getCurrentPubKey failed: ${e.message}`, { code: e.code, left });
      if (isTransient(e)) return wait(retryMinutes * 60 * 1000, 'retry');
      logger.error(`not retried: the same request would fail again; ${left} call(s) left today for a manual fetch after the fix`);
      return tomorrow();
    }
  }

  function tick() {
    run().catch((e) => {
      logger.error(`key scheduler error: ${e.message}`);
      wait(retryMinutes * 60 * 1000, 'retry');
    });
  }

  tick();
  return { stop() { stopped = true; clearTimeout(timer); } };
}

// A timeout, a network failure (galaxyHttp sets details.errorCode) or a 5xx may
// pass on a later try; a 4xx or a bad response would not.
export function isTransient(e) {
  if (e?.code === 'TIMEOUT_ERROR') return true;
  if (e?.code !== 'UPSTREAM_ERROR' || !e.details) return false;
  return Number(e.details.status ?? e.details.httpStatus) >= 500 || 'errorCode' in e.details;
}
