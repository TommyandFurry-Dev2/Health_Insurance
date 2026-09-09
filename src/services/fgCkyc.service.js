import axios from 'axios';

import config, { fgCkycFlavour, partialFgGcKycVariables } from '../config/env.js';
import { CKYC_PATH, GCKYC_PATH } from '../constants/fg.constants.js';
import {
  configError, upstreamError, parseError, validationError,
  requireFields, isDdMmYyyyDash, assert, buildFgExchange,
} from '../helpers/fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Future Generali CKYC — two services behind one interface.
//
// | | legacy NL-CKYC | GC-CKYC 3.0.0 |
// |---|---|---|
// | Auth | static `token` + `x-client-id` headers | OAuth2 password grant → Bearer |
// | Reference issued | `PR_` + 10 chars | `PR_` + 13 chars |
// | Resume a verification | not supported | yes, via proposalId |
// | Return the buyer to us | not supported | yes, via redirectUrl |
// | system_name | Webagg | KYCWEBAGG |
//
// Which one runs MATTERS: every working proposal sample Future Generali have
// sent carries a 13-character `PR_` reference, and only GC-CKYC issues those.
// GC-CKYC is selected when FG_GCKYC_ENABLED is on AND every credential is
// present; a PARTIAL configuration falls back to the legacy service with a
// warning rather than failing the KYC step outright, so a missing secret
// degrades instead of breaking the flow.
//
// Both normalise to exactly the same response shape, so nothing downstream —
// controller, SPA — has to branch on which answered. `flavour()` says which is
// live for the rare caller that wants to know.
//
// The flow either way:
//   1. createCKYC() submits the identity. If CERSAI hold a record the KYC
//      completes outright; otherwise an uploadUrl is returned for the customer
//      to complete verification on FG's own hosted page.
//   2. getStatus(proposalId) polls until finalStatus is 1 or 3.
// ─────────────────────────────────────────────────────────────────────────────

// Warned once per process rather than per call: a half-configured GC-CKYC is a
// deployment mistake, and repeating it on every KYC attempt buries it.
let partialWarningShown = false;

function warnIfPartiallyConfigured() {
  if (partialWarningShown) return;
  const missing = partialFgGcKycVariables();
  if (missing.length > 0) {
    partialWarningShown = true;
    console.warn(
      '⚠️  FG_GCKYC_ENABLED is on but GC-CKYC is not fully credentialed — falling back to the '
      + `legacy NL-CKYC service. Missing: ${missing.join(', ')}. Note that the legacy service `
      + 'mints short PR_ references, while every working FG proposal sample carries the '
      + '13-character reference only GC-CKYC issues.'
    );
  }
}

/** 'gc-ckyc-3.0.0' | 'nl-ckyc' | 'none' */
function flavour() {
  warnIfPartiallyConfigured();
  return fgCkycFlavour();
}

function assertCkycConfigured() {
  const live = flavour();
  if (live !== 'none') return live;
  throw configError(
    'Future Generali CKYC is not configured. Set FG_GCKYC_ENABLED plus the six FG_GCKYC_* '
    + 'variables for GC-CKYC 3.0.0 (recommended — it issues the reference FG\'s own working '
    + 'proposal samples carry), or FG_CKYC_BASE_URL for the legacy NL-CKYC service.',
    { missing: partialFgGcKycVariables() }
  );
}

// ── GC-CKYC OAuth2 ──────────────────────────────────────────────────────────
//
//   POST <FG_GCKYC_TOKEN_URL>
//   Authorization: Basic base64(clientKey:clientSecret)
//   body (urlencoded): grant_type=password&username=<u>&password=<p>
//   → { access_token, token_type: "Bearer", expires_in, scope }
//
// A password grant, not client_credentials: Generali Central issue both an
// API-manager application key/secret AND a service-account login, and the token
// endpoint requires all four. UAT returns expires_in 60000 (~16.6h), so the
// cache does real work; it is refreshed early by the configured skew and
// force-refreshed once by callers on a 401.
const tokenState = { token: null, expiresAtMs: 0, inflight: null };

function tokenIsValid() {
  const skewMs = (config.fg.gcKyc.tokenSkewSeconds || 60) * 1000;
  return Boolean(tokenState.token) && Date.now() < tokenState.expiresAtMs - skewMs;
}

function invalidateToken() {
  tokenState.token = null;
  tokenState.expiresAtMs = 0;
}

async function fetchToken() {
  const gc = config.fg.gcKyc;
  const basic = Buffer.from(`${gc.clientKey}:${gc.clientSecret}`, 'utf8').toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username: gc.username,
    password: gc.password,
  }).toString();

  const response = await axios.post(gc.tokenUrl, body, {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    timeout: config.timeouts.fgCkyc,
    validateStatus: () => true,
  });

  const parsed = typeof response.data === 'string' ? safeJson(response.data) : response.data;

  if (response.status < 200 || response.status >= 300 || !parsed?.access_token) {
    // The token endpoint echoes the GRANT back on failure — which contains the
    // service-account password — so the body is never logged or attached. Only
    // the status and the error code it returns.
    throw fgAuthError('The Future Generali GC-CKYC token request failed', {
      httpStatus: response.status,
      error: parsed?.error || null,
    });
  }

  tokenState.token = parsed.access_token;
  const ttlSeconds = Number(parsed.expires_in) || 3600;
  tokenState.expiresAtMs = Date.now() + ttlSeconds * 1000;

  console.log(
    `[fg] obtained a GC-CKYC OAuth2 token — expiresIn=${ttlSeconds}s scope=${parsed.scope || 'none'}`
  );
  return tokenState.token;
}

function fgAuthError(message, details) {
  const error = new Error(message);
  error.status = 502;
  error.code = 'FG_AUTH_ERROR';
  error.provider = 'fg';
  error.details = details;
  return error;
}

async function getToken({ force = false } = {}) {
  if (!force && tokenIsValid()) return tokenState.token;
  // Concurrent callers share one in-flight fetch rather than each minting a
  // token. A forced refresh still joins an existing one, which is correct: that
  // fetch is already newer than the token that just 401'd.
  if (tokenState.inflight) return tokenState.inflight;
  tokenState.inflight = fetchToken().finally(() => { tokenState.inflight = null; });
  return tokenState.inflight;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ── Transport ───────────────────────────────────────────────────────────────

async function post({ url, headers, body, opName }) {
  try {
    const response = await axios.post(url, body, {
      headers,
      timeout: config.timeouts.fgCkyc,
      validateStatus: () => true,
    });
    return {
      response,
      exchange: buildFgExchange({ url, headers, body, response }),
    };
  } catch (error) {
    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    const wrapped = new Error(
      timedOut
        ? `Future Generali ${opName} timed out after ${config.timeouts.fgCkyc}ms`
        : `Future Generali ${opName} failed: ${error.message}`
    );
    wrapped.status = timedOut ? 504 : 502;
    wrapped.code = timedOut ? 'FG_TIMEOUT_ERROR' : 'FG_UPSTREAM_ERROR';
    wrapped.provider = 'fg';
    wrapped.details = { errorCode: error.code || null, endpoint: url };
    wrapped.exchange = buildFgExchange({ url, headers, body, error });
    throw wrapped;
  }
}

/** GC-CKYC POST with a cached Bearer, retrying ONCE on 401 with a fresh one. */
async function postGcKyc(opName, path, body) {
  const url = `${config.fg.gcKyc.baseUrl}${path}`;

  const send = async (force) => {
    const token = await getToken({ force });
    return post({
      url,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body,
      opName,
    });
  };

  let result = await send(false);
  // The gateway returns 401/900901 for an expired token, which is routine here:
  // tokens live ~16h and the process may outlive one.
  if (result.response.status === 401) {
    invalidateToken();
    result = await send(true);
  }
  return result;
}

/**
 * Legacy NL-CKYC POST.
 *
 * FG's own CKYC API doc documents NO authentication for these two endpoints —
 * only the JSON body — and UAT accepts an unauthenticated call. Requiring a
 * token here refused a service that works, so the credentials are sent when
 * configured and omitted when not, rather than blocking the call.
 */
async function postNlCkyc(opName, path, body) {
  const cfg = config.fg.ckyc;
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.token) headers.token = cfg.token;
  if (cfg.clientId) headers['x-client-id'] = cfg.clientId;
  return post({ url: `${cfg.baseUrl}${path}`, headers, body, opName });
}

// ── Normalisation ───────────────────────────────────────────────────────────

function emptyToNull(value) {
  return value === '' || value === undefined ? null : value;
}

function readBody(response, op) {
  const { status, data } = response;
  if (status < 200 || status >= 300) {
    throw upstreamError(`Future Generali ${op} returned HTTP ${status}`, {
      httpStatus: status,
      body: typeof data === 'string' ? data.slice(0, 500) : data,
    });
  }
  if (typeof data !== 'string') return data;
  const parsed = safeJson(data);
  if (parsed === null) {
    throw parseError(`The Future Generali ${op} response is not JSON`, {
      snippet: data.slice(0, 200),
    });
  }
  return parsed;
}

/** GC-CKYC 3.0.0 → the shared shape. */
function normalizeGcKyc(response, op) {
  const body = readBody(response, op);

  // Everything of substance sits under `response`; the envelope carries only
  // apiStatus/errorMessage. Naming is inconsistent BETWEEN the two endpoints —
  // VerifyCKYC answers `proposal_id`, GetKycStatus answers `proposalId` — so
  // both spellings are read for every field that has two.
  const r = body.response || {};
  const docs = r.uploadedDocuments || null;

  return {
    ok: body.apiStatus === 'Success' && !body.errorMessage,
    op,
    flavour: 'gc-ckyc-3.0.0',
    reqId: r.req_id || r.reqId || null,
    proposalId: r.proposal_id || r.proposalId || null,
    // "1"/"3" mean the KYC passed, matching the legacy Final_Status semantics.
    finalStatus: r.finalStatus ?? r.final_status ?? null,
    // Known UAT oddity: GC-CKYC return "Mobile number length should be 10
    // digits" even for a valid 10-digit mobile, alongside a usable URL. It does
    // not block the flow — informational, not an error.
    ckycRemarks: r.ckyc_remarks || r.ckycRemarks || null,
    errorMessage: body.errorMessage || null,
    // GetKycStatus states WHY a KYC has not passed here ("KYC not completed"),
    // with apiStatus Success and no errorMessage — so this is the field to read
    // on a poll. finalStatus 0 alone says nothing a buyer could act on.
    message: r.message || null,
    // The legacy `kyc_data` (outstanding sub-checks) has no equivalent; the
    // nearest thing is what the customer has actually uploaded so far.
    kycData: docs,
    ckycNumber: emptyToNull(docs?.ckycNumber),
    customerType: r.customer_type || null,
    uploadUrl: r.url || null,
    // Not returned by GC-CKYC — the URL carries its own `access` token and FG
    // do not publish its lifetime.
    uploadUrlExpiry: null,
    result: body.response || null,
    raw: body,
  };
}

/** Legacy NL-CKYC → the shared shape. */
function normalizeNlCkyc(response, op) {
  const body = readBody(response, op);
  const result = body.result || body.results || null;

  return {
    ok: body.success === true,
    op,
    flavour: 'nl-ckyc',
    reqId: body.req_id || null,
    proposalId: body.proposal_id || null,
    finalStatus: body.Final_Status ?? body.finalStatus ?? null,
    ckycRemarks: body.ckyc_remarks || null,
    errorMessage: body.error_message || null,
    // GetCKYCStatus carries the only plain statement of WHY a KYC has not
    // passed — "KYC not completed" — under `message`, with success:true and no
    // error_message. Dropped, the caller can only guess from Final_Status 0.
    message: body.message || null,
    // Which sub-checks are outstanding: { PAN, UPLOAD, name_verification }.
    kycData: body.kyc_data || null,
    ckycNumber: result?.ckyc_number || null,
    customerType: body.customer_type || null,
    // When no record is found, FG return a URL for document upload.
    uploadUrl: body.url || null,
    uploadUrlExpiry: body.url_expiry || null,
    result,
    raw: body,
  };
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Submit an identity for CKYC verification.
 *
 * @param {object} input
 * @param {string} input.reqId         unique request id
 * @param {string} [input.proposalId]  pass to RESUME an existing verification
 * @param {string} input.idType        PAN|AADHAAR|CKYC|CIN|VOTER|DL|PASSPORT
 * @param {string} input.idNum
 * @param {string} input.fullName
 * @param {string} input.gender        M|F|T
 * @param {string} input.dob           dd-mm-yyyy — NOT the SOAP side's dd/mm/yyyy
 * @param {string} [input.mobile]      10 digits (GC-CKYC only)
 * @param {string} [input.redirectUrl] where FG return the customer (GC-CKYC only)
 */
async function createCKYC(input = {}) {
  const live = assertCkycConfigured();

  requireFields(input, ['reqId', 'idType', 'idNum', 'fullName', 'gender', 'dob'], 'CKYC create');
  assert(isDdMmYyyyDash(input.dob),
    'CKYC dob must be dd-mm-yyyy (the SOAP payload uses dd/mm/yyyy — the two are not '
    + 'interchangeable)',
    { field: 'dob', got: input.dob });

  if (live === 'gc-ckyc-3.0.0') {
    // Field names and order follow Generali Central's collection exactly, and
    // EVERY key is sent even when empty — the gateway rejects a partial
    // document rather than defaulting the gaps.
    const body = {
      req_id: input.reqId,
      // ⚠️ Pass this when RETRYING. GC-CKYC resume that verification and return
      // the same id and URL; without it a retry mints a NEW record and orphans
      // anything the customer has already uploaded. Verified on UAT.
      proposal_id: input.proposalId || '',
      id_type: input.idType,
      id_num: input.idNum,
      dob: input.dob,
      mobile: input.mobile || '',
      otp: input.otp || '',
      full_name: input.fullName,
      gender: input.gender,
      url_type: input.urlType || '',
      customer_type: input.customerType || 'I',
      redirect_url: input.redirectUrl || '',
      system_name: input.systemName || config.fg.gcKyc.systemName || 'KYCWEBAGG',
    };
    const { response, exchange } = await postGcKyc('GCKYC.VerifyCKYC', GCKYC_PATH.VERIFY, body);
    return { data: normalizeGcKyc(response, 'VerifyCKYC'), exchange, httpStatus: response.status };
  }

  const body = {
    req_id: input.reqId,
    customer_type: input.customerType || 'I',
    id_type: input.idType,
    id_num: input.idNum,
    full_name: input.fullName,
    gender: input.gender,
    dob: input.dob,
    url_type: input.urlType || 'P',
    system_name: input.systemName || config.fg.ckyc.systemName || 'Webagg',
  };
  const { response, exchange } = await postNlCkyc('CKYC.CreateCKYC', CKYC_PATH.CREATE, body);
  return { data: normalizeNlCkyc(response, 'CreateCKYC'), exchange, httpStatus: response.status };
}

/**
 * Poll a verification. finalStatus 1 or 3 means it passed; 0 means it has not
 * completed, with the reason in `message`.
 */
async function getStatus(proposalId) {
  const live = assertCkycConfigured();

  if (!proposalId || String(proposalId).trim() === '') {
    throw validationError('proposalId is required to check a CKYC status', 'proposalId');
  }

  if (live === 'gc-ckyc-3.0.0') {
    const { response, exchange } = await postGcKyc('GCKYC.GetKycStatus', GCKYC_PATH.STATUS, {
      proposal_id: proposalId,
      system_name: config.fg.gcKyc.systemName || 'KYCWEBAGG',
    });
    return { data: normalizeGcKyc(response, 'GetKycStatus'), exchange, httpStatus: response.status };
  }

  const { response, exchange } = await postNlCkyc('CKYC.GetCKYCStatus', CKYC_PATH.STATUS, {
    proposal_id: proposalId,
  });
  return { data: normalizeNlCkyc(response, 'GetCKYCStatus'), exchange, httpStatus: response.status };
}

export {
  flavour,
  assertCkycConfigured,
  createCKYC,
  getStatus,
  // Test seam — lets a smoke script drop a cached token without a restart.
  invalidateToken,
};
