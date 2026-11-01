import config, { iciciProfile, iciciVariable, iciciEnvironmentRefusal } from '../config/env.js';
import { currentIciciEnvironment } from '../helpers/iciciEnvironment.helper.js';
import { requestIcici } from './iciciHttp.service.js';
import { encryptPassword, normalizeEncKey } from '../helpers/iciciCrypto.helper.js';
import { authError, configError, safeJson } from '../helpers/icici.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The ICICI Lombard JWT bearer token — the working implementation's
// ElevateAuthService, with its behaviour kept exactly:
//
//   POST {EL_BASE_URL}{EL_TOKEN_PATH}  { Login, Password }
//        (UAT /auth-api/access/token, production /auth-api/v2/token)
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

// One cache per ICICI environment: a production token must never be sent to
// UAT, nor a UAT one to production.
const newState = () => ({ token: null, encKey: null, expiryMs: 0, inflight: null });
const states = { uat: newState(), production: newState() };
const stateFor = (environment) => states[environment] || states.uat;

function isValid(state) {
  const skew = (config.icici.tokenSkewSeconds || 60) * 1000;
  return Boolean(state.token) && Date.now() < state.expiryMs - skew;
}

/** Return a valid bearer token for the current ICICI environment, fetching or refreshing as needed. */
async function getIciciToken({ force = false } = {}) {
  const environment = currentIciciEnvironment();
  const state = stateFor(environment);
  if (!force && isValid(state)) return state.token;
  if (state.inflight) return state.inflight;
  state.inflight = fetchToken(environment).finally(() => { state.inflight = null; });
  return state.inflight;
}

/** The RSA public key (PEM) from the most recent token response, if any. */
function getIciciEncKey() {
  return stateFor(currentIciciEnvironment()).encKey;
}

/** Forget the cached tokens. For tests and for an operator-driven rotation. */
function resetIciciToken() {
  Object.assign(states.uat, newState());
  Object.assign(states.production, newState());
}

// Production's token path is not UAT's (/auth-api/v2/token against
// /auth-api/access/token) and has no default, like every production path.
function tokenEndpoint(environment = currentIciciEnvironment()) {
  const profile = iciciProfile(environment);
  const refusal = iciciEnvironmentRefusal(environment);
  if (refusal) throw configError(refusal);
  if (!profile.paths.token) throw configError(`${iciciVariable('EL_TOKEN_PATH', environment)} is not set`);
  return `${profile.baseUrl}${profile.paths.token}`;
}

async function fetchToken(environment) {
  const cfg = iciciProfile(environment);
  const state = stateFor(environment);
  if (!cfg.login) throw authError(`${iciciVariable('EL_LOGIN', environment)} is not set`);
  if (!cfg.baseUrl) throw configError(`${iciciVariable('EL_BASE_URL', environment)} is not set`);

  const url = tokenEndpoint(environment);

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
  console.log(
    `[icici] obtained ${environment === 'production' ? 'PRODUCTION ' : ''}bearer token — `
    + `expires ${body.expiry ?? '(not stated; assuming 15 minutes)'}`
  );
  return state.token;
}

export { getIciciToken, getIciciEncKey, resetIciciToken, tokenEndpoint };
