import { configError } from './galaxy.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Day arithmetic for GHI's key rotation, which runs on IST (UTC+05:30, no DST).
// GHI generates its key of the day at 05:00 (UAT) / 00:00 (prod), asks for it to
// be fetched from 05:05 / 00:05, and the key is valid until 23:59 of that day
// (GHI mail, 29 Oct 2026).
//
// Moved unchanged from the working implementation (src/providers/galaxy/gxKeyDay.js).
// ─────────────────────────────────────────────────────────────────────────────
const IST_OFFSET_MS = 330 * 60 * 1000;

/** The IST calendar date of `d`, as YYYY-MM-DD. */
export function istDate(d = new Date()) {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The instant of `at` (HH:MM, IST) on the IST day `days` after `now`'s. */
export function istTime(at, now = new Date(), days = 0) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(at));
  if (!m) throw configError(`GX_KEY_REFRESH_AT must be HH:MM (IST), got "${at}"`);
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, Number(m[1]), Number(m[2])) - IST_OFFSET_MS);
}
