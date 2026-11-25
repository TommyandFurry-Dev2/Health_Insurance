import { missingGalaxyVariables } from '../config/env.js';
import { GALAXY_PRODUCT_CODES } from '../constants/galaxy.constants.js';
import {
  configError, requireFields, extractQuoteSummary, extractOrder, withProducerCode, envelope, galaxyLog as logger,
} from '../helpers/galaxy.helper.js';
import { checkQuickQuote } from '../helpers/galaxyDictionary.helper.js';
import { galaxyClient } from './galaxyClient.service.js';

// ─────────────────────────────────────────────────────────────────────────────
// Galaxy Health operations — the working implementation's GalaxyAdapter
// (src/providers/galaxy/gxAdapter.js), unchanged:
//
//   getQuote          → quickQuote        (product default: GXGLXYMRVL)
//   createProposal    → saveFullProposal
//   issuePolicy       → createOrder       (returns GHI's payment returnUrl + orderId)
//   uploadDocument, downloadDocument, searchDocument
//   refreshCurrentKey, refreshNextKey, rotateKeys   (ops only)
//
// The bodies go to GHI as the caller sent them (the GX schemas are rich and
// product-specific; the SPA builds them), with only the mandatory-field guards
// the specs document. One addition: getQuote LOGS what GHI's Marvel data
// dictionary does not list and the mandatory fields that are empty — it never
// refuses on it.
// ─────────────────────────────────────────────────────────────────────────────

function assertConfigured() {
  const missing = missingGalaxyVariables();
  if (missing.length) {
    throw configError(`Galaxy is not configured. Missing: ${missing.join(', ')}`, { details: { missing } });
  }
}

/** quickQuote. `input` is the decrypted quickQuote body (productCode, basicDetails, members, discountLoads). */
export async function getQuote(input) {
  assertConfigured();
  const client = galaxyClient();
  const payload = withProducerCode({ productCode: GALAXY_PRODUCT_CODES.MARVEL, ...input }, client.cfg.producerCode);
  requireFields(payload, ['productCode', 'applicationNumber', 'basicDetails', 'members'], 'GX quickQuote');

  const check = checkQuickQuote(payload);
  if (check.missing.length || check.notInDictionary.length) {
    logger.warn('quickQuote pre-flight (information only, still sent)', check);
  }

  const res = await client.call({ operation: 'quickQuote', payload });
  // The spec's decrypted success response is an array holding the quote
  // ("Unencrypted Success Response"); a bare quote object is still accepted.
  const quotes = Array.isArray(res.data) ? res.data : [res.data];
  const data = { ...quotes[0], summary: extractQuoteSummary(quotes[0]) };
  if (quotes.length > 1) data.quotes = quotes;
  return envelope('getQuote', data, res);
}

/** saveFullProposal. `input` is the decrypted proposal body. */
export async function createProposal(input) {
  assertConfigured();
  const payload = { productCode: GALAXY_PRODUCT_CODES.MARVEL, ...input };
  requireFields(payload, ['productCode'], 'GX saveFullProposal');
  const res = await galaxyClient().call({ operation: 'saveProposal', payload });
  return envelope('createProposal', res.data, res);
}

/** createOrder. `input`: { refId, txnAmount, txnCurr, referenceNo, firstName, lastName, mobileNo, emailId, orderType, ... }. */
export async function issuePolicy(input) {
  assertConfigured();
  requireFields(input, ['refId', 'txnAmount', 'txnCurr', 'firstName', 'orderType'], 'GX createOrder');
  const res = await galaxyClient().call({ operation: 'createOrder', payload: input });
  return envelope('issuePolicy', extractOrder(res.data), res);
}

export async function uploadDocument(input) {
  assertConfigured();
  const res = await galaxyClient().call({ operation: 'uploadDocument', payload: input });
  return envelope('uploadDocument', res.data, res);
}

export async function downloadDocument(input) {
  assertConfigured();
  const res = await galaxyClient().call({ operation: 'downloadDocument', payload: input });
  return envelope('downloadDocument', res.data, res);
}

export async function searchDocument(input) {
  assertConfigured();
  const res = await galaxyClient().call({ operation: 'searchDocument', payload: input });
  return envelope('searchDocument', res.data, res);
}

/** Fetch GHI's current public key (Y) and store it. One of GHI's 3 a day. */
export async function refreshCurrentKey() {
  assertConfigured();
  const res = await galaxyClient().getCurrentPubKey();
  return envelope('refreshCurrentKey', res.data, res);
}

/** Fetch GHI's next public key (Z) and store it. */
export async function refreshNextKey() {
  assertConfigured();
  const res = await galaxyClient().getNextPubKey();
  return envelope('refreshNextKey', res.data, res);
}

/** Promote next→current (daily rollover). */
export function rotateKeys() {
  assertConfigured();
  const promoted = galaxyClient().keyStore.promoteGhi();
  return envelope('rotateKeys', { promoted }, {});
}

/**
 * The key store's state, for GET /galaxy-health/config/test and the boot
 * banner. Dates and counts only: no key material.
 */
export function keyStatus(now = new Date()) {
  const client = galaxyClient();
  const ks = client.keyStore;
  return {
    keyStoreDir: ks.dir,
    todaysGhiKey: ks.hasGhiKeyFor(now, client.cfg.keyRefreshAt),
    lastKeyReceivedAt: ks.ghiReceivedAt(),
    keyFetchesToday: ks.keyFetchesOn(now),
  };
}
