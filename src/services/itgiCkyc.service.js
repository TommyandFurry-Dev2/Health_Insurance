import config from '../config/env.js';
import { callItgi, assertConfigured } from './itgiApi.service.js';
import { ITGI_OPERATIONS } from '../constants/itgi.constants.js';
import { ckycSearchEnvelope, ckycCreateEnvelope } from '../helpers/itgi.helper.js';
import { prepareCkycFetch, prepareCkycCreate } from '../helpers/itgiValidation.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// IFFCO Tokio CKYC — search and create.
//
// Source: ITGI Partner CKYC Kit v1.4.1, a separate kit from the v3.5 health
// one. This is where `itgiUniqueReferenceId` (the IURN) comes from, and a
// health proposal cannot be issued without it — `itgiKYCReferenceNo` IS that
// value.
//
//   POST {base}/partner-services/kyc/fetch    search CERSAI for a record
//   POST {base}/partner-services/kyc/create   register one, returns the IURN
//
// The documented flow is fetch → validate-OTP → create, but
// /partner-services/kyc/fetch-validate-otp answers 404 on this host, so an
// OTP-pending record cannot be progressed and is reported as such rather than
// guessed at.
//
// The two legs do NOT answer alike, and neither answers like the health
// endpoints — see ckycSearchEnvelope / ckycCreateEnvelope in the helper, and
// the four-way failure detection in itgiApi.service.js.
//
// Shares the transport, and therefore the Basic credentials, the base URL and
// the retry policy, with every other ITGI call — nothing about auth or config
// is duplicated here.
//
// Nothing in this file logs the identifier, the mobile number or the IURN.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Search ITGI/CERSAI for an existing KYC record.
 *
 * @param {object} input
 * @param {string} input.firstName
 * @param {string} [input.middleName]
 * @param {string} [input.lastName]
 * @param {string} input.dateofBirth   DD-MM-YYYY — hyphens, and NOT the ISO
 *                                     order, nor the health endpoints' slashes
 * @param {string} [input.gender]      M | F | T
 * @param {string} input.idType        PAN | PASSPORT | VOTER ID | …
 * @param {string} input.idNumber
 * @param {string} [input.mobileNumber] mandatory for IND; must match the mobile
 *                                      held on the CKYC record
 * @param {string} [input.clientType]  IND (default) | LE
 *
 * `No Record` is a search OUTCOME, not a failure: it comes back as data with
 * noRecord true so the caller can offer to create one.
 */
async function fetchCkyc(input = {}) {
  assertConfigured();
  const body = prepareCkycFetch(input);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.KYC_FETCH, body);
  return { data: ckycSearchEnvelope(data), exchange, httpStatus };
}

/**
 * Create a CKYC record when the search found none, and return its IURN.
 *
 * This WRITES a record — at ITGI and, through them, at CERSAI. It is only ever
 * reached from an explicit customer action after a `No Record` search.
 *
 * Given its own timeout (ITGI_CKYC_CREATE_TIMEOUT_MS, default 120s): measured
 * at 44 seconds on staging 2026-08-25 against ~1s for the health calls, and a
 * timeout here costs the customer their document uploads.
 *
 * Not retried — a repeat could mint a second record for the same person.
 *
 * @param {object} input personal + permanent/correspondence address +
 *                       kycDocuments[]; see prepareCkycCreate for the field list.
 */
async function createCkyc(input = {}) {
  assertConfigured();
  const body = prepareCkycCreate(input);
  const { data, exchange, httpStatus } = await callItgi(ITGI_OPERATIONS.KYC_CREATE, body, {
    timeout: config.timeouts.itgiCkycCreate,
    maxRetries: 0,
  });
  // Raises when no IURN was minted, carrying ITGI's own sentence — that text is
  // the only thing that tells the customer what to fix.
  return { data: ckycCreateEnvelope(data), exchange, httpStatus };
}

export { fetchCkyc, createCkyc };
