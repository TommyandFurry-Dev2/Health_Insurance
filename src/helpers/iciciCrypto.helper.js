import crypto from 'node:crypto';

import config from '../config/env.js';
import { authError } from './icici.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard "Elevate" crypto — carried over unchanged from the working
// implementation (src/providers/elevate/elCrypto.js there).
//
// 1) Password encryption for the token call: the auth spec says the Password is
//    "AES encrypted using the AES encryption key shared by IL". The exact mode
//    is not published in the kit, so it is env-configurable (EL_AES_MODE),
//    defaulting to aes-128-ecb (IL's usual scheme) with PKCS padding and base64
//    output. If IL share a 32-byte key, set EL_AES_MODE=aes-256-ecb.
//
//    Not used at all when EL_PASSWORD_PRE_ENCRYPTED=true — which is how IL
//    actually issue the UAT credential (see services/iciciAuth.service.js).
//
// 2) Optional request encryption using the RSA `encKey` returned by the token
//    API. The documented business samples are all PLAIN JSON, so nothing calls
//    rsaEncryptWithEncKey today; it is kept for any flow IL later require.
//
// No key, IV or password appears here — every one arrives through config.
// ─────────────────────────────────────────────────────────────────────────────

function keyBuffer(rawKey) {
  if (!rawKey) throw authError('EL_AES_KEY is not set (shared AES key from IL)');
  // Accept base64 (16/24/32 bytes) or a raw UTF-8 string key.
  try {
    const b = Buffer.from(rawKey, 'base64');
    if ([16, 24, 32].includes(b.length)) return b;
  } catch { /* not base64 */ }
  return Buffer.from(rawKey, 'utf8');
}

/** AES-encrypt the login password with the IL-shared key. Returns base64. */
function encryptPassword(plainPassword, cfg = config.icici) {
  const mode = (cfg.aesMode || 'aes-128-ecb').toLowerCase();
  const key = keyBuffer(cfg.aesKey);
  const needsIv = !mode.includes('ecb');
  const iv = needsIv ? (cfg.aesIv ? Buffer.from(cfg.aesIv, 'utf8').subarray(0, 16) : Buffer.alloc(16, 0)) : null;
  try {
    const cipher = crypto.createCipheriv(mode, key, iv);
    const enc = Buffer.concat([cipher.update(Buffer.from(plainPassword, 'utf8')), cipher.final()]);
    return enc.toString('base64');
  } catch (e) {
    throw authError(`Elevate password AES encryption failed (mode=${mode})`, { cause: e });
  }
}

/** Normalise the base64/PEM encKey from the token response into a PEM string. */
function normalizeEncKey(encKey) {
  if (!encKey) return null;
  const s = String(encKey).trim();
  if (s.includes('BEGIN')) return s;
  // encKey is base64 of a PEM public key per the kit sample.
  const decoded = Buffer.from(s, 'base64').toString('utf8');
  if (decoded.includes('BEGIN')) return decoded.trim();
  // Otherwise treat as base64 DER (SPKI) and wrap.
  const wrapped = s.replace(/\s+/g, '').match(/.{1,64}/g).join('\n');
  return `-----BEGIN PUBLIC KEY-----\n${wrapped}\n-----END PUBLIC KEY-----\n`;
}

/** RSA-encrypt an arbitrary string with the token-issued encKey (base64 out). */
function rsaEncryptWithEncKey(plaintext, encKeyPemOrB64) {
  const pem = normalizeEncKey(encKeyPemOrB64);
  const enc = crypto.publicEncrypt(
    { key: pem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(plaintext, 'utf8')
  );
  return enc.toString('base64');
}

export { encryptPassword, normalizeEncKey, rsaEncryptWithEncKey };
