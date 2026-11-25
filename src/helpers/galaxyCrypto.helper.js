import crypto from 'node:crypto';

import config from '../config/env.js';
import { cryptoError } from './galaxy.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// CBOS-GX V2 security primitives ("GX Authentication V2" and "GHI Public key
// steps" specs, with the parameters agreed with the CBOS team and validated with
// test values in both directions on 27 Oct 2026).
//
// Moved unchanged from the working implementation (src/providers/galaxy/
// gxCrypto.js): only the module syntax and the error factory differ.
//
// Per request (NovaCred → GHI):
//   1. Generate a random 32-character apiKey.
//   2. encryptedData = AES-256-GCM of the payload, key = the apiKey as 32 UTF-8
//      bytes, random 32-byte IV, 16-byte tag, no AAD, packed as
//      [1 byte IV length][IV][ciphertext][tag] and base64-encoded.
//   3. apiKey header = RSA/ECB/OAEPPadding (SHA-256, MGF1-SHA256, empty label)
//      of the raw apiKey with GHI's public key, base64-encoded.
//   4. checkSum header = SHA-256( rawApiKey + encryptedData ) as lowercase hex,
//      where encryptedData is the base64 text exactly as sent.
//   5. GH-CLIENT-CONTEXT header = base64( ROT47( base64( JSON(context) ) ) ).
//
// Per response (GHI → NovaCred) it is the mirror: a fresh apiKey arrives in the
// apiKey header, RSA-encrypted with OUR public key; the checkSum header is
// verified (verifyChecksum) before the payload is decrypted with that apiKey.
//
// The algorithm settings come from config (GX_RSA_PADDING, GX_OAEP_HASH,
// GX_AES_MODE, GX_AES_IV_LENGTH, GX_AES_TAG_LENGTH) and default to the agreed
// values above. The ECB/CBC and PKCS#1 v1.5 branches are earlier candidates
// kept selectable by config; the agreed configuration does not use them.
// ─────────────────────────────────────────────────────────────────────────────

const APIKEY_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';

export class GxCrypto {
  constructor(cryptoCfg = config.galaxy.crypto) {
    this.cfg = cryptoCfg;
  }

  /**
   * Generate the fixed 32-character random apiKey. crypto.randomInt draws from
   * the CSPRNG without modulo bias, so every character is equally likely.
   */
  generateApiKey(length = 32) {
    let out = '';
    for (let i = 0; i < length; i += 1) {
      out += APIKEY_CHARS[crypto.randomInt(APIKEY_CHARS.length)];
    }
    return out;
  }

  _aesAlgo() {
    // apiKey is 32 chars → 32-byte key → AES-256.
    return (this.cfg.aesMode || 'aes-256-gcm').toLowerCase();
  }

  _isGcm() { return this._aesAlgo().includes('gcm'); }

  _needsIv() {
    return !this._aesAlgo().includes('ecb');
  }

  /** GCM IV length in bytes. CBOS-GX specify 32 (unusually long, but valid). */
  _ivLength() { return Number(this.cfg.aesIvLength ?? 32); }

  /** GCM auth tag length in bytes. CBOS-GX specify 16 (128 bits). */
  _tagLength() { return Number(this.cfg.aesTagLength ?? 16); }

  /**
   * AES-encrypt a UTF-8 string using the apiKey as the key. Returns base64.
   *
   * GCM (the CBOS-GX scheme, confirmed 2026-09-25) packs as:
   *     [1 byte IV length][IV][ciphertext][auth tag]
   * then base64. No AAD. The tag is appended to the ciphertext, matching the
   * Java convention where Cipher output already carries it.
   *
   * For CBC and other IV modes a 16-byte IV is prepended with no length byte.
   * ECB transmits no IV at all.
   */
  aesEncrypt(plaintext, apiKey) {
    const key = Buffer.from(apiKey, 'utf8');
    const algo = this._aesAlgo();

    if (this._isGcm()) {
      const ivLen = this._ivLength();
      const tagLen = this._tagLength();
      if (ivLen < 1 || ivLen > 255) {
        throw cryptoError(`GX AES IV length ${ivLen} cannot be encoded in the single length byte`);
      }
      const iv = crypto.randomBytes(ivLen);
      const cipher = crypto.createCipheriv(algo, key, iv, { authTagLength: tagLen });
      const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
      return Buffer.concat([Buffer.from([ivLen]), iv, enc, cipher.getAuthTag()]).toString('base64');
    }

    const iv = this._needsIv() ? crypto.randomBytes(16) : null;
    const cipher = crypto.createCipheriv(algo, key, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const payload = iv ? Buffer.concat([iv, enc]) : enc;
    return payload.toString('base64');
  }

  /** Reverse of aesEncrypt. Returns the UTF-8 plaintext. */
  aesDecrypt(cipherB64, apiKey) {
    const key = Buffer.from(apiKey, 'utf8');
    const algo = this._aesAlgo();
    let buf = Buffer.from(cipherB64, 'base64');

    if (this._isGcm()) {
      const tagLen = this._tagLength();
      try {
        const ivLen = buf[0];
        if (buf.length < 1 + ivLen + tagLen) {
          throw new Error(`packed payload too short: ${buf.length} bytes for IV ${ivLen} + tag ${tagLen}`);
        }
        const iv = buf.subarray(1, 1 + ivLen);
        const rest = buf.subarray(1 + ivLen);
        const enc = rest.subarray(0, rest.length - tagLen);
        const tag = rest.subarray(rest.length - tagLen);
        const decipher = crypto.createDecipheriv(algo, key, iv, { authTagLength: tagLen });
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
      } catch (e) {
        throw cryptoError('GX AES-GCM decryption failed', { cause: e });
      }
    }

    let iv = null;
    if (this._needsIv()) {
      iv = buf.subarray(0, 16);
      buf = buf.subarray(16);
    }
    try {
      const decipher = crypto.createDecipheriv(algo, key, iv);
      return Buffer.concat([decipher.update(buf), decipher.final()]).toString('utf8');
    } catch (e) {
      throw cryptoError('GX AES decryption failed', { cause: e });
    }
  }

  _rsaPadding() {
    return (this.cfg.rsaPadding || 'oaep').toLowerCase() === 'pkcs1'
      ? crypto.constants.RSA_PKCS1_PADDING
      : crypto.constants.RSA_PKCS1_OAEP_PADDING;
  }

  /**
   * OAEP digest. GHI's sample of 2026-10-01 only decrypts as SHA-256 with
   * MGF1-SHA256; Node's oaepHash applies the same hash to MGF1, so 'sha256'
   * matches it exactly. (Java's SunJCE "OAEPWithSHA-256AndMGF1Padding" would use
   * MGF1-SHA1 and NOT match.)
   */
  _oaepHash() { return (this.cfg.oaepHash || 'sha256').toLowerCase(); }

  /** Options for an OAEP operation; empty for PKCS#1 v1.5. */
  _rsaOpts() {
    const padding = this._rsaPadding();
    return padding === crypto.constants.RSA_PKCS1_OAEP_PADDING
      ? { padding, oaepHash: this._oaepHash() }
      : { padding };
  }

  /** RSA-encrypt the raw apiKey with GHI's public key (PEM). Returns base64. */
  rsaEncryptApiKey(rawApiKey, publicKeyPem) {
    const enc = crypto.publicEncrypt(
      { key: publicKeyPem, ...this._rsaOpts() },
      Buffer.from(rawApiKey, 'utf8'),
    );
    return enc.toString('base64');
  }

  /** RSA-decrypt a base64 apiKey using OUR private key (PEM). Returns string. */
  rsaDecryptApiKey(apiKeyB64, privateKeyPem) {
    const buf = Buffer.from(apiKeyB64, 'base64');
    const padding = this._rsaPadding();
    if (padding === crypto.constants.RSA_PKCS1_OAEP_PADDING) {
      return crypto.privateDecrypt({ key: privateKeyPem, ...this._rsaOpts() }, buf).toString('utf8');
    }
    // PKCS#1 v1.5: Node >= 18.19 refuses RSA_PKCS1_PADDING for privateDecrypt
    // (CVE-2023-46809, "Marvin"), so do the raw operation and strip the padding
    // ourselves. This is not a padding oracle: the ciphertext arrives from GHI
    // over TLS and a malformed block only ever raises locally — the result is
    // never echoed to a remote caller.
    const raw = crypto.privateDecrypt(
      { key: privateKeyPem, padding: crypto.constants.RSA_NO_PADDING },
      buf,
    );
    return pkcs1v15Unpad(raw).toString('utf8');
  }

  /**
   * checkSum = SHA-256( rawApiKey + encryptedData ), lowercase hex.
   * Order per spec: (1) raw apiKey, (2) encryptedData.
   */
  checksum(rawApiKey, encryptedDataB64) {
    return crypto.createHash('sha256').update(rawApiKey + encryptedDataB64, 'utf8').digest('hex');
  }

  /**
   * Verify a received checkSum (GHI response header) against our own value, in
   * constant time. A missing or malformed value simply fails.
   */
  verifyChecksum(rawApiKey, encryptedDataB64, receivedChecksum) {
    const expected = Buffer.from(this.checksum(rawApiKey, encryptedDataB64), 'utf8');
    const received = Buffer.from(String(receivedChecksum ?? ''), 'utf8');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  /** ROT47 cipher over printable ASCII (33..126). */
  static rot47(input) {
    let out = '';
    for (let i = 0; i < input.length; i += 1) {
      const c = input.charCodeAt(i);
      out += c >= 33 && c <= 126 ? String.fromCharCode(33 + ((c - 33 + 47) % 94)) : input[i];
    }
    return out;
  }

  /**
   * GH-CLIENT-CONTEXT = base64( ROT47( base64( JSON(context) ) ) ).
   * @param {object} context  { requestUID, country, channelID, clientIp, lang,
   *                            srcSystemName, srcClientId, rumEvents }
   */
  buildClientContext(context) {
    const json = JSON.stringify(context);
    const b64a = Buffer.from(json, 'utf8').toString('base64');
    const rot = GxCrypto.rot47(b64a);
    return Buffer.from(rot, 'utf8').toString('base64');
  }

  /** Inverse of buildClientContext (tests / debugging). */
  decodeClientContext(headerValue) {
    const rot = Buffer.from(headerValue, 'base64').toString('utf8');
    const b64a = GxCrypto.rot47(rot); // ROT47 is its own inverse over the range
    return JSON.parse(Buffer.from(b64a, 'base64').toString('utf8'));
  }

  /** Generate an RSA keypair for NovaCred (keys 'A'/'B'/'C' in the rotation). */
  static generateRsaKeyPair(modulusLength = 2048) {
    return crypto.generateKeyPairSync('rsa', {
      modulusLength,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
  }
}

/**
 * Strip PKCS#1 v1.5 type-2 padding from a raw RSA block.
 * EM = 0x00 || 0x02 || PS (>= 8 non-zero bytes) || 0x00 || M
 * Some OpenSSL builds drop the leading 0x00, so accept both framings.
 */
function pkcs1v15Unpad(block) {
  const start = block[0] === 0x00 ? 1 : 0;
  if (block.length < 11 || block[start] !== 0x02) {
    throw cryptoError('GX RSA decryption failed: bad PKCS#1 v1.5 block');
  }
  let i = start + 1;
  while (i < block.length && block[i] !== 0x00) i += 1;
  if (i === block.length || i - (start + 1) < 8) {
    throw cryptoError('GX RSA decryption failed: malformed PKCS#1 v1.5 padding');
  }
  return block.subarray(i + 1);
}
