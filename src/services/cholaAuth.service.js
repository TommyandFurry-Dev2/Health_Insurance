import config from '../config/env.js';
import { requestChola } from './cholaHttp.service.js';
import { authError, configError, safeJson, trunc } from '../helpers/chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// The Chola MS OAuth2 bearer token — the working implementation's
// CholaAuthService, with its behaviour kept exactly:
//
//   POST {CHOLA_BASE_URL}{CHOLA_TOKEN_PATH}
//   Authorization: Basic base64(clientId:clientSecret)
//   body (urlencoded): grant_type=client_credentials
//     → { access_token, token_type, expires_in, ... }
//
//   * cached with its expiry and reused until within CHOLA_TOKEN_SKEW_SECONDS
//     of expiring, or until a forced refresh after a 401
//   * concurrent callers share ONE in-flight token request rather than each
//     minting their own
//   * no `expires_in` in the answer → assumed valid for an hour
//   * the token call itself is retried once, never more
//
// Process-local and disposable by design, like the other insurers' token
// caches: a restart simply mints a new one.
//
// Never logged: the token, the client id or the secret. The expiry is.
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  token: null,
  expiryMs: 0,
  inflight: null,
};

function isValid() {
  const skew = (config.chola.tokenSkewSeconds || 60) * 1000;
  return Boolean(state.token) && Date.now() < state.expiryMs - skew;
}

/** Return a valid bearer token, fetching or refreshing as needed. */
async function getCholaToken({ force = false } = {}) {
  if (!force && isValid()) return state.token;
  if (state.inflight) return state.inflight;
  state.inflight = fetchToken().finally(() => { state.inflight = null; });
  return state.inflight;
}

/** Forget the cached token. For tests and for an operator-driven rotation. */
function resetCholaToken() {
  state.token = null;
  state.expiryMs = 0;
  state.inflight = null;
}

function tokenEndpoint() {
  return `${config.chola.baseUrl}${config.chola.paths.token}`;
}

async function fetchToken() {
  const cfg = config.chola;
  if (!cfg.clientId || !cfg.clientSecret) {
    throw authError('CHOLA_CLIENT_ID / CHOLA_CLIENT_SECRET are not set');
  }
  if (!cfg.baseUrl) throw configError('CHOLA_BASE_URL is not set');

  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, 'utf8').toString('base64');
  const res = await requestChola({
    opName: 'token',
    method: 'POST',
    url: tokenEndpoint(),
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    data: 'grant_type=client_credentials',
    maxRetries: 1,
    logBody: false,
  });

  const body = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  if (res.status < 200 || res.status >= 300 || !body || !body.access_token) {
    console.error(
      `❌ [chola] token request refused — HTTP ${res.status}`
      + `${body?.error ? `, error "${body.error}"` : ''}`
      + `${body?.error_description ? `, "${body.error_description}"` : ''}`
    );
    throw authError('Chola token request failed', {
      details: { httpStatus: res.status, body: trunc(body, 300) },
    });
  }

  state.token = body.access_token;
  const ttl = Number(body.expires_in) || 3600;
  state.expiryMs = Date.now() + ttl * 1000;
  console.log(`[chola] obtained OAuth2 token — expires in ${ttl}s`);
  return state.token;
}

export { getCholaToken, resetCholaToken, tokenEndpoint };
