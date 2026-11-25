import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import config from '../config/env.js';
import { GALAXY_PAYMENT_RETURN_PAGE, GALAXY_PAYMENT_STATUS } from '../constants/galaxy.constants.js';
import { resolveFrontendReturnUrl } from '../helpers/payment.helper.js';
import { galaxyLog as logger, configError, galaxyError } from '../helpers/galaxy.helper.js';
import { GxCrypto } from '../helpers/galaxyCrypto.helper.js';
import * as galaxyApi from './galaxyApi.service.js';
import { galaxyClient } from './galaxyClient.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health — the payment leg after createOrder.
//
//   createOrder   → GHI's payment page. The SPA also sends `frontendReturnUrl`
//                   (its /galaxy-return page); it is stripped before the body
//                   is encrypted for GHI and kept with the order, on disk.
//   token API     → POST /galaxy-health/payment/token. GHI exchange the client
//                   id/secret we issued them for a short-lived Bearer token.
//   callback      → POST /galaxy-health/payment/callback, server to server,
//                   with that token. GHI's payment result.
//   redirect      → /galaxy-health/payment/return, the buyer's browser. The
//                   same result; the buyer is sent on to the SPA's
//                   /galaxy-return page with ?ref=<orderId>.
//   status        → GET /galaxy-health/payment/status/:orderId, what the
//                   /galaxy-return page reads.
//
// GHI's createOrder spec lists the result's fields (proposalNo, payment_id,
// currency, datetime, order_id, status CHARGED | PENDING_VBV |
// AUTHENTICATION_FAILED | AUTHORIZATION_FAILED, amount, bank_ref_no) and says
// they arrive "AES Encrypted", but not the parameter names, the method or the
// key. Until GHI say, every redirect and callback is CAPTURED as received
// (data/galaxy-payments/captures, git-ignored) and opened with each scheme that
// is plausible:
//
//   1. GHI's API envelope: encryptedData + apiKey (RSA-wrapped with OUR public
//      key) + checkSum, in the body, the query or the headers — verified and
//      decrypted exactly as an API response is.
//   2. A static AES key, if GHI issue one (GX_PAYMENT_AES_KEY), with GHI's
//      AES-256-GCM packing.
//   3. Plain fields (order_id, status…) — used to route the buyer, but a
//      status is applied only when it was decrypted (1, 2) or came on the
//      token-authenticated callback.
//
// Single process, like the key scheduler: the order records are files.
// ─────────────────────────────────────────────────────────────────────────────

const payCfg = () => config.galaxy.payment;
const dir = (...parts) => path.join(payCfg().storeDir, ...parts);

// ── Token API ───────────────────────────────────────────────────────────────

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const tokenKey = () => crypto.createHash('sha256').update(`galaxy-payment-token|${payCfg().clientSecret}`).digest();
const safeEqual = (a, b) => {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

export function tokenApiConfigured() {
  return Boolean(payCfg().clientId && payCfg().clientSecret);
}

/**
 * The client id/secret from the token request, in any of the forms a
 * client-credentials caller sends: JSON or form {clientId, clientSecret} /
 * {client_id, client_secret}, or "Authorization: Basic base64(id:secret)".
 */
function credentialsOf(req) {
  const auth = String(req.headers.authorization || '');
  if (/^basic\s+/i.test(auth)) {
    const decoded = Buffer.from(auth.replace(/^basic\s+/i, ''), 'base64').toString('utf8');
    const i = decoded.indexOf(':');
    if (i > 0) return { id: decoded.slice(0, i), secret: decoded.slice(i + 1) };
  }
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  return { id: b.clientId ?? b.client_id ?? b.clientID, secret: b.clientSecret ?? b.client_secret };
}

/** POST /payment/token → { access_token, token_type, expires_in }. Throws 401/503. */
export function issueToken(req, now = Date.now()) {
  if (!tokenApiConfigured()) throw configError('The Galaxy payment token API is off: GX_PAYMENT_CLIENT_ID / GX_PAYMENT_CLIENT_SECRET are not set.');
  const { id, secret } = credentialsOf(req);
  if (!safeEqual(id, payCfg().clientId) || !safeEqual(secret, payCfg().clientSecret)) {
    throw galaxyError('Invalid client credentials.', { status: 401, code: 'UNAUTHORIZED', provider: null });
  }
  const ttl = payCfg().tokenTtlSeconds;
  const iat = Math.floor(now / 1000);
  const body = b64url(JSON.stringify({ sub: payCfg().clientId, iat, exp: iat + ttl, jti: crypto.randomUUID() }));
  const sig = b64url(crypto.createHmac('sha256', tokenKey()).update(body).digest());
  return { access_token: `${body}.${sig}`, token_type: 'Bearer', expires_in: ttl };
}

/** True when the request carries a Bearer token this service issued and that has not expired. */
export function hasValidToken(req, now = Date.now()) {
  if (!tokenApiConfigured()) return false;
  const m = /^bearer\s+([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/i.exec(String(req.headers.authorization || '').trim());
  if (!m) return false;
  const expected = b64url(crypto.createHmac('sha256', tokenKey()).update(m[1]).digest());
  if (!safeEqual(m[2], expected)) return false;
  try {
    const claims = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return claims.sub === payCfg().clientId && Number(claims.exp) * 1000 > now;
  } catch {
    return false;
  }
}

// ── Order records ───────────────────────────────────────────────────────────

const safeName = (id) => (/^[A-Za-z0-9_-]{1,80}$/.test(String(id)) ? String(id) : crypto.createHash('sha256').update(String(id)).digest('hex'));

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function getOrder(orderId) {
  if (!orderId) return null;
  return readJson(dir('orders', `${safeName(orderId)}.json`));
}

function saveOrder(order) {
  writeJson(dir('orders', `${safeName(order.orderId)}.json`), order);
  return order;
}

/** The order a result names: by order_id, else the newest order for its proposal number. */
function findOrder({ orderId, proposalNo }) {
  const byId = getOrder(orderId);
  if (byId) return byId;
  if (!proposalNo) return null;
  let files = [];
  try { files = fs.readdirSync(dir('orders')).filter((f) => f.endsWith('.json')); } catch { return null; }
  return files.map((f) => readJson(dir('orders', f))).filter((o) => o && o.proposalNumber === proposalNo)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0] || null;
}

/**
 * createOrder with the SPA's return page kept beside it. The page is checked
 * against the allowed origins and a /galaxy-return path; one that fails is
 * dropped with a warning — the payment still goes ahead.
 */
export async function createOrder(input = {}) {
  const { frontendReturnUrl, ...order } = input || {};
  const target = resolveFrontendReturnUrl(frontendReturnUrl, payCfg().frontendReturnOrigins, GALAXY_PAYMENT_RETURN_PAGE);
  if (target.reason) logger.warn(`createOrder: frontendReturnUrl ignored (${target.reason})`);

  const result = await galaxyApi.issuePolicy(order);
  const orderId = result?.data?.orderId;
  if (orderId) {
    try {
      saveOrder({
        orderId,
        proposalNumber: order.referenceNo || null,
        refId: order.refId || null,
        amountPaise: order.txnAmount || null,
        frontendReturnUrl: target.url,
        expireDateTime: result.data.expireDateTime || null,
        createdAt: new Date().toISOString(),
        status: GALAXY_PAYMENT_STATUS.CREATED,
        payment: null,
        events: [],
      });
    } catch (error) {
      // The buyer can still pay; the return page then says it cannot confirm.
      logger.error(`createOrder: order ${orderId} not recorded: ${error.message}`);
    }
  }
  return result;
}

// ── The body, as received ───────────────────────────────────────────────────
//
// The payment routes read the body RAW, whatever its type (express.raw in
// routes/index.js, mounted before the JSON/form parsers, which then skip it).
// So a malformed or unexpected body still reaches this code byte for byte and
// is captured before anything decides what it means. Decoding follows the
// declared Content-Type only:
//
//   application/json (+json)            → parsed; invalid JSON → 'malformed-json'
//   application/x-www-form-urlencoded   → parsed
//   text/*                              → kept as text
//   anything else, or no Content-Type   → 'unsupported-content-type' (kept raw, not interpreted)
//   no bytes                            → 'empty'

/**
 * @returns {{ raw: Buffer|null, type: string, body: object, text: string,
 *             problem: null|'empty'|'malformed-json'|'unsupported-content-type' }}
 */
export function readBody(req) {
  const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || raw.length === 0) return { raw, type, body: {}, text: '', problem: 'empty' };
  const text = raw.toString('utf8');
  if (type === 'application/json' || type.endsWith('+json')) {
    try {
      const value = JSON.parse(text);
      return { raw, type, body: value && typeof value === 'object' ? value : {}, text: typeof value === 'string' ? value.trim() : '', problem: null };
    } catch {
      return { raw, type, body: {}, text: '', problem: 'malformed-json' };
    }
  }
  if (type === 'application/x-www-form-urlencoded') {
    return { raw, type, body: Object.fromEntries(new URLSearchParams(text)), text: '', problem: null };
  }
  if (type.startsWith('text/')) return { raw, type, body: {}, text: text.trim(), problem: null };
  return { raw, type, body: {}, text: '', problem: 'unsupported-content-type' };
}

// ── Captures ────────────────────────────────────────────────────────────────

const MAX_CAPTURES = 500;

/**
 * Writes what arrived, exactly — the whole body (the parser's limit,
 * GX_JSON_BODY_LIMIT, bounds it), and base64 too when it is not valid UTF-8 —
 * minus credential VALUES. Returns the file name, or null when it could not be
 * written (never throws): the callback then refuses to acknowledge.
 */
function capture(via, req, info) {
  try {
    const at = new Date().toISOString();
    const raw = info.raw ? info.raw.toString('utf8') : null;
    const h = req.headers;
    const record = {
      at, via, method: req.method, path: req.originalUrl.split('?')[0], query: req.query,
      headers: {
        'content-type': h['content-type'] || null,
        'user-agent': h['user-agent'] || null,
        'x-forwarded-for': h['x-forwarded-for'] || null,
        referer: h.referer || null,
        authorization: h.authorization ? `${String(h.authorization).split(' ')[0]} (${String(h.authorization).length} chars)` : null,
        apiKey: h.apikey ? `present (${String(h.apikey).length} chars)` : null,
        checkSum: h.checksum ? `present (${String(h.checksum).length} chars)` : null,
      },
      bodyBytes: info.raw ? info.raw.length : 0,
      bodyProblem: info.problem,
      rawBody: raw,
      ...(raw !== null && raw.includes('�') ? { rawBodyBase64: info.raw.toString('base64') } : {}),
    };
    const file = dir('captures', `${at.replace(/[:.]/g, '-')}-${via}-${crypto.randomBytes(3).toString('hex')}.json`);
    writeJson(file, record);
    const all = fs.readdirSync(dir('captures')).sort();
    for (const old of all.slice(0, Math.max(0, all.length - MAX_CAPTURES))) fs.rmSync(dir('captures', old), { force: true });
    return path.basename(file);
  } catch (error) {
    logger.error(`payment ${via}: capture failed: ${error.message}`);
    return null;
  }
}

// ── Opening a result ────────────────────────────────────────────────────────

const ALIASES = {
  encryptedData: ['encrypteddata', 'encdata', 'encresp', 'encryptedresponse', 'response', 'data', 'payload'],
  apiKey: ['apikey', 'api_key'],
  checkSum: ['checksum', 'check_sum'],
};

function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  const key = Object.keys(obj).find((k) => names.includes(k.toLowerCase()));
  const v = key === undefined ? undefined : obj[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** The result's fields, normalised, from an object or an array holding one. */
function fieldsOf(value) {
  const o = Array.isArray(value) ? value[0] : value;
  if (!o || typeof o !== 'object') return null;
  const get = (...names) => {
    const key = Object.keys(o).find((k) => names.includes(k.toLowerCase().replace(/[^a-z]/g, '')));
    return key === undefined || o[key] === null || o[key] === undefined ? null : String(o[key]);
  };
  const fields = {
    proposalNo: get('proposalno', 'referenceno'),
    paymentId: get('paymentid'),
    currency: get('currency'),
    datetime: get('datetime'),
    orderId: get('orderid'),
    status: get('status'),
    amount: get('amount'),
    bankRefNo: get('bankrefno'),
  };
  return fields.orderId || fields.status || fields.proposalNo ? fields : null;
}

function parseText(text) {
  try { return JSON.parse(text); } catch { /* not JSON */ }
  if (/^[^=&\s]+=[^&]*(&[^=&\s]+=[^&]*)*$/.test(text)) return Object.fromEntries(new URLSearchParams(text));
  return null;
}

/**
 * Tries every plausible scheme on what arrived. Returns
 * { fields, verified, scheme } — fields null when nothing could be read.
 */
export function openResult(req, info = readBody(req)) {
  const { body, text: textBody } = info;
  const envelope = body.requestData || (Array.isArray(body.results) ? body.results[0] : null) || {};
  const enc = pick(body, ALIASES.encryptedData) || pick(envelope, ALIASES.encryptedData) || pick(req.query, ALIASES.encryptedData)
    || (textBody && !textBody.startsWith('{') ? textBody : undefined);
  const apiKey = pick(body, ALIASES.apiKey) || pick(req.query, ALIASES.apiKey) || pick(req.headers, ALIASES.apiKey);
  const checkSum = pick(body, ALIASES.checkSum) || pick(req.query, ALIASES.checkSum) || pick(req.headers, ALIASES.checkSum);
  const gx = new GxCrypto();

  // 1. GHI's API envelope, verified with our private keys and the checkSum.
  if (enc && apiKey && checkSum) {
    try {
      const data = galaxyClient()._openResult('paymentResult', { requestUID: null }, { encryptedData: enc }, { headers: { apiKey, checkSum } });
      const fields = fieldsOf(data.raw !== undefined ? parseText(data.raw) : data);
      if (fields) return { fields, verified: true, scheme: 'gx-envelope' };
    } catch (error) {
      logger.warn(`payment result: GHI envelope did not open (${error.message})`);
    }
  }

  // 2. A static AES key GHI issued, with GHI's GCM packing.
  if (enc && payCfg().aesKey) {
    try {
      const fields = fieldsOf(parseText(gx.aesDecrypt(enc, payCfg().aesKey)));
      if (fields) return { fields, verified: true, scheme: 'static-aes' };
    } catch (error) {
      logger.warn(`payment result: GX_PAYMENT_AES_KEY did not open it (${error.message})`);
    }
  }

  // 3. Plain fields.
  const plain = fieldsOf(Object.keys(body).length ? body : null) || fieldsOf(req.query) || (textBody ? fieldsOf(parseText(textBody)) : null);
  if (plain) return { fields: plain, verified: false, scheme: 'plain' };

  return { fields: null, verified: false, scheme: enc ? 'undecoded' : 'empty' };
}

// GHI's four result statuses (CREATED is ours, never GHI's).
const KNOWN_STATUSES = new Set(Object.values(GALAXY_PAYMENT_STATUS).filter((s) => s !== GALAXY_PAYMENT_STATUS.CREATED));

/**
 * Applies an opened result to its order. `trusted`: decrypted, or plain on
 * the token-authenticated callback. A redirect's plain fields only route the
 * buyer. A CHARGED status is never overwritten by a later failure.
 */
function apply(opened, { via, trusted, captureFile }) {
  const { fields } = opened;
  const order = fields ? findOrder({ orderId: fields.orderId, proposalNo: fields.proposalNo }) : null;
  if (!order) return null;
  const status = String(fields.status || '').toUpperCase();
  const event = { at: new Date().toISOString(), via, scheme: opened.scheme, trusted, status: status || null, captureFile };
  const updated = { ...order, events: [...(order.events || []), event].slice(-50) };
  if (trusted && KNOWN_STATUSES.has(status) && order.status !== GALAXY_PAYMENT_STATUS.CHARGED) {
    updated.status = status;
    updated.payment = {
      paymentId: fields.paymentId, bankRefNo: fields.bankRefNo, amount: fields.amount, currency: fields.currency,
      datetime: fields.datetime, via, scheme: opened.scheme, receivedAt: event.at,
    };
  }
  return saveOrder(updated);
}

// A refused callback, after it was captured: the sender is told, never a 200.
const refused = (status, code, message, captureFile) => galaxyError(message, {
  status, code, provider: null, details: { stored: Boolean(captureFile), reference: captureFile },
});

/**
 * The callback. In this order:
 *   1. capture the request as received   — not stored → 500, never acknowledged
 *   2. Bearer token                      — missing/invalid → 401
 *   3. the body                          — empty → 400, malformed JSON → 400,
 *                                          a type this service does not read → 415
 *   4. open and apply it                 → 200 { status: 'SUCCESS', message: 'Received' }
 *
 * 200 means: authenticated, stored, and the body was readable. Whether its
 * status could be applied to an order depends on GHI's format, which GHI have
 * not confirmed; an unmatched result is logged and kept for reconciliation.
 */
export function receiveCallback(req) {
  const info = readBody(req);
  const captureFile = capture('callback', req, info);
  if (!captureFile) {
    throw refused(500, 'NOT_STORED', 'The callback could not be stored; nothing was processed. Please send it again.', null);
  }
  if (!hasValidToken(req)) {
    logger.warn('payment callback refused: no valid Bearer token from /galaxy-health/payment/token', { captureFile });
    throw refused(401, 'UNAUTHORIZED', 'A valid Bearer token from the token API is required.', captureFile);
  }
  const hasQuery = Object.keys(req.query || {}).length > 0;
  if (info.problem === 'empty' && !hasQuery) {
    throw refused(400, 'EMPTY_PAYLOAD', 'The callback has no body and no query parameters.', captureFile);
  }
  if (info.problem === 'malformed-json') {
    throw refused(400, 'MALFORMED_JSON', 'The body is declared as JSON but is not valid JSON.', captureFile);
  }
  if (info.problem === 'unsupported-content-type') {
    throw refused(415, 'UNSUPPORTED_CONTENT_TYPE',
      `Content-Type "${info.type || '(none)'}" is not read here. Send application/json, application/x-www-form-urlencoded or text/plain.`, captureFile);
  }
  const opened = openResult(req, info);
  const trusted = opened.verified || opened.fields !== null;
  const order = apply(opened, { via: 'callback', trusted, captureFile });
  const log = order ? logger.info : logger.warn;
  log(order ? 'payment callback received' : 'payment callback received but not matched to an order (kept for reconciliation)', {
    scheme: opened.scheme, orderId: opened.fields?.orderId || null, status: opened.fields?.status || null,
    matchedOrder: Boolean(order), captureFile,
  });
  return { status: 'SUCCESS', message: 'Received' };
}

/**
 * GX_PAYMENT_FRONTEND_RETURN_URL, when it names an allowed /galaxy-return
 * page; null otherwise (the buyer then gets the neutral page from the controller).
 */
export function fallbackReturnPage() {
  const page = resolveFrontendReturnUrl(payCfg().frontendReturnUrl, payCfg().frontendReturnOrigins, GALAXY_PAYMENT_RETURN_PAGE);
  if (page.reason) logger.warn(`GX_PAYMENT_FRONTEND_RETURN_URL ignored (${page.reason})`);
  return page.url;
}

/**
 * The browser redirect: capture, open, apply, and where to send the buyer.
 * Never refuses: a body this service cannot read still sends the buyer on.
 * Its status is applied only when decrypted (a browser can be made to send
 * anything).
 */
export function receiveRedirect(req) {
  const info = readBody(req);
  const captureFile = capture('return', req, info);
  const opened = openResult(req, info);
  const order = apply(opened, { via: 'redirect', trusted: opened.verified, captureFile });
  logger.info('payment return received', {
    scheme: opened.scheme, orderId: opened.fields?.orderId || null, status: opened.fields?.status || null,
    matchedOrder: Boolean(order), bodyProblem: info.problem === 'empty' ? null : info.problem, captureFile,
  });
  const page = order?.frontendReturnUrl || fallbackReturnPage();
  if (!page) return null;
  const ref = order?.orderId || opened.fields?.orderId;
  return ref ? `${page}?ref=${encodeURIComponent(ref)}` : page;
}

/**
 * A payment route's body that never reached the handler (too large, aborted):
 * logged with what is known — the body itself is gone, which is why the
 * callback answers with an error the sender can act on.
 */
export function noteUnreadBody(via, req, error) {
  logger.error(`payment ${via}: body not read (${error.type || error.message}); not stored`, {
    contentType: req.headers['content-type'] || null, contentLength: req.headers['content-length'] || null,
  });
}

/** What the SPA's /galaxy-return page may read: the order's state, no personal data. */
export function paymentStatus(orderId) {
  const order = getOrder(orderId);
  if (!order) return null;
  return {
    orderId: order.orderId,
    proposalNumber: order.proposalNumber,
    status: order.status,
    payment: order.payment,
    lastEventAt: order.events?.length ? order.events[order.events.length - 1].at : null,
    createdAt: order.createdAt,
  };
}
