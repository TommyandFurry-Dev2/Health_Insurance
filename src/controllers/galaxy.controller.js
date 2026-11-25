import crypto from 'node:crypto';

import config, { missingGalaxyVariables, galaxyIsUnconfigured } from '../config/env.js';
import * as galaxyApi from '../services/galaxyApi.service.js';
import * as galaxyPayment from '../services/galaxyPayment.service.js';
import { galaxyClient } from '../services/galaxyClient.service.js';
import * as journeyService from '../services/journey.service.js';
import {
  GALAXY_API_NAMES, GALAXY_PROVIDER, GALAXY_KEY_FETCHES_PER_DAY, GALAXY_PATH_PREFIX,
} from '../constants/galaxy.constants.js';
import { configError, unauthorizedError } from '../helpers/galaxy.helper.js';
import { maskPersonalData } from '../helpers/galaxyMask.helper.js';
import { SOURCE as DICTIONARY_SOURCE } from '../helpers/galaxyDictionary.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health (GHI) endpoints.
//
// Pass-throughs, in the same sense the other insurers' controllers are: the
// caller sends GHI's own decrypted request body, this service encrypts it for
// GHI, verifies and decrypts GHI's answer, and returns the working
// implementation's envelope.
//
// ── The response envelope is the working implementation's, unchanged ────────
// Success:  { ok, provider:'galaxy', operation, data, meta:{ requestUID, statusCode, statusDescription } }
// Failure:  { ok:false, error:{ code, message, provider, details } }
//
// The same decision the ICICI and Chola migrations made: the SPA's
// services/health/galaxy reads exactly this envelope. Only the base URL and the
// route paths moved (novacred-insurance-integrations :4002 → this service).
//
// Persistence: every call is audited into api_transactions via
// recordStandaloneApiCall, with the journey id when the caller sent one. The
// request and response are MASKED first (names, dates of birth, PAN, mobile,
// e-mail, bank account, addresses): a proposal body is a person's KYC.
// ─────────────────────────────────────────────────────────────────────────────

// The failure envelope, exactly as the working implementation's error handler
// wrote it. `error.status` is set only on errors this integration classified
// (400 validation, 401 ops key, 503 configuration / today's key missing,
// 502 upstream/parse, 504 timeout, 500 crypto); anything else answers 500.
function respondWithError(res, error) {
  return res.status(error.galaxy ? error.status : 500).json({
    ok: false,
    error: {
      code: error.code || 'INTERNAL_ERROR',
      message: error.message,
      provider: error.provider === undefined ? GALAXY_PROVIDER : error.provider,
      details: error.details || null,
    },
  });
}

// One audit row per GHI call, success or failure. Never throws (safeSave).
function audit({ req, apiName, operation, startedAt, httpStatus, requestPayload, responsePayload, error }) {
  return journeyService.recordStandaloneApiCall({
    journeyId: req.journeyId || null,
    apiName,
    httpMethod: 'POST',
    endpointUrl: galaxyClient().urlFor(operation),
    status: error ? 'FAILED' : 'SUCCESS',
    httpStatus: httpStatus || null,
    durationMs: Date.now() - startedAt,
    requestPayload: maskPersonalData(requestPayload ?? null),
    responsePayload: maskPersonalData(responsePayload ?? null),
    errorCode: error ? (error.code || 'INTERNAL_ERROR') : null,
    errorMessage: error ? error.message : null,
    // GHI's requestUID is what their support asks for.
    correlationId: responsePayload?.meta?.requestUID || error?.details?.requestUID || null,
  });
}

/** A route handler around one galaxyApi operation. */
function handle(operation, run) {
  return async (req, res) => {
    const startedAt = Date.now();
    try {
      const result = await run(req);
      void audit({ req, apiName: GALAXY_API_NAMES[operation], operation, startedAt, httpStatus: 200, requestPayload: req.body, responsePayload: result });
      return res.status(200).json(result);
    } catch (error) {
      void audit({
        req, apiName: GALAXY_API_NAMES[operation], operation, startedAt,
        httpStatus: error.details?.httpStatus || null, requestPayload: req.body, error,
      });
      return respondWithError(res, error);
    }
  };
}

// ── The flow ────────────────────────────────────────────────────────────────
export const quickQuote = handle('quickQuote', (req) => galaxyApi.getQuote(req.body));
export const saveFullProposal = handle('saveProposal', (req) => galaxyApi.createProposal(req.body));
// createOrder keeps the SPA's frontendReturnUrl with the order (never sent to GHI).
export const createOrder = handle('createOrder', (req) => galaxyPayment.createOrder(req.body));

// ── Documents ───────────────────────────────────────────────────────────────
export const uploadDocument = handle('uploadDocument', (req) => galaxyApi.uploadDocument(req.body));
export const downloadDocument = handle('downloadDocument', (req) => galaxyApi.downloadDocument(req.body));
export const searchDocument = handle('searchDocument', (req) => galaxyApi.searchDocument(req.body));

// ── Payment: token API, callback, redirect, status ──────────────────────────
// The three URLs GHI configure for our channel, and what the /galaxy-return page
// reads. None of them talks to GHI.

// POST /galaxy-health/payment/token — client credentials → Bearer token.
export function paymentToken(req, res) {
  try {
    return res.status(200).json(galaxyPayment.issueToken(req));
  } catch (error) {
    return respondWithError(res, error);
  }
}

// POST /galaxy-health/payment/callback — GHI's server, with the Bearer token.
// Captured before anything else, so a result that cannot be read or is
// refused is still on disk.
export function paymentCallback(req, res) {
  try {
    return res.status(200).json(galaxyPayment.receiveCallback(req));
  } catch (error) {
    return respondWithError(res, error);
  }
}

// /galaxy-health/payment/return — the buyer's browser after GHI's payment page.
// Always sends the buyer on (303) when a page is known: a dead end here is a
// buyer who paid and sees an error.
export function paymentReturn(req, res) {
  let target = null;
  try {
    target = galaxyPayment.receiveRedirect(req);
  } catch (error) {
    console.error(`[galaxy] payment return failed: ${error.message}`);
  }
  if (target) return res.redirect(303, target);
  return sendNeutralReturnPage(res);
}

// When no /galaxy-return page is known. It says nothing about the outcome: this
// route cannot know whether the payment succeeded, failed or is pending.
const NEUTRAL_RETURN_TEXT = [
  'You have returned from the Galaxy Health payment page.',
  '',
  'We could not confirm the status of this payment here. Please do not pay again yet.',
  'Go back to the Tommy & Furry website to check your Galaxy Health application, or contact us with your proposal number.',
].join('\n');

function sendNeutralReturnPage(res) {
  return res.status(200).type('text/plain').send(NEUTRAL_RETURN_TEXT);
}

/**
 * Errors raised before a payment route's handler ran — the body was too large
 * (GX_JSON_BODY_LIMIT) or the upload was cut off — so nothing was captured.
 * The callback gets an error GHI can act on, never a 200; the buyer on the
 * redirect is still sent on (or shown the neutral page).
 */
export function paymentBodyError(err, req, res, next) {
  // originalUrl, not req.path: under router.use(paths, …) req.path is relative to the mount.
  const via = req.originalUrl.split('?')[0].endsWith('/payment/callback') ? 'callback' : 'return';
  galaxyPayment.noteUnreadBody(via, req, err);
  if (via === 'return') {
    let page = null;
    try { page = galaxyPayment.fallbackReturnPage(); } catch { page = null; }
    return page ? res.redirect(303, page) : sendNeutralReturnPage(res);
  }
  const tooLarge = err?.type === 'entity.too.large' || err?.status === 413;
  return res.status(tooLarge ? 413 : 400).json({
    ok: false,
    error: {
      code: tooLarge ? 'PAYLOAD_TOO_LARGE' : 'BODY_NOT_READ',
      message: tooLarge
        ? 'The callback body is larger than this service accepts; it was not stored or processed.'
        : 'The callback body could not be read; it was not stored or processed. Please send it again.',
      provider: null,
      details: { stored: false },
    },
  });
}

// GET /galaxy-health/payment/status/:orderId — the order's state for /galaxy-return.
export function paymentStatus(req, res) {
  const data = galaxyPayment.paymentStatus(req.params.orderId);
  if (!data) {
    return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'No Galaxy Health order with that reference on this server.', provider: GALAXY_PROVIDER, details: null } });
  }
  return res.status(200).json({ ok: true, provider: GALAXY_PROVIDER, operation: 'paymentStatus', data });
}

// ── Ops: GHI key rotation ───────────────────────────────────────────────────
// A key fetch registers a new NovaCred key with GHI and uses one of its 3 a day,
// so these are X-Ops-Key guarded, and off (503) while GX_OPS_KEY is unset. The
// daily fetch itself is the GX_KEY_SCHEDULER job (galaxyKeyScheduler.service.js).
export const opsGetCurrentPubKey = handle('getCurrentPubKey', () => galaxyApi.refreshCurrentKey());
export const opsGetNextPubKey = handle('getNextPubKey', () => galaxyApi.refreshNextKey());
export const opsRotateKeys = handle('rotateKeys', async () => galaxyApi.rotateKeys());

/**
 * Guard for the ops routes: the caller must send `X-Ops-Key` equal to
 * GX_OPS_KEY. Read per request, so a restart with a new .env never sees a stale
 * value.
 */
export function requireOpsKey(req, res, next) {
  const expected = String(config.galaxy.opsKey || '');
  if (!expected) {
    return respondWithError(res, configError('Ops routes are disabled: GX_OPS_KEY is not set.'));
  }
  const given = Buffer.from(String(req.headers['x-ops-key'] || ''));
  const want = Buffer.from(expected);
  // Length first: timingSafeEqual throws on unequal lengths.
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
    return respondWithError(res, unauthorizedError('A valid X-Ops-Key header is required.'));
  }
  return next();
}

// GET /galaxy-health/config/test — what this process would need to reach GHI,
// and the state of today's key. 503 when a required variable is missing or
// today's GHI key has not been fetched, naming it. Prints no values and no key
// material: names, the host, dates and counts.
export function testConfig(req, res) {
  const missing = missingGalaxyVariables();
  let keys = null;
  let keyError = null;
  if (!galaxyIsUnconfigured()) {
    try { keys = galaxyApi.keyStatus(); } catch (error) { keyError = error.message; }
  }
  let host = null;
  try { host = config.galaxy.baseUrl ? new URL(config.galaxy.baseUrl).host : null; } catch { host = 'invalid GX_BASE_URL'; }

  const ready = missing.length === 0 && Boolean(keys?.todaysGhiKey);
  return res.status(ready ? 200 : 503).json({
    ok: ready,
    provider: GALAXY_PROVIDER,
    configured: missing.length === 0,
    missing,
    routes: `${GALAXY_PATH_PREFIX}/*`,
    upstreamHost: host,
    producerCode: config.galaxy.producerCode ? 'set' : 'not set',
    keys: keys ? {
      ...keys,
      keyFetchesPerDay: GALAXY_KEY_FETCHES_PER_DAY,
      keyRefreshAt: `${config.galaxy.keyRefreshAt} IST`,
      ...(keys.todaysGhiKey ? {} : { note: "Today's GHI key is not fetched: business calls answer 503 until getCurrentPubKey succeeds." }),
    } : null,
    keyError,
    keyScheduler: config.galaxy.keyScheduler ? 'on' : 'off',
    opsRoutesEnabled: Boolean(config.galaxy.opsKey),
    payment: {
      tokenApi: galaxyPayment.tokenApiConfigured() ? 'on' : 'off (GX_PAYMENT_CLIENT_ID / GX_PAYMENT_CLIENT_SECRET)',
      staticAesKey: config.galaxy.payment.aesKey ? 'set' : 'not set',
      defaultReturnPage: config.galaxy.payment.frontendReturnUrl ? 'set' : 'not set',
    },
    dictionary: { file: DICTIONARY_SOURCE.file, sha256: DICTIONARY_SOURCE.sha256 },
  });
}
