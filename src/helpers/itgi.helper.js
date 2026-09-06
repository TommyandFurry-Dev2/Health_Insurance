import config from '../config/env.js';
import {
  CONTRACT_TYPE,
  MEDICAL_QUESTIONS,
  PAYMENT_RESPONSE_FIELDS,
  PAYMENT_RESPONSE_PARAM,
  PAYMENT_RESULT,
  PAYMENT_RESULT_MESSAGES,
  CKYC_STATUS,
  CKYC_UNUSABLE_STATUSES,
} from '../constants/itgi.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Shaping the ITGI request and reading the ITGI response.
//
// Validation lives next door in itgiValidation.helper.js; this file is the
// small set of transformations either side of the wire:
//   * prepareRequest      — contractType + partnerDetail.partnerCode defaults
//   * fillMedicalQuestionText — works around an ITGI NPE (see below)
//   * extractPremium / extractProposal — normalise their envelopes
//   * parsePaymentResponse — read the pipe-delimited gateway redirect
//
// Nothing here reads process.env: config.itgi.partnerCode is the only
// environment value it touches, and it arrives through config/env.js like
// everything else.
// ─────────────────────────────────────────────────────────────────────────────

// The current codebase's convention for a typed failure is an Error with extra
// properties (see genericApi.service.js's 429 wrapper and payment.controller's
// `noResponse`), not a class hierarchy — so that is what this is.
//
//   status  — the HTTP status the controller answers with
//   code    — machine-readable, stable across message rewording
//   field   — the offending request field, when there is one
//   details — anything the caller needs to act (ITGI's own error array)
function itgiError(message, { status = 502, code = 'ITGI_ERROR', field = null, details = null } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.provider = 'itgi';
  if (field) error.field = field;
  if (details) error.details = details;
  return error;
}

function validationError(message, field = null, details = null) {
  return itgiError(message, { status: 400, code: 'ITGI_VALIDATION_ERROR', field, details });
}

function isBlank(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

// ── Request ─────────────────────────────────────────────────────────────────

/**
 * Apply the two values every ITGI request carries and no caller should have to
 * supply: the contract type and our partner code.
 *
 * partnerCode is deliberately taken from config rather than from the request
 * body by default — it identifies THIS deployment to ITGI (and is the key they
 * hold our payment response URL against), so a browser must not be able to
 * choose it. An explicit partnerDetail.partnerCode in the body still wins,
 * because the operations team need that to test a second partner code without
 * a redeploy; nothing a public caller sends reaches this path unauthenticated
 * that could not equally be sent with a different insurer's payload.
 *
 * Never mutates the caller's object.
 */
function prepareRequest(input = {}) {
  const contractType = input.contractType || config.itgi.defaultContractType;
  if (!CONTRACT_TYPE[contractType]) {
    throw validationError(
      `Unknown ITGI contractType "${contractType}" — expected ${Object.keys(CONTRACT_TYPE).join(' or ')}`,
      'contractType'
    );
  }

  const partnerDetail = {
    partnerCode: config.itgi.partnerCode,
    ...(input.partnerDetail || {}),
  };
  if (isBlank(partnerDetail.partnerCode)) {
    throw validationError(
      'ITGI partnerDetail.partnerCode is required — set ITGI_PARTNER_CODE',
      'partnerDetail.partnerCode'
    );
  }

  return { ...input, contractType, partnerDetail };
}

/**
 * Put the question TEXT back on every medicalHistoryQuestions entry.
 *
 * ITGI dereference `question` while deserializing the proposal, so an entry
 * carrying only `{ qid, answer }` — the shape the field dictionary describes,
 * and the natural one to send — takes the whole proposal down with the generic
 * `errorField: "runtime"` technical fault, which names nothing and points at no
 * field. It reads exactly like the missing-itgiKYCReferenceNo fault, so it
 * sends you looking at KYC.
 *
 * Isolated on staging 2026-08-24 against otherwise byte-identical payloads,
 * three runs each: present and non-null passes, absent or null fails. The text
 * is not itself validated — "" and arbitrary text both pass — so this is their
 * NPE, not a rule. MEDICAL_QUESTIONS already holds the kit's exact wording, so
 * the real sentence goes rather than a filler.
 *
 * Only ever fills a gap: a caller's own text is left exactly as it came.
 */
function fillMedicalQuestionText(body) {
  const members = body?.health?.individualMembers;
  if (!Array.isArray(members)) return body;

  const text = new Map(MEDICAL_QUESTIONS.map((q) => [q.qid, q.question]));

  return {
    ...body,
    health: {
      ...body.health,
      individualMembers: members.map((member) => {
        if (!member || !Array.isArray(member.medicalHistoryQuestions)) return member;
        return {
          ...member,
          medicalHistoryQuestions: member.medicalHistoryQuestions.map((answer) => (
            answer && (answer.question === undefined || answer.question === null)
              ? { ...answer, question: text.get(answer.qid) ?? '' }
              : answer
          )),
        };
      }),
    },
  };
}

// ── Response ────────────────────────────────────────────────────────────────

/**
 * Premium: { premiumDiscount, basePremium, grossPremiumAfterDiscount,
 * serviceTax, premiumPayble, error[] }.
 *
 * Note ITGI's spelling — `premiumPayble` on the way back, and the proposal
 * expects `health.premiumPayble` on the way in. Normalised to premiumPayable
 * here for the caller while `raw` keeps the original envelope untouched.
 */
function extractPremium(data) {
  const d = data || {};
  return {
    basePremium: num(d.basePremium),
    premiumDiscount: num(d.premiumDiscount),
    grossPremiumAfterDiscount: num(d.grossPremiumAfterDiscount),
    serviceTax: num(d.serviceTax),
    premiumPayable: num(d.premiumPayble ?? d.premiumPayable),
    errors: Array.isArray(d.error) ? d.error : [],
    raw: d,
  };
}

/**
 * Proposal: orderNo + itgiPaymentUrl + the trace/log ids the gateway form needs.
 *
 * `paymentUrl` prefers ITGI's own itgiPaymentUrl and falls back to the
 * configured gateway URL, so a proposal response that omits it (or an operator
 * pointing at a different gateway host) still yields a usable form.
 */
function extractProposal(data) {
  const d = data || {};
  return {
    uniqueReferenceNo: d.uniqueReferenceNo ?? null,
    ptnrTransactionLogId: d.ptnrTransactionLogId ?? null,
    orderNo: d.orderNo ?? null,
    traceNo: d.traceNo ?? null,
    contractType: d.contractType ?? null,
    siebelRowId: d.siebelRowId ?? null,
    paymentUrl: d.itgiPaymentUrl ?? paymentGatewayUrl(),
    statusMessage: d.statusMessage ?? null,
    premiumPayable: num(d.premiumPayable ?? d.premiumPayble),
    // The hidden fields the browser POSTs to paymentUrl.
    paymentFormFields: {
      ptnrTransactionLogId: d.ptnrTransactionLogId ?? null,
      orderNo: d.orderNo ?? null,
      traceNo: d.traceNo ?? null,
    },
    raw: d,
  };
}

/** Policy download: ITGI answer with a link to their DMS, not the PDF bytes. */
function extractPolicyDownload(data) {
  const d = data || {};
  return {
    uniqueReferenceNo: d.uniqueReferenceNo ?? null,
    statusMessage: d.statusMessage ?? null,
    // ⚠️ A SUCCESS here is not proof of a retrievable document: policy H1622553
    // returned SUCCESS with a link that served "Policy is not active." for 20
    // minutes (2026-08-26), while a byte-identical re-run issued a policy whose
    // PDF served immediately. Fetch the link before telling a buyer it is ready.
    policyDownloadLink: d.policyDownloadLink ?? null,
    raw: d,
  };
}

// ── Hosted payment gateway ──────────────────────────────────────────────────

/**
 * Where the buyer's browser is POSTed to pay.
 *
 * Config first (ITGI_PAYMENT_GATEWAY_URL), otherwise derived from the same base
 * URL and path every other ITGI call uses — so it moves between environments
 * with ITGI_BASE_URL and never appears as a literal anywhere.
 */
function paymentGatewayUrl() {
  if (config.itgi.paymentGatewayUrl) return config.itgi.paymentGatewayUrl;
  if (!config.itgi.baseUrl) return null;
  return `${config.itgi.baseUrl}${config.itgi.paths.paymentInitiate}`;
}

/**
 * Build the auto-submitting form the SPA needs to hand the buyer to ITGI.
 *
 * Payment is a browser round trip, not an API call: there is nothing to sign,
 * encrypt or call here — the three ids from the proposal response are posted as
 * hidden fields and ITGI take it from there.
 */
function buildPaymentForm({ orderNo, traceNo, ptnrTransactionLogId, paymentUrl } = {}) {
  const missing = [];
  if (isBlank(orderNo)) missing.push('orderNo');
  if (isBlank(traceNo)) missing.push('traceNo');
  if (isBlank(ptnrTransactionLogId)) missing.push('ptnrTransactionLogId');
  if (missing.length > 0) {
    throw validationError(
      `Missing payment field(s): ${missing.join(', ')} — all three come from the proposal response`,
      missing[0]
    );
  }

  const url = paymentUrl || paymentGatewayUrl();
  if (!url) {
    throw itgiError(
      'ITGI payment gateway URL is not configured — set ITGI_BASE_URL (or ITGI_PAYMENT_GATEWAY_URL)',
      { status: 503, code: 'ITGI_CONFIG_ERROR' }
    );
  }

  return {
    method: 'POST',
    gatewayUrl: url,
    // Names are ITGI's, and the browser must post them exactly.
    fields: {
      ptnrTransactionLogId: String(ptnrTransactionLogId),
      orderNo: String(orderNo),
      traceNo: String(traceNo),
    },
  };
}

/**
 * Read the redirect ITGI send the buyer back on.
 *
 *   {responseUrl}?ITGIResponse=product|orderNo|traceNo|policyNo|premium|message
 *
 * This is the ONLY channel by which a policy number reaches us — partner-end
 * payment confirmation is disabled for our partner code, so ITGI issue the
 * policy themselves and the number exists nowhere else in our flow. Six live
 * UAT payments on 2026-08-26 landed on a host with no handler for this URL and
 * every policy number was lost; that is what this parser and the route behind
 * it exist to stop.
 *
 * Accepts the value from the query string or a form body, and tolerates a
 * missing field rather than throwing: a truncated redirect still carries the
 * policy number more often than not, and losing it is the expensive outcome.
 */
function parsePaymentResponse(source = {}) {
  const raw = source[PAYMENT_RESPONSE_PARAM]
    // Case-insensitive fallback: this arrives from a browser redirect, and the
    // parameter name is only ever seen in ITGI's documentation and their live
    // redirects — both 'ITGIResponse', but nothing here depends on that holding.
    ?? Object.entries(source).find(([key]) => key.toLowerCase() === PAYMENT_RESPONSE_PARAM.toLowerCase())?.[1]
    ?? null;

  if (isBlank(raw)) {
    return { present: false, raw: null, message: null, policyNo: null, orderNo: null };
  }

  const parts = String(raw).split('|');
  const parsed = { present: true, raw: String(raw) };
  PAYMENT_RESPONSE_FIELDS.forEach((field, index) => {
    const value = parts[index];
    parsed[field] = isBlank(value) ? null : String(value).trim();
  });

  const message = (parsed.message || '').toUpperCase();
  parsed.message = message || null;
  parsed.succeeded = message === PAYMENT_RESULT.SUCCESS;
  // ITGI's own sentence for the outcome — the only text worth showing a buyer
  // who did not get a policy.
  parsed.description = PAYMENT_RESULT_MESSAGES[message] || null;
  parsed.premiumPayable = num(parsed.premiumPayable);

  return parsed;
}

// ── CKYC envelopes ──────────────────────────────────────────────────────────

/**
 * Normalise a CKYC SEARCH response, `{ status, result: { … } }`.
 *
 * `verified` is true only when the record carried an IURN — a status without a
 * reference cannot produce a proposal, so it is not a success however it is
 * labelled.
 *
 * This was an allow-list of SUCCESS / EXISTING RECORD until 2026-08-26, when a
 * live search answered `CKYCInProgress` — a value in no ITGI kit — carrying a
 * perfectly good reference. The allow-list reported verified:false, the caller
 * discarded the reference, and the customer was pushed to create a second CKYC
 * record they already had; the same proposal then went through on that very
 * reference. So the vocabulary is open and a label allow-list will keep failing
 * this way. A deny-list of the three no-reference states cannot: any new label
 * arrives carrying an IURN or it does not.
 */
function ckycSearchEnvelope(data) {
  const result = data?.result || {};
  const status = String(result.status ?? '').trim();
  const iurn = String(result.itgiUniqueReferenceId ?? '').trim() || null;
  const usable = !CKYC_UNUSABLE_STATUSES.includes(status);

  return {
    status,
    verified: usable && Boolean(iurn),
    // The value a proposal sends as itgiKYCReferenceNo.
    itgiUniqueReferenceId: iurn,
    requiresOtp: status === CKYC_STATUS.OTP_PENDING,
    noRecord: status === CKYC_STATUS.NO_RECORD,
    invalidRequest: status === CKYC_STATUS.INVALID_REQUEST,
    remarks: result.ckycRemarks ?? null,
    raw: data ?? null,
  };
}

/**
 * Normalise a CKYC CREATE response, which does NOT answer in the search's
 * vocabulary: `result` carries recordCreated / documentStored (Y|N) and puts a
 * free-text REASON in `status` — e.g. "Provided Name doesn't match with Name
 * received from Government repository for provided PAN…" (UAT 2026-08-22).
 *
 * Running that through the search envelope matched none of the five search
 * statuses, so the caller received verified:false with every flag false and the
 * reason discarded — a refusal that looked like an empty response.
 *
 * A create that minted no IURN did not create anything, so it is raised rather
 * than returned: ITGI's own sentence becomes the error message, which is the
 * only text that tells the customer what to fix.
 */
function ckycCreateEnvelope(data) {
  const result = data?.result || {};
  const iurn = String(result.itgiUniqueReferenceId ?? '').trim() || null;
  const reason = String(result.status ?? '').trim();
  const isY = (value) => String(value ?? '').trim().toUpperCase() === 'Y';
  const recordCreated = isY(result.recordCreated);
  const documentStored = isY(result.documentStored);

  if (!iurn) {
    throw itgiError(reason || 'ITGI CKYC create returned no reference and no reason', {
      status: 502,
      code: 'ITGI_CKYC_NOT_CREATED',
      details: { reason: reason || null, recordCreated, documentStored, result },
    });
  }

  return {
    status: reason,
    verified: true,
    itgiUniqueReferenceId: iurn,
    recordCreated,
    documentStored,
    remarks: result.ckycRemarks ?? null,
    // Appears in no other response and in no kit. Passed through rather than
    // dropped — an AML hold is something a support desk needs to see.
    amlScreeningStatus: result.amlScreeningStatus ?? null,
    raw: data ?? null,
  };
}

export {
  itgiError,
  validationError,
  isBlank,
  num,
  prepareRequest,
  fillMedicalQuestionText,
  extractPremium,
  extractProposal,
  extractPolicyDownload,
  paymentGatewayUrl,
  buildPaymentForm,
  parsePaymentResponse,
  ckycSearchEnvelope,
  ckycCreateEnvelope,
};
