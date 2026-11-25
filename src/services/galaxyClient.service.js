import crypto from 'node:crypto';

import config from '../config/env.js';
import {
  GALAXY_OPERATIONS, GALAXY_HEADER, GALAXY_SUCCESS_STATUS, GALAXY_KEY_FETCHES_PER_DAY, GALAXY_KEY_FETCH_OPERATIONS,
} from '../constants/galaxy.constants.js';
import { GxCrypto } from '../helpers/galaxyCrypto.helper.js';
import { istDate } from '../helpers/galaxyKeyDay.helper.js';
import { maskPersonalData } from '../helpers/galaxyMask.helper.js';
import { galaxyLog as logger, configError, parseError, upstreamError } from '../helpers/galaxy.helper.js';
import { GxKeyStore, normalizePem, pemBody } from './galaxyKeyStore.service.js';
import { galaxyRequest } from './galaxyHttp.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// CBOS-GX V2 transport. Builds the encrypted request envelope + security
// headers, sends the POST, then verifies/decrypts the response.
//
//   headers: GH-CLIENT-CONTEXT, requestUID, Content-Type, Accept,
//            Authorization("Basic " + appKey), User-Agent, apiKey(RSA), checkSum(SHA-256)
//   body   : { requestData: { encryptedData: <AES(base64)> } }
//   resp   : headers apiKey (RSA, with OUR public key) + checkSum (SHA-256);
//            body { statusCode, statusDescription, requestUID, results:[{ encryptedData | errorDesc }] }
//
// Moved unchanged from the working implementation (src/providers/galaxy/
// gxClient.js, including the 24 Nov 2026 change that keeps GHI's decrypted
// error detail, masked, as details.ghiResponse). Only the module syntax, the
// error factories and the HTTP primitive's import differ.
// ─────────────────────────────────────────────────────────────────────────────
export class GxClient {
  constructor({ keyStore } = {}) {
    this.cfg = config.galaxy;
    this.crypto = new GxCrypto();
    this.keyStore = keyStore || new GxKeyStore();
  }

  _url(operation) {
    const op = GALAXY_OPERATIONS[operation];
    if (!op) throw configError(`Unknown GX operation "${operation}"`);
    if (!this.cfg.baseUrl) throw configError('GX_BASE_URL is not set');
    return `${this.cfg.baseUrl.replace(/\/$/, '')}${op.path}`;
  }

  /** The full GHI URL of an operation, for audit rows; null when it cannot be built. */
  urlFor(operation) {
    try { return this._url(operation); } catch { return null; }
  }

  _requestUID() {
    return `${this.cfg.channelId}-${crypto.randomUUID()}`;
  }

  _clientContext(requestUID) {
    return this.crypto.buildClientContext({
      requestUID,
      country: 'IN',
      channelID: String(this.cfg.channelId),
      clientIp: this.cfg.clientIp || 'S2S',
      lang: 'EN',
      srcSystemName: this.cfg.srcSystemName,
      srcClientId: this.cfg.srcClientId || 'API',
      rumEvents: '',
    });
  }

  /** Our private keys GHI may have encrypted a response apiKey with: current, then previous. */
  _responseKeys() {
    const prev = this.keyStore.ncPrev();
    return [this.keyStore.ncCurrent().privateKey, prev && prev.privateKey].filter(Boolean);
  }

  /** GHI allows GALAXY_KEY_FETCHES_PER_DAY getCurrentPubKey sends per IST day; counted before sending. */
  _countKeyFetch(operation) {
    const used = this.keyStore.keyFetchesOn();
    if (used >= GALAXY_KEY_FETCHES_PER_DAY) {
      throw configError(`GX ${operation}: today's ${GALAXY_KEY_FETCHES_PER_DAY} key fetches (IST ${istDate()}) are used`, {
        details: { used },
      });
    }
    this.keyStore.countKeyFetch();
  }

  /**
   * Core call. Encrypts `payload` with a fresh apiKey wrapped by
   * `ghiPublicKeyPem` (defaults to GHI current), sends it, then verifies and
   * decrypts the response: the response apiKey header is RSA-decrypted with the
   * first of `ncPrivateKeys` (defaults to our current key, then the previous
   * one) whose result also matches the response checkSum header, and only then
   * is the payload decrypted.
   *
   * A string `payload` is encrypted as-is (no JSON quoting); anything else is
   * JSON-serialised first.
   *
   * A business call is refused, before anything is sent, until GHI's key of the
   * current IST day has been fetched (GHI mail, 29 Oct 2026).
   *
   * @returns {{ statusCode, statusDescription, requestUID, data:any, raw:object }}
   */
  async call({ operation, payload, ghiPublicKeyPem, ncPrivateKeys }) {
    if (!this.cfg.appKey) throw configError('GX_APP_KEY (Authorization) is not set');
    if (!GALAXY_KEY_FETCH_OPERATIONS.has(operation) && !this.keyStore.hasGhiKeyFor(new Date(), this.cfg.keyRefreshAt)) {
      throw configError(
        `GX ${operation}: GHI's public key for ${istDate()} (IST) has not been fetched yet; getCurrentPubKey must succeed first (from ${this.cfg.keyRefreshAt} IST)`,
        { details: { lastKeyReceivedAt: this.keyStore.ghiReceivedAt() } },
      );
    }

    const ghiKey = ghiPublicKeyPem || this.keyStore.ghiCurrent();
    if (!ghiKey) {
      throw configError('No GHI public key available (set GX_GHI_STATIC_PUBLIC_KEY or fetch one)');
    }

    const requestUID = this._requestUID();
    const apiKey = this.crypto.generateApiKey();
    const plaintext = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    const encryptedData = this.crypto.aesEncrypt(plaintext, apiKey);
    const headers = {
      [GALAXY_HEADER.CONTENT_TYPE]: 'application/json',
      [GALAXY_HEADER.ACCEPT]: 'application/json',
      [GALAXY_HEADER.CLIENT_CONTEXT]: this._clientContext(requestUID),
      [GALAXY_HEADER.REQUEST_UID]: requestUID,
      [GALAXY_HEADER.AUTHORIZATION]: `Basic ${this.cfg.appKey}`, // GHI mail, 28 Oct 2026
      [GALAXY_HEADER.USER_AGENT]: this.cfg.userAgent,
      [GALAXY_HEADER.API_KEY]: this.crypto.rsaEncryptApiKey(apiKey, ghiKey),
      [GALAXY_HEADER.CHECKSUM]: this.crypto.checksum(apiKey, encryptedData),
    };

    // The requestUID GHI support asks for, on the line that shows the call going out.
    logger.info(`${operation} → GHI`, { requestUID });

    const res = await galaxyRequest({
      opName: operation,
      method: 'POST',
      url: this._url(operation),
      headers,
      data: { requestData: { encryptedData } },
      maxRetries: GALAXY_KEY_FETCH_OPERATIONS.has(operation) ? 0 : undefined,
    });

    let body = res.data;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch { /* leave string */ }
    }
    if (res.status < 200 || res.status >= 300) {
      throw upstreamError(`GX ${operation} returned HTTP ${res.status}`, {
        details: { httpStatus: res.status, requestUID, body: trunc(body) },
      });
    }

    return this._handleEnvelope(operation, body, { headers: res.headers, ncPrivateKeys, sentRequestUID: requestUID });
  }

  _handleEnvelope(operation, rawBody, { headers, ncPrivateKeys, sentRequestUID }) {
    if (!rawBody || typeof rawBody !== 'object') {
      throw parseError(`GX ${operation} returned a non-JSON body`, { details: { requestUID: sentRequestUID, body: trunc(rawBody) } });
    }
    // GHI's UAT success bodies carry no requestUID (25 Nov 2026), so the one we
    // sent stands in: it is the id GHI support asks for, and meta.requestUID is
    // what the SPA keeps as the quote id and the audit row's correlation id.
    const body = rawBody.requestUID || !sentRequestUID ? rawBody : { ...rawBody, requestUID: sentRequestUID };
    const statusCode = String(body.statusCode ?? '');
    const result = Array.isArray(body.results) ? body.results[0] : undefined;

    // GHI's UAT success body is only { results: [{ encryptedData }] }, with no
    // statusCode (getCurrentPubKey, 28 Oct 2026), unlike the spec sample. An
    // explicit statusCode other than "200" is still an error.
    const succeeded = statusCode === GALAXY_SUCCESS_STATUS || (statusCode === '' && result?.encryptedData !== undefined);
    if (!succeeded) {
      // GHI's texts are masked too: they reach the caller and the log.
      const errorDesc = maskPersonalData(result?.errorDesc);
      const statusDescription = maskPersonalData(body.statusDescription);
      const errDesc = errorDesc || statusDescription || 'Unknown GX error';
      const details = { statusCode, statusDescription, errorDesc, requestUID: body.requestUID };
      // GHI can return an error with its detail in an encrypted result (quickQuote
      // "500 Internal Server Error", 24 Nov 2026). It is verified and decrypted as
      // on success and kept, masked, because `details` reaches the API caller. If
      // it cannot be opened, GHI's status is still the error reported.
      if (result?.encryptedData !== undefined) {
        try {
          details.ghiResponse = maskPersonalData(this._openResult(operation, body, result, { headers, ncPrivateKeys }));
        } catch (e) {
          details.ghiResponseError = e.message;
        }
      }
      logger.warn(`${operation}: GHI returned statusCode ${statusCode || '(none)'}`, details);
      throw upstreamError(`GX ${operation} failed: ${errDesc}`, { details });
    }

    if (!result || result.encryptedData === undefined) {
      // Success with no encrypted payload (rare) — returned as-is.
      return { statusCode, statusDescription: body.statusDescription, requestUID: body.requestUID, data: result ?? null, raw: body };
    }

    const data = this._openResult(operation, body, result, { headers, ncPrivateKeys });
    logger.debug(`${operation} decrypted response`, { requestUID: body.requestUID });
    return { statusCode, statusDescription: body.statusDescription, requestUID: body.requestUID, data, raw: body };
  }

  /**
   * Verifies and decrypts `result.encryptedData`, returning the parsed payload
   * (or `{ raw }` when it is not JSON). Used for success and error envelopes alike.
   */
  _openResult(operation, body, result, { headers, ncPrivateKeys }) {
    // Verify, then decrypt. The response apiKey and checkSum are HTTP headers
    // ("Both" in the spec): the apiKey is RSA-encrypted with our public key, and
    // the checkSum "will be validated/authenticated at Consumer side".
    const respApiKey = headerValue(headers, GALAXY_HEADER.API_KEY);
    const respCheckSum = headerValue(headers, GALAXY_HEADER.CHECKSUM);
    if (!respApiKey || !respCheckSum) {
      throw parseError(`GX ${operation}: response is missing the ${GALAXY_HEADER.API_KEY}/${GALAXY_HEADER.CHECKSUM} headers`, {
        details: { requestUID: body.requestUID, apiKey: !!respApiKey, checkSum: !!respCheckSum },
      });
    }
    // Try each of our private keys; the apiKey that also satisfies the checkSum is GHI's.
    let plainKey;
    let opened = false;
    for (const key of ncPrivateKeys || this._responseKeys()) {
      let candidate;
      try { candidate = this.crypto.rsaDecryptApiKey(respApiKey, key); } catch { continue; } // not this key
      opened = true;
      if (this.crypto.verifyChecksum(candidate, result.encryptedData, respCheckSum)) { plainKey = candidate; break; }
    }
    if (!opened) {
      throw parseError(`GX ${operation}: could not decrypt the response apiKey with our private keys`, {
        details: { requestUID: body.requestUID },
      });
    }
    if (plainKey === undefined) {
      throw parseError(`GX ${operation}: response checkSum does not match`, { details: { requestUID: body.requestUID } });
    }
    let decrypted;
    try {
      decrypted = this.crypto.aesDecrypt(result.encryptedData, plainKey);
    } catch (e) {
      throw parseError(`GX ${operation}: could not decrypt response payload`, { cause: e });
    }
    let data;
    try { data = JSON.parse(decrypted); } catch { data = { raw: decrypted }; }
    return data;
  }

  // --- Public-key rotation --------------------------------------------------

  /**
   * getCurrentPubKey: send our NEW public key (B) encrypted in the payload,
   * apiKey encrypted with the LAST key GHI returned (the static key only before
   * the first rotation, and the last key also after a missed day: GHI mail, 29
   * Oct 2026). Store GHI's returned key as current (Y), for that day's business
   * calls and the next getCurrentPubKey. See "GHI Public key steps". Each send
   * counts toward GHI's 3 a day, before it is sent.
   *
   * The plaintext is the bare base64 SPKI body of B and nothing else: no JSON
   * wrapper, no quotes, no BEGIN/END lines (GHI mail, 30 Sep 2026).
   *
   * The spec says GHI encrypts the response apiKey with B, the key we just sent,
   * but GHI's UAT used our current key A on 28 Oct 2026. So B is tried first,
   * then A, then our previous key; the checkSum decides. Nothing is stored
   * unless GHI's key is a valid RSA key.
   */
  async getCurrentPubKey() {
    this._countKeyFetch('getCurrentPubKey');
    const { publicKey: ncNewPub, privateKey: ncNewPriv } = this.keyStore.ncGenerateNext();
    const out = await this.call({
      operation: 'getCurrentPubKey',
      payload: pemBody(ncNewPub),
      ghiPublicKeyPem: this.keyStore.ghiCurrent(), // the last key GHI returned
      ncPrivateKeys: [ncNewPriv, ...this._responseKeys()], // B, then A (GHI UAT used A on 28 Oct 2026)
    });
    this.keyStore.setGhiCurrent(rsaPublicKeyOrThrow(extractPem(out.data), 'getCurrentPubKey'));
    this.keyStore.promoteNc();
    return out;
  }

  /** getNextPubKey: same pattern, stores GHI next key (Z). */
  async getNextPubKey() {
    const { publicKey: ncNextPub, privateKey: ncNextPriv } = this.keyStore.ncGenerateNext();
    const out = await this.call({
      operation: 'getNextPubKey',
      payload: pemBody(ncNextPub),
      ghiPublicKeyPem: this.keyStore.ghiCurrent(), // as getCurrentPubKey
      ncPrivateKeys: [ncNextPriv, ...this._responseKeys()], // as getCurrentPubKey
    });
    this.keyStore.setGhiNext(rsaPublicKeyOrThrow(extractPem(out.data), 'getNextPubKey'));
    return out;
  }
}

// Header lookup that ignores case: axios lower-cases names, the spec writes apiKey/checkSum.
function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((h) => h.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : headers[key];
}

// GHI's returned key must be a usable RSA public key before it goes into the key store.
function rsaPublicKeyOrThrow(key, operation) {
  try {
    if (key && crypto.createPublicKey(normalizePem(key)).asymmetricKeyType === 'rsa') return key;
  } catch { /* reported below */ }
  throw parseError(`GX ${operation}: response does not contain a valid RSA public key`);
}

// GHI's response is likely the mirror of our request: a bare base64 key, which
// fails JSON.parse and lands in `data.raw` (see _openResult).
function extractPem(data) {
  if (!data) return null;
  if (typeof data === 'string') return data.trim() || null;
  const v = data.publicKey || data.pubKey || data.public_key || data.key || data.raw;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function trunc(v) {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s ? s.slice(0, 400) : s;
}

// One client per process, built on first use so a test can point GX_* at a mock
// before anything reads them.
let shared = null;
export function galaxyClient() {
  if (!shared) shared = new GxClient();
  return shared;
}
