import config from '../config/env.js';
import { requestIcici } from './iciciHttp.service.js';
import { encryptPassword, normalizeEncKey } from '../helpers/iciciCrypto.helper.js';
import { authError, configError, safeJson } from '../helpers/icici.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The ICICI Lombard JWT bearer token — the working implementation's
// ElevateAuthService, with its behaviour kept exactly:
//
//   POST {EL_BASE_URL}{EL_TOKEN_PATH}  { Login, Password }
//     → { token, expiry, encKey, success, errorCode, errorMessage }
//
//   * cached with its expiry and reused until within EL_TOKEN_SKEW_SECONDS of
//     expiring, or until a forced refresh after a 401
//   * concurrent callers share ONE in-flight token request rather than each
//     minting their own
//   * no `expiry` in the answer → assumed valid for 15 minutes
//   * the response `encKey` (RSA public key) is cached alongside it
//   * the token call itself is retried once, never more
//
// Process-local and disposable by design, like the NivaBupa token caches: a
// restart simply mints a new one.
//
// Never logged: the token, the password, or the login. The expiry is.
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  token: null,
  encKey: null,
  expiryMs: 0,
  inflight: null,
};

function isValid() {
  const skew = (config.icici.tokenSkewSeconds || 60) * 1000;
  return Boolean(state.token) && Date.now() < state.expiryMs - skew;
}

/** Return a valid bearer token, fetching or refreshing as needed. */
async function getIciciToken({ force = false } = {}) {
  if (!force && isValid()) return state.token;
  if (state.inflight) return state.inflight;
  state.inflight = fetchToken().finally(() => { state.inflight = null; });
  return state.inflight;
}

/** The RSA public key (PEM) from the most recent token response, if any. */
function getIciciEncKey() {
  return state.encKey;
}

/** Forget the cached token. For tests and for an operator-driven rotation. */
function resetIciciToken() {
  state.token = null;
  state.encKey = null;
  state.expiryMs = 0;
  state.inflight = null;
}

function tokenEndpoint() {
  return `${config.icici.baseUrl}${config.icici.paths.token}`;
}

async function fetchToken() {
  const cfg = config.icici;
  if (!cfg.login) throw authError('EL_LOGIN is not set');
  if (!cfg.baseUrl) throw configError('EL_BASE_URL is not set');

  const url = tokenEndpoint();

  // IL normally hand over the password already AES-encrypted — their auth
  // spec's Password field is "a valid encrypted password", i.e. the ciphertext
  // to send, not a plaintext to encrypt. Re-encrypting that would produce a
  // double-encrypted value and a 401. Verified against UAT 2026-08-18: the
  // issued credential is one 16-byte AES block in base64 and authenticates when
  // sent verbatim.
  const encryptedPassword = cfg.passwordPreEncrypted
    ? cfg.password
    : encryptPassword(cfg.password, cfg);

  const res = await requestIcici({
    opName: 'token',
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json' },
    data: { Login: cfg.login, Password: encryptedPassword },
    maxRetries: 1,
    logBody: false,
  });

  const body = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  if (res.status < 200 || res.status >= 300 || !body || body.success === false || !body.token) {
    console.error(
      `❌ [icici] token request refused — HTTP ${res.status}`
      + `${body?.errorCode !== undefined ? `, errorCode ${body.errorCode}` : ''}`
      + `${body?.errorMessage ? `, "${body.errorMessage}"` : ''}`
      + ` (password sent ${cfg.passwordPreEncrypted ? 'pre-encrypted' : `encrypted with ${cfg.aesMode}`})`
    );
    throw authError('Elevate token request failed', {
      details: { httpStatus: res.status, errorCode: body?.errorCode, errorMessage: body?.errorMessage },
    });
  }

  state.token = body.token;
  state.encKey = normalizeEncKey(body.encKey);
  // Prefer the server-provided expiry; fall back to 15 minutes.
  const exp = body.expiry ? Date.parse(body.expiry) : NaN;
  state.expiryMs = Number.isNaN(exp) ? Date.now() + 15 * 60 * 1000 : exp;
  console.log(`[icici] obtained bearer token — expires ${body.expiry ?? '(not stated; assuming 15 minutes)'}`);
  return state.token;
}

export { getIciciToken, getIciciEncKey, resetIciciToken, tokenEndpoint };
