import config from '../config/env.js';
import { requestChola } from './cholaHttp.service.js';
import { CHOLA_PROVIDER } from '../constants/chola.constants.js';
import {
  requireFields, authError, upstreamError, configError, toPortalDate, tokenRejection, safeJson, trunc,
} from '../helpers/chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS CKYC — a separate e-policy portal with its own auth. Ported from the
// working implementation's CholaCkycService, behaviour unchanged.
//
//   Auth  : POST {CHOLA_CKYC_BASE_URL}/epolicyv3api/api/KYC/CholaMS_CKYC_Auth
//           { PrivateKey, UserID } → a TokenKey used as a header on the next calls
//   Verify: POST …/Epolicyv3API/api/KYC/CholaMS_CKYC_Verify  (header TokenKey)
//           { Verify_Type, App_Ref_No, Customer_Type, Customer_Name, Gender,
//             DOB_DOI (DD-MMM-YYYY — see toPortalDate), Mobile_No, CKYC_No,
//             PAN_No, Aadhar_No, DL_No, Voter_ID, Passport_no, CIN,
//             Redirection_URL }
//   Query : POST …/Epolicyv3API/api/KYC/CholaMS_CKYC_Query   (header TokenKey)
//           { App_Ref_No, Transaction_ID } — answered on App_Ref_No only
//
// Every field above goes on every request, empty string where it does not
// apply — the collection sends all fifteen on Verify, and that is the shape
// reproduced here.
//
// The TokenKey is cached process-wide and re-minted once when the portal
// rejects it — by a 401/403, or (what it actually does) by an HTTP 200 body
// naming the token; see tokenRejection in chola.helper.js. A rejection that
// survives the retry is an AUTH_ERROR, never an all-null "success".
//
// Other `Status: "Failure"` bodies (e.g. "No record found") are genuine KYC
// OUTCOMES and pass through as data — the SPA's utils/cholaCkyc.js reads them.
//
// Unlike the product calls, CKYC does not need the product credentials: it has
// its own two variables (CHOLA_CKYC_BASE_URL, CHOLA_CKYC_PRIVATE_KEY).
// ─────────────────────────────────────────────────────────────────────────────

const state = { tokenKey: null };

/** Forget the cached TokenKey. For tests and for an operator-driven rotation. */
function resetCholaCkycToken() {
  state.tokenKey = null;
}

function base() {
  if (!config.chola.ckyc.baseUrl) throw configError('CHOLA_CKYC_BASE_URL is not set');
  return config.chola.ckyc.baseUrl;
}

function readBody(res) {
  return typeof res.data === 'string' ? safeJson(res.data) ?? res.data : res.data;
}

/** Authenticate and cache the TokenKey. */
async function auth() {
  const cfg = config.chola.ckyc;
  if (!cfg.privateKey) throw authError('CHOLA_CKYC_PRIVATE_KEY is not set');
  const res = await requestChola({
    opName: 'ckyc.auth',
    method: 'POST',
    url: `${base()}${config.chola.paths.ckycAuth}`,
    headers: { 'Content-Type': 'application/json' },
    data: { PrivateKey: cfg.privateKey, UserID: cfg.userId || '' },
    maxRetries: 1,
    // The body IS the private key.
    logBody: false,
  });
  const body = typeof res.data === 'string' ? safeJson(res.data) : res.data;
  const tokenKey = body?.TokenKey || body?.tokenKey || body?.Token || (typeof body === 'string' ? body : null);
  if (res.status < 200 || res.status >= 300 || !tokenKey) {
    throw authError('Chola CKYC auth failed', { details: { httpStatus: res.status, body: trunc(body) } });
  }
  state.tokenKey = tokenKey;
  console.log('[chola] obtained CKYC TokenKey');
  return tokenKey;
}

async function tokenHeader() {
  if (!state.tokenKey) await auth();
  return { TokenKey: state.tokenKey };
}

async function post(path, data, opName) {
  const url = `${base()}${path}`;
  const send = async () => requestChola({
    opName,
    method: 'POST',
    url,
    headers: { 'Content-Type': 'application/json', ...(await tokenHeader()) },
    data,
    maxRetries: 1,
    context: { appRefNo: data.App_Ref_No },
  });

  let res = await send();
  let body = readBody(res);

  // Re-auth once on either signal: a transport 401/403, or the body-level
  // token rejection the portal actually returns (HTTP 200).
  if (res.status === 401 || res.status === 403 || tokenRejection(body)) {
    console.log(`[chola] ${opName} rejected the CKYC TokenKey — re-authenticating and retrying once`);
    state.tokenKey = null;
    await auth();
    res = await send();
    body = readBody(res);
  }

  const exchange = { url, method: 'POST', responseStatus: res.status };
  if (res.status < 200 || res.status >= 300) {
    const error = upstreamError(`Chola ${opName} returned HTTP ${res.status}`, {
      details: { httpStatus: res.status, body: trunc(body) },
    });
    error.exchange = exchange;
    throw error;
  }
  const rejected = tokenRejection(body);
  if (rejected) {
    const error = authError(`Chola ${opName} rejected the CKYC TokenKey: ${rejected}`, {
      details: { httpStatus: res.status, body: trunc(body) },
    });
    error.exchange = exchange;
    throw error;
  }
  return { body, exchange };
}

/**
 * Verify CKYC. `input`: { verifyType='VERIFY', appRefNo, customerType,
 *   customerName, gender?, dobDoi?, mobileNo?, ckycNo?, panNo?, aadharNo?,
 *   dlNo?, voterId?, passportNo?, cin?, redirectionUrl? }
 *
 * Customer_Type is the kit's own master: 'I' individual, 'C' corporate.
 * Gender is single-letter M/F, not the word form the proposal uses.
 */
async function verify(input = {}) {
  requireFields(input, ['appRefNo', 'customerType', 'customerName'], 'Chola CKYC verify');
  const body = {
    Verify_Type: input.verifyType || 'VERIFY',
    App_Ref_No: input.appRefNo,
    Customer_Type: input.customerType,
    Customer_Name: input.customerName,
    Gender: input.gender || '',
    DOB_DOI: toPortalDate(input.dobDoi),
    Mobile_No: input.mobileNo || '',
    CKYC_No: input.ckycNo || '',
    PAN_No: input.panNo || '',
    Aadhar_No: input.aadharNo || '',
    DL_No: input.dlNo || '',
    Voter_ID: input.voterId || '',
    Passport_no: input.passportNo || '',
    CIN: input.cin || '',
    Redirection_URL: input.redirectionUrl || '',
  };
  const { body: data, exchange } = await post(config.chola.paths.ckycVerify, body, 'ckyc.verify');
  console.log(
    `[chola] CKYC verify — appRefNo=${input.appRefNo} status=${data?.Status ?? null} `
    + `ckycNo=${data?.CKYC_No ? 'present' : 'none'}`
  );
  return { result: { ok: true, provider: CHOLA_PROVIDER, operation: 'ckyc.verify', data }, exchange };
}

/**
 * Query CKYC. The collection sends both keys, and the portal answers on
 * App_Ref_No — which is why that one is required here and Transaction_ID is
 * not. Verified live 2026-09-18 against one transaction:
 *
 *   { App_Ref_No, Transaction_ID:'' }  → the full record
 *   { App_Ref_No, Transaction_ID }     → the same record, byte for byte
 *   { App_Ref_No:'', Transaction_ID }  → EVERY FIELD null
 *
 * So Transaction_ID is an echo, never a lookup key, and an App_Ref_No the
 * portal has no record for answers as all-nulls rather than as an error —
 * which is why the caller must be able to tell the two apart (see the
 * `noRecord` note in the frontend parser).
 */
async function query(input = {}) {
  requireFields(input, ['appRefNo'], 'Chola CKYC query');
  const { body: data, exchange } = await post(
    config.chola.paths.ckycQuery,
    { App_Ref_No: input.appRefNo, Transaction_ID: input.transactionId || '' },
    'ckyc.query'
  );
  console.log(`[chola] CKYC query — appRefNo=${input.appRefNo} status=${data?.Status ?? null}`);
  return { result: { ok: true, provider: CHOLA_PROVIDER, operation: 'ckyc.query', data }, exchange };
}

export { auth, verify, query, resetCholaCkycToken };
