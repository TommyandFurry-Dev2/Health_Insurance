import crypto from 'node:crypto';
import config from '../config/env.js';

// ─────────────────────────────────────────────────────────────────────────────
// Encryption, lookup hashes, masks and Purchase IDs for the health purchase
// store (migrations 008–014).
//
//   *_enc    AES-256-GCM. The stored bytes are
//              [0x01 format][key version, 2 bytes][IV, 12][tag, 16][ciphertext]
//            so any row can be decrypted by the key that wrote it, and the
//            key in use can be rotated by adding a higher version.
//   *_hash   HMAC-SHA256 of the normalised value (PAN upper-case, mobile's last
//            10 digits, email lower-case): find and de-duplicate without
//            decrypting. A separate key from the encryption keys.
//   *_masked display forms for ops screens.
//
// Keys come from the environment only and never reach the database:
//   HEALTH_DATA_ENC_KEYS  "1:<base64 32 bytes>[,2:<base64 32 bytes>…]"
//                         the highest version encrypts; every listed one decrypts
//   HEALTH_DATA_HASH_KEY  "<base64, at least 32 bytes>"
// Without both, the purchase store is off and every insurer flow runs exactly
// as before (services/healthPurchase.service.js).
// ─────────────────────────────────────────────────────────────────────────────

const FORMAT = 0x01;
const AAD = Buffer.from('health-purchase-store:v1', 'utf8');

/**
 * Parses the two key variables. Returns { ok, problem, current, keys, hashKey }
 * and never throws: a bad key turns the store off with a reason, it does not
 * stop the process.
 */
export function parseKeyring(encSpec, hashSpec) {
  const off = (problem) => ({ ok: false, problem, current: null, keys: new Map(), hashKey: null });
  const enc = String(encSpec || '').trim();
  const hash = String(hashSpec || '').trim();
  if (!enc && !hash) return off('HEALTH_DATA_ENC_KEYS and HEALTH_DATA_HASH_KEY are not set');
  if (!enc) return off('HEALTH_DATA_ENC_KEYS is not set');
  if (!hash) return off('HEALTH_DATA_HASH_KEY is not set');

  const keys = new Map();
  for (const part of enc.split(',').map((p) => p.trim()).filter(Boolean)) {
    const match = /^(\d{1,5}):(.+)$/.exec(part);
    if (!match) return off('HEALTH_DATA_ENC_KEYS must look like "1:<base64 key>"');
    const version = Number(match[1]);
    if (version < 1 || version > 65535) return off('HEALTH_DATA_ENC_KEYS versions must be 1–65535');
    if (keys.has(version)) return off(`HEALTH_DATA_ENC_KEYS lists version ${version} twice`);
    const key = Buffer.from(match[2], 'base64');
    if (key.length !== 32) return off(`HEALTH_DATA_ENC_KEYS version ${version} is not 32 bytes of base64`);
    keys.set(version, key);
  }
  if (keys.size === 0) return off('HEALTH_DATA_ENC_KEYS holds no key');

  const hashKey = Buffer.from(hash, 'base64');
  if (hashKey.length < 32) return off('HEALTH_DATA_HASH_KEY must be at least 32 bytes of base64');
  for (const key of keys.values()) {
    if (key.equals(hashKey)) return off('HEALTH_DATA_HASH_KEY must differ from every encryption key');
  }

  const version = Math.max(...keys.keys());
  return { ok: true, problem: null, current: { version, key: keys.get(version) }, keys, hashKey };
}

let ring = null;
function keyring() {
  if (!ring) ring = parseKeyring(config.healthStore?.encKeys, config.healthStore?.hashKey);
  return ring;
}

/** For tests: re-read the keys from config. */
export function resetHealthCryptoForTests() {
  ring = null;
}

/** { configured, problem, keyVersion } — names only, never a key. */
export function healthCryptoStatus() {
  const r = keyring();
  return { configured: r.ok, problem: r.problem, keyVersion: r.ok ? r.current.version : null };
}

export function currentKeyVersion() {
  const r = keyring();
  return r.ok ? r.current.version : 1;
}

/** Encrypts a Buffer or string. null/undefined/'' stay NULL. */
export function encrypt(value) {
  if (value === null || value === undefined || value === '') return null;
  const r = keyring();
  if (!r.ok) throw new Error(`health store encryption is off: ${r.problem}`);
  const plain = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', r.current.key, iv);
  cipher.setAAD(AAD);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  const head = Buffer.alloc(3);
  head.writeUInt8(FORMAT, 0);
  head.writeUInt16BE(r.current.version, 1);
  return Buffer.concat([head, iv, cipher.getAuthTag(), body]);
}

/** Encrypts a value as JSON text. */
export function encryptJson(value) {
  if (value === null || value === undefined) return null;
  return encrypt(JSON.stringify(value));
}

/** Decrypts what encrypt() wrote, with the key version recorded in it. */
export function decrypt(stored) {
  if (stored === null || stored === undefined) return null;
  const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
  if (buf.length < 31 || buf.readUInt8(0) !== FORMAT) throw new Error('not a health store ciphertext');
  const version = buf.readUInt16BE(1);
  const key = keyring().keys.get(version);
  if (!key) throw new Error(`no key for version ${version}`);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(3, 15));
  decipher.setAAD(AAD);
  decipher.setAuthTag(buf.subarray(15, 31));
  return Buffer.concat([decipher.update(buf.subarray(31)), decipher.final()]);
}

export function decryptText(stored) {
  const buf = decrypt(stored);
  return buf === null ? null : buf.toString('utf8');
}

// ── Normalising, lookup hashes, masks ───────────────────────────────────────

export const normalize = {
  pan: (v) => {
    const s = String(v ?? '').replace(/\s+/g, '').toUpperCase();
    return s || null;
  },
  mobile: (v) => {
    const digits = String(v ?? '').replace(/\D/g, '');
    return digits.length >= 10 ? digits.slice(-10) : (digits || null);
  },
  email: (v) => {
    const s = String(v ?? '').trim().toLowerCase();
    return s || null;
  },
};

/** HMAC-SHA256 (hex) of the normalised value, or null when there is none. */
export function lookupHash(kind, value) {
  const normalised = normalize[kind] ? normalize[kind](value) : (value ? String(value) : null);
  if (!normalised) return null;
  const r = keyring();
  if (!r.ok) throw new Error(`health store hashing is off: ${r.problem}`);
  return crypto.createHmac('sha256', r.hashKey).update(`${kind}:${normalised}`).digest('hex');
}

export const mask = {
  // ABCDE1234F → XXXXX1234F
  pan: (v) => {
    const s = normalize.pan(v);
    return s ? `XXXXX${s.slice(5)}`.slice(0, 10) : null;
  },
  // 9876543210 → 98XXXXXX10
  mobile: (v) => {
    const s = normalize.mobile(v);
    if (!s) return null;
    return s.length >= 4 ? `${s.slice(0, 2)}${'X'.repeat(Math.max(0, s.length - 4))}${s.slice(-2)}` : 'XXXX';
  },
  // Ramesh Kumar → R***** K****
  name: (v) => {
    const s = String(v ?? '').trim();
    if (!s) return null;
    return s.split(/\s+/).map((w) => `${w[0]}${'*'.repeat(Math.max(0, w.length - 1))}`).join(' ').slice(0, 120);
  },
};

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(Buffer.isBuffer(value) ? value : String(value)).digest('hex');
}

// ── Purchase ID ─────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * A ULID: 26 characters, Crockford base32, the first 10 the time in ms (so
 * they sort by creation), the last 16 random. 256 is a multiple of 32, so
 * taking each random byte mod 32 is unbiased.
 */
export function newUlid(now = Date.now()) {
  let time = '';
  let t = Math.floor(now);
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  let random = '';
  for (const byte of crypto.randomBytes(16)) random += CROCKFORD[byte % 32];
  return time + random;
}

export function isUlid(value) {
  return typeof value === 'string' && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}
