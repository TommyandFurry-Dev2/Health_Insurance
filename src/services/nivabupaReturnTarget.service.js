import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import config from '../config/env.js';

// The frontend return page each Niva Bupa payment asked for, kept between
// POST /nivabupa/payment/initiate and the gateway callback.
//
// The callback carries nothing of ours except the unqPolicyNumber the gateway
// echoes back as uniqueReferenceId, so the page the initiating frontend named
// has to be stored against that number until the callback arrives.
//
// On disk, one small file per payment, and deliberately not:
//   * in memory: a restart between initiate and callback, or a second worker
//     answering the callback, would send the buyer to the wrong frontend;
//   * in MySQL: the journey tables are not there on every deployment. On UAT
//     (checked 2026-10-31) the schema has no nivabupa_journeys, so
//     nivabupa_api_transactions, which references it, was never created either,
//     and every write to it is dropped by safeSave.
// This process already writes into its working directory (captureCiphertext in
// controllers/payment.controller.js), and the directory is gitignored.
//
// Never throws. A failed write or read only means the buyer returns to
// FRONTEND_URL, which is where every buyer went before frontends could choose.

// The file name is the reference, so only a value that cannot climb out of the
// directory is accepted. Niva Bupa application numbers are digits.
const SAFE_REFERENCE = /^[A-Za-z0-9_-]{1,80}$/;
// Every file this store writes ends in this, and pruning touches nothing else,
// so a directory shared with other files (a misconfigured
// NIVABUPA_RETURN_TARGET_DIR) never loses anything that is not ours.
const FILE_SUFFIX = '.nivabupa-return.json';
const PRUNE_EVERY_MS = 60 * 60 * 1000;

let lastPruneAt = 0;

function returnTargetDir() {
  return resolve(config.nivabupa.payment.returnTargets.dir);
}

function ttlMs() {
  return config.nivabupa.payment.returnTargets.ttlHours * 60 * 60 * 1000;
}

function fileFor(referenceId) {
  const reference = String(referenceId ?? '');
  return SAFE_REFERENCE.test(reference) ? join(returnTargetDir(), `${reference}${FILE_SUFFIX}`) : null;
}

function isOurs(name) {
  return name.endsWith(FILE_SUFFIX) || (name.includes(`${FILE_SUFFIX}.`) && name.endsWith('.tmp'));
}

// Old files go once they can no longer be honoured, at most once an hour.
// Leftover .tmp files from an interrupted write age out the same way.
function pruneExpired(now = Date.now()) {
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  try {
    for (const name of readdirSync(returnTargetDir())) {
      if (!isOurs(name)) continue;
      const file = join(returnTargetDir(), name);
      try {
        if (now - statSync(file).mtimeMs > ttlMs()) unlinkSync(file);
      } catch {
        // Gone already, or being replaced right now: either way not ours to keep.
      }
    }
  } catch (error) {
    console.error(`   ⚠️ could not prune old Niva Bupa return pages: ${error.message}`);
  }
}

// True once the page is on disk. Written to a temporary file and renamed into
// place, so a callback reading at the same moment never sees half a record, and
// a repeated initiate for the same number simply replaces it.
function rememberReturnTarget(referenceId, url) {
  const file = fileFor(referenceId);
  if (!file) {
    console.warn(`   ⚠️ return page not kept: "${referenceId}" is not a usable reference`);
    return false;
  }
  try {
    mkdirSync(returnTargetDir(), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ referenceId: String(referenceId), url, savedAt: new Date().toISOString() }), 'utf8');
    renameSync(temp, file);
  } catch (error) {
    console.error(`   ⚠️ could not keep the return page for ${referenceId}: ${error.message}`);
    return false;
  }
  pruneExpired();
  return true;
}

// The page kept for this reference, or null: none kept, unreadable, or older
// than the TTL. Not deleted on use, so a callback the browser re-submits lands
// in the same place.
function findReturnTarget(referenceId) {
  const file = fileFor(referenceId);
  if (!file) return null;
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    const savedAt = Date.parse(record?.savedAt);
    if (!Number.isFinite(savedAt) || Date.now() - savedAt > ttlMs()) return null;
    return typeof record.url === 'string' ? record.url : null;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`   ⚠️ could not read the return page for ${referenceId}: ${error.message}`);
    }
    return null;
  }
}

export {
  rememberReturnTarget,
  findReturnTarget,
  returnTargetDir,
  FILE_SUFFIX as RETURN_TARGET_FILE_SUFFIX,
};
