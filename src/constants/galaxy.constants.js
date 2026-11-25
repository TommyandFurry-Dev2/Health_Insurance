// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health Insurance (GHI) — CBOS-GX V2 constants, moved unchanged from the
// working implementation (novacred-insurance-integrations,
// src/providers/galaxy/constants.js), verified there from GHI's decrypted spec
// PDFs and GHI's mails.
//
// Base URLs (host only, GX_BASE_URL; each operation adds its own path):
//   UAT  : https://uat-gxapi.galaxyhealth.com
//   PROD : https://gxapi.galaxyhealth.com
//
// Every operation is POST, wraps its AES-encrypted JSON in
//   { "requestData": { "encryptedData": "<base64>" } }
// and returns
//   { statusCode, statusDescription, requestUID, results: [{ encryptedData }] }        (success)
//   { statusCode: "CBOS...", statusDescription, requestUID, results: [{ errorDesc }] } (error)
// ─────────────────────────────────────────────────────────────────────────────

export const GALAXY_PROVIDER = 'galaxy';

// Every Galaxy route lives under this prefix. Not env-driven, for the reason the
// other insurer prefixes are not: it is baked into the route table
// (routes/galaxy.routes.js) and the SPA's services/health/galaxy.
export const GALAXY_PATH_PREFIX = '/galaxy-health';

// Logical operation → path. The service prefix is part of the path.
export const GALAXY_OPERATIONS = Object.freeze({
  authenticate: { path: '/cbosgx-sec/api/v2/getPubKey' },        // referenced in the Auth V2 spec
  getCurrentPubKey: { path: '/cbosgx-sec/api/v2/getCurrentPubKey' },
  getNextPubKey: { path: '/cbosgx-sec/api/v2/getNextPubKey' },
  // getDomain is gone: GHI deprecated it (mail of 29 Oct 2026). Marvel's codes
  // are in GHI's data dictionary, constants/galaxy/GALMARVEL_Data_Dictionary.json.
  quickQuote: { path: '/cbosgx-quote/api/v2/quickQuote' },
  saveProposal: { path: '/cbosgx-rpolicy/api/v2/saveFullProposal' },
  createOrder: { path: '/cbosgx-rpolicy/api/v2/createOrder' },
  uploadDocument: { path: '/cbosgx-utils/api/v2/uploadDocument' },
  downloadDocument: { path: '/cbosgx-utils/api/v2/downloadDocument' },
  searchDocument: { path: '/cbosgx-utils/api/v2/searchDocument' },
});

// Product codes, as listed in GHI's getDomain V2 spec. quickQuote takes MARVEL.
//
// saveFullProposal does NOT: GHI UAT answers GXGLXYMRVL there with
// CBOSRES-4004 "Invalid Product Code." and accepts GALMARVEL (25 Nov 2026). The
// SPA sends productCode itself on every proposal, so MARVEL stays the default
// only for a caller that sends none, exactly as in the working implementation.
export const GALAXY_PRODUCT_CODES = Object.freeze({
  MARVEL: 'GXGLXYMRVL',
  MARVEL_PROPOSAL: 'GALMARVEL',
  PREMIA: 'GXGLXYPRMS',
  TOP_UP: 'GXGLXYTPP',
  GALPAC: 'GXGLXYPC',
  SENIOR: 'GXGLXYSNR',
  GUARD: 'GXGLXYGHGRD',
});

// createOrder order types (createOrder spec).
export const GALAXY_ORDER_TYPE = Object.freeze({
  PAYMENT_LINK: '01',
  QR: '03',
  MANDATE_ENACH: '04',
  BELSTAR: '06',
});

// HTTP header names (exact casing from GHI's sample cURL commands).
export const GALAXY_HEADER = Object.freeze({
  CLIENT_CONTEXT: 'GH-CLIENT-CONTEXT',
  REQUEST_UID: 'requestUID',
  CONTENT_TYPE: 'Content-Type',
  ACCEPT: 'Accept',
  AUTHORIZATION: 'Authorization', // value = "Basic " + appKey (GHI mail, 28 Oct 2026)
  API_KEY: 'apiKey',
  CHECKSUM: 'checkSum',
  // CBOS issue a per-consumer User-Agent alongside the appKey: Galaxy-NovaCred
  // ("NovaCred UAT Configurations" says Galaxy-NavaCred, a typo per GHI's mail
  // of 28 Oct 2026). It is part of the credential set, not a courtesy string.
  USER_AGENT: 'User-Agent',
});

// Success status code returned in the response envelope.
export const GALAXY_SUCCESS_STATUS = '200';

// getCurrentPubKey calls GHI allows per IST day ("GHI Public key steps").
export const GALAXY_KEY_FETCHES_PER_DAY = 3;

// Key-fetch calls are limited to 3 a day, so they are never retried.
export const GALAXY_KEY_FETCH_OPERATIONS = new Set(['getCurrentPubKey', 'getNextPubKey']);

// The api_name each call is audited under in api_transactions.
export const GALAXY_API_NAMES = Object.freeze({
  quickQuote: 'GALAXY_QUICK_QUOTE',
  saveProposal: 'GALAXY_SAVE_FULL_PROPOSAL',
  createOrder: 'GALAXY_CREATE_ORDER',
  uploadDocument: 'GALAXY_UPLOAD_DOCUMENT',
  downloadDocument: 'GALAXY_DOWNLOAD_DOCUMENT',
  searchDocument: 'GALAXY_SEARCH_DOCUMENT',
  getCurrentPubKey: 'GALAXY_GET_CURRENT_PUB_KEY',
  getNextPubKey: 'GALAXY_GET_NEXT_PUB_KEY',
  rotateKeys: 'GALAXY_ROTATE_KEYS',
});

// ── Payment (after createOrder) ─────────────────────────────────────────────

// The SPA page GHI's redirect hands the buyer back to (…/get-quote/health/galaxy-return).
export const GALAXY_PAYMENT_RETURN_PAGE = '/galaxy-return';

// An order's state: CREATED until GHI's result arrives, then GHI's own status
// (createOrder spec: CHARGED | PENDING_VBV | AUTHENTICATION_FAILED | AUTHORIZATION_FAILED).
export const GALAXY_PAYMENT_STATUS = Object.freeze({
  CREATED: 'CREATED',
  CHARGED: 'CHARGED',
  PENDING_VBV: 'PENDING_VBV',
  AUTHENTICATION_FAILED: 'AUTHENTICATION_FAILED',
  AUTHORIZATION_FAILED: 'AUTHORIZATION_FAILED',
});
