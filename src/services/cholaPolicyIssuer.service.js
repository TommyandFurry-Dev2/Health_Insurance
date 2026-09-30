import axios from 'axios';

import config from '../config/env.js';
import * as cholaRepository from '../repositories/chola.repository.js';
import {
  assertConfigured, resolveProduct, callChola, policySchedule, publicUrl,
} from './cholaApi.service.js';
import {
  CHOLA_PAYMENT_MODES, CHOLA_PROVIDER, CHOLA_PROPOSAL_STATUS,
} from '../constants/chola.constants.js';
import {
  validationError, configError, requireFields, extractPolicy, envelope, hostOf,
} from '../helpers/chola.helper.js';
import {
  buildPolicyGenerationBody, outcomeOfResponse, outcomeOfError,
} from '../helpers/cholaPolicyGeneration.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola MS PolicyGeneration — both paths, and the evidence log they share.
//
// A port of the working implementation's CholaAdapter.issuePolicy (the website
// path) and CholaPolicyIssuer (the backend-built path), with behaviour kept
// exactly.
//
// ── The website path (issuePolicy) ──────────────────────────────────────────
// The browser builds a PG request (utils/cholaQuote.js's
// buildCholaPolicyGenerationRequest) and it is sent as given. Only TaggingMode
// PG is accepted from a browser: any other mode tags a premium that no gateway
// collected, and APD in particular is paid out of NovaCred's own deposit, so the
// browser is never trusted to choose it.
//
// With CHOLA_PAYMENT_MODE=APD (UAT only; production refuses it) the SERVER
// chooses APD instead: the browser's tagging fields are dropped, and only the
// proposal number and amount go to issue() below. There is no payment page: the
// policy number comes back on the same call.
//
// ── The backend-built path (issue) ──────────────────────────────────────────
// PolicyGeneration built and sent by the BACKEND, in the payment mode this
// environment is configured for. Reached from POST /chola-ms/ops/PolicyGeneration,
// scripts/uat-chola-apd.js, and the website route under APD.
//
// ⚠️ SENT ONCE, NEVER RETRIED. PolicyGeneration is not idempotent — a second
// call for one proposal fails with
//   "AssignDataForPolGen : Message :ORA-00001: unique constraint
//    (INS.UK_WS_PORTAL_PAY) violated"
// (verified on UAT 2026-09-09) — and under APD a second call that succeeded
// would debit the deposit twice. So:
//   - the proposal is claimed in health_chola_proposals BEFORE anything is sent,
//     and a proposal already claimed is refused;
//   - the request goes out with maxRetries 0 — no transport-level re-send;
//   - an outcome that cannot be read (timeout, 5xx) is NEEDS_REVIEW, which is
//     reconciled with Chola by a person, not re-sent by this code.
// The only state a re-attempt is accepted from is PAYMENT_FAILED — Chola said
// no, or the request never left — and only when someone asks for it again.
//
// ⚠️ The WEBSITE's PG path is not claimed and keeps the working
// implementation's CHOLA_MAX_RETRIES transport retries (on 502/503/504 and
// network failures) — preserved, not silently changed. See docs/chola-ms.md.
//
// Every exchange, from either path, is written to
// health_chola_policy_generation_logs.
// ─────────────────────────────────────────────────────────────────────────────

const { POLICY_ISSUED, NEEDS_REVIEW } = CHOLA_PROPOSAL_STATUS;

// The store and the PDF fetcher, swappable for tests the way the working
// implementation's CholaAdapter({ store }) was — nothing under test may write
// to a real schema, or reach Chola's internal document host.
const deps = {
  store: cholaRepository,
  fetchPdf: downloadPdf,
};

/**
 * Replace the store and/or PDF fetcher. Returns a function that restores the
 * previous ones. For tests only.
 */
function setCholaIssuerDependencies(overrides = {}) {
  const previous = { ...deps };
  Object.assign(deps, overrides);
  return () => Object.assign(deps, previous);
}

/** The store currently in use — the ops PDF route reads through it. */
function cholaStore() {
  return deps.store;
}

/** The configured mode, refused if unknown — or if APD is set in production. */
function paymentMode() {
  const mode = config.chola.paymentMode;
  if (!CHOLA_PAYMENT_MODES.includes(mode)) {
    throw configError(`CHOLA_PAYMENT_MODE "${mode}" is not one of ${CHOLA_PAYMENT_MODES.join(', ')}`);
  }
  // APD is under UAT evaluation. A production process that picked it up by
  // mistake would issue policies against NovaCred's deposit, so it is refused
  // outright rather than trusted to be configured right.
  if (mode === 'APD' && config.env === 'production') {
    throw configError('CHOLA_PAYMENT_MODE=APD is UAT-only and is refused when NODE_ENV=production');
  }
  return mode;
}

/**
 * The onExchange callback that writes a PolicyGeneration exchange to
 * health_chola_policy_generation_logs. Shared by both paths, so the website's
 * PG requests and the backend's APD requests are evidenced the same way.
 *
 * A failed write does not fail the call — the request has already reached
 * Chola by then — but it is logged at error level WITH the evidence, so the
 * application log still holds it.
 */
function policyGenerationRecorder({
  store, source, productKey, paymentMode: mode = null, body, onSent,
}) {
  return async (x) => {
    if (onSent) onSent();
    const entry = {
      ...x,
      source,
      product: productKey,
      paymentMode: mode,
      taggingMode: body?.TaggingMode ?? null,
      payMode: body?.PayMode ?? null,
      genconProposalNumber: body?.GenconProposalNumber != null ? String(body.GenconProposalNumber) : null,
    };
    try {
      await store.insertPolicyGenerationLog(entry);
    } catch (error) {
      console.error(`❌ [chola] PolicyGeneration evidence NOT stored: ${error.message}`);
      console.error(JSON.stringify({
        at: entry.at instanceof Date ? entry.at.toISOString() : entry.at,
        source,
        product: productKey,
        paymentMode: mode,
        genconProposalNumber: entry.genconProposalNumber,
        url: entry.url,
        requestBody: entry.requestBody,
        httpStatus: entry.httpStatus,
        responseBody: entry.responseBody,
        error: entry.error,
      }));
    }
  };
}

// ── The website path ────────────────────────────────────────────────────────

/**
 * PolicyGeneration as the website sends it. Tags a payment against a saved
 * proposal.
 *
 * With PayMode "Chola" it answers a hosted payment URL and an empty policy
 * number; with "Direct" it answers the policy number directly. Under
 * CHOLA_PAYMENT_MODE=APD it issues from the deposit instead (see above).
 */
async function issuePolicy(input = {}) {
  assertConfigured();
  const productKey = resolveProduct(input);
  const { product, ...rest } = input;
  requireFields(rest, ['GenconProposalNumber', 'Amount'], 'Chola PolicyGeneration');
  const tagging = String(rest.TaggingMode ?? '').trim();
  if (tagging && tagging.toUpperCase() !== 'PG') {
    throw validationError(
      `TaggingMode "${tagging}" is not accepted on this route — only PG. `
      + 'APD is chosen by the server (CHOLA_PAYMENT_MODE), never by the browser.',
      { field: 'TaggingMode' }
    );
  }
  if (config.chola.paymentMode === 'APD') {
    return issueFromDeposit(productKey, rest);
  }
  const res = await callChola({
    productKey,
    operation: 'PolicyGeneration',
    body: rest,
    onExchange: policyGenerationRecorder({
      store: deps.store, source: 'website', productKey, body: rest,
    }),
  });
  const data = extractPolicy(res.data);
  // Chola's hosted payment page comes back on their internal address — see
  // rewriteUrl in chola.helper.js. The untouched value stays on `raw` either way.
  data.paymentUrl = publicUrl(data.paymentUrl);
  console.log(
    `[chola] PolicyGeneration parsed — product=${productKey} proposal=${rest.GenconProposalNumber} `
    + `status=${data.status ?? null} policy=${data.genconPolicyNumber ?? null} `
    + `paymentUrl=${data.paymentUrl ? 'present' : 'none'}`
  );
  return { result: envelope('issuePolicy', productKey, data, res), exchange: res.exchange };
}

/**
 * The website's PolicyGeneration under APD, answered in the same envelope as
 * the PG path so the browser reads it the same way. `outcome` carries the
 * issuer's verdict (POLICY_ISSUED | PAYMENT_FAILED | NEEDS_REVIEW), which is
 * what the browser acts on: `raw.Status` alone reads "Success" for a call that
 * returned no policy number, and a timeout has no `raw` at all.
 */
async function issueFromDeposit(productKey, { GenconProposalNumber, Amount }) {
  const { result, exchange } = await issue(
    { product: productKey, GenconProposalNumber, Amount },
    { source: 'website' }
  );
  const d = result.data;
  return {
    result: envelope('issuePolicy', productKey, {
      succeeded: d.status === POLICY_ISSUED,
      status: d.response?.Status ?? null,
      message: d.message,
      genconPolicyNumber: d.genconPolicyNumber,
      paymentUrl: null,
      payzappId: null,
      raw: d.response,
      paymentMode: d.paymentMode,
      outcome: d.status,
      schedule: d.schedule,
    }, { status: result.meta.httpStatus, correlationId: result.meta.correlationId }),
    exchange,
  };
}

// ── The backend-built path ──────────────────────────────────────────────────

/**
 * @param {{product?: string, GenconProposalNumber: string, Amount: string|number,
 *          paymentReference?: string}} input
 * @param {{source?: 'ops'|'website'}} [opts] who asked, for the evidence log
 */
async function issue(input = {}, { source = 'ops' } = {}) {
  assertConfigured();
  const productKey = resolveProduct(input);
  const mode = paymentMode();
  const proposalNo = input.GenconProposalNumber != null ? String(input.GenconProposalNumber).trim() : '';

  // Everything that can be checked locally is checked before the claim, so a
  // bad request never leaves a row behind.
  const body = buildPolicyGenerationBody({
    product: productKey,
    mode,
    genconProposalNumber: proposalNo,
    amount: input.Amount,
    paymentReference: input.paymentReference,
  });

  // Fails closed: if the claim cannot be written (database down), nothing is
  // sent — there would be neither a guard against a second send nor evidence.
  const { store } = deps;
  const claim = await store.claimForPolicyGeneration({
    genconProposalNumber: proposalNo, product: productKey, paymentMode: mode, amount: Number(input.Amount),
  });
  if (!claim.claimed) {
    const { status, error_message: why } = claim.existing || {};
    throw validationError(
      `PolicyGeneration has already been sent for proposal ${proposalNo} (status ${status}). `
      + 'It is not idempotent and is not sent again — '
      + (status === NEEDS_REVIEW
        ? 'the last outcome is unknown, so reconcile it with Chola MS first.'
        : 'see the ops screen for what happened.'),
      { field: 'GenconProposalNumber', status, errorMessage: why || null }
    );
  }

  let sent = false;
  const record = policyGenerationRecorder({
    store,
    source,
    productKey,
    paymentMode: mode,
    body,
    onSent: () => { sent = true; },
  });

  let res;
  try {
    res = await callChola({
      productKey,
      operation: 'PolicyGeneration',
      body,
      maxRetries: 0,
      timeoutMs: config.timeouts.cholaPolicyGeneration,
      onExchange: record,
    });
  } catch (error) {
    const outcome = outcomeOfError(error, sent);
    await recordOutcome(store, proposalNo, outcome);
    console.log(`[chola] PolicyGeneration (${mode}) — proposal=${proposalNo} outcome=${outcome.status}`);
    return {
      result: buildResult({ productKey, mode, proposalNo, body, outcome, error }),
      exchange: error.exchange || null,
    };
  }

  const policy = extractPolicy(res.data);
  const outcome = outcomeOfResponse(policy, mode);
  if (outcome.paymentUrl) {
    outcome.paymentUrl = publicUrl(outcome.paymentUrl);
  }
  await recordOutcome(store, proposalNo, outcome);
  console.log(
    `[chola] PolicyGeneration (${mode}) — proposal=${proposalNo} outcome=${outcome.status} `
    + `policy=${outcome.genconPolicyNumber ?? null}`
  );

  let schedule = null;
  if (outcome.status === POLICY_ISSUED) {
    schedule = await fetchSchedule(store, productKey, proposalNo, outcome.genconPolicyNumber);
  }
  return {
    result: buildResult({
      productKey, mode, proposalNo, body, outcome, policy, schedule, res,
    }),
    exchange: res.exchange,
  };
}

/**
 * PolicySchedule for a just-issued policy, and the PDF behind it if it can be
 * reached. Never changes the proposal's status: the policy is issued whether
 * or not its document can be fetched yet.
 */
async function fetchSchedule(store, productKey, proposalNo, policyNo) {
  let data;
  try {
    ({ result: { data } } = await policySchedule({ product: productKey, GenconPolicyNumber: policyNo }));
  } catch (error) {
    const pdfError = `PolicySchedule failed: ${error.message}`;
    await saveSchedule(store, proposalNo, { pdfError });
    return { ok: false, pdfStored: false, pdfError };
  }

  let pdf = null;
  let pdfError = null;
  if (!data.scheduleUrl) {
    // Chola answer HTTP 200 with both URLs empty until the document exists.
    pdfError = 'Chola returned no schedule URL (the document may not be generated yet).';
  } else {
    try {
      pdf = await deps.fetchPdf(data.scheduleUrl);
    } catch (error) {
      pdfError = `Could not download the schedule from ${hostOf(data.scheduleUrl)}: ${error.message}`;
    }
  }
  await saveSchedule(store, proposalNo, {
    scheduleUrl: data.scheduleUrl, cisUrl: data.customerInformationSheetUrl, pdf, pdfError,
  });
  return {
    ok: Boolean(pdf),
    scheduleUrl: data.scheduleUrl,
    customerInformationSheetUrl: data.customerInformationSheetUrl,
    pdfStored: Boolean(pdf),
    pdfError,
    raw: data.raw,
  };
}

async function recordOutcome(store, proposalNo, outcome) {
  try {
    await store.recordOutcome(proposalNo, outcome);
  } catch (error) {
    // The call to Chola has already happened; losing this write must not hide
    // its outcome from whoever made it.
    console.error(
      `❌ [chola] could not record PolicyGeneration outcome for ${proposalNo}: ${error.message}`,
      JSON.stringify(outcome)
    );
  }
}

async function saveSchedule(store, proposalNo, schedule) {
  try {
    await store.recordSchedule(proposalNo, schedule);
  } catch (error) {
    console.error(`❌ [chola] could not store the schedule for ${proposalNo}: ${error.message}`);
  }
}

function buildResult({
  productKey, mode, proposalNo, body, outcome, policy = null, schedule = null, res = null, error = null,
}) {
  return {
    ok: true,
    provider: CHOLA_PROVIDER,
    operation: 'PolicyGeneration',
    product: productKey,
    data: {
      paymentMode: mode,
      genconProposalNumber: proposalNo,
      status: outcome.status,
      genconPolicyNumber: outcome.genconPolicyNumber || null,
      paymentUrl: outcome.paymentUrl || null,
      message: outcome.errorMessage || null,
      request: body,
      response: policy ? policy.raw : null,
      error: error ? { code: error.code || null, message: error.message, details: error.details || null } : null,
      schedule,
    },
    meta: { httpStatus: res?.status ?? null, correlationId: res?.correlationId ?? null },
  };
}

// ── Ops reads ───────────────────────────────────────────────────────────────

async function listProposals({ limit } = {}) {
  const rows = await deps.store.listProposals({ limit });
  return { ok: true, provider: CHOLA_PROVIDER, data: rows };
}

async function listPolicyGenerationLogs({ genconProposalNumber, limit } = {}) {
  const rows = await deps.store.listPolicyGenerationLogs({ genconProposalNumber, limit });
  return { ok: true, provider: CHOLA_PROVIDER, data: rows };
}

/** GET the schedule document; resolves only for something that is a PDF. */
async function downloadPdf(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer', timeout: 20000, validateStatus: () => true, maxRedirects: 3,
  });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(res.data);
  if (buf.subarray(0, 4).toString('latin1') !== '%PDF') {
    throw new Error(`not a PDF (content-type ${res.headers['content-type'] || 'unknown'})`);
  }
  return buf;
}

export {
  issuePolicy,
  issue,
  paymentMode,
  policyGenerationRecorder,
  listProposals,
  listPolicyGenerationLogs,
  cholaStore,
  setCholaIssuerDependencies,
};
