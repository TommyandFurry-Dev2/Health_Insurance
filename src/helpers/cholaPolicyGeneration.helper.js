import {
  CHOLA_POLICY_GENERATION_FIELDS, CHOLA_PAYMENT_MODES, CHOLA_PG_BANK_CODE, CHOLA_PROPOSAL_STATUS,
} from '../constants/chola.constants.js';
import { validationError } from './chola.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Chola PolicyGeneration — the pure half of backend-built issuance.
//
//   buildPolicyGenerationBody  the request body, per product and payment mode
//   outcomeOfResponse          a PolicyGeneration answer → a proposal outcome
//   outcomeOfError             a failed call → a proposal outcome
//
// Ported unchanged from the working implementation's policyGenerationBody.js
// and the outcome functions of its policyIssuer.js. No I/O lives here; the
// sending, claiming and recording is services/cholaPolicyIssuer.service.js.
// ─────────────────────────────────────────────────────────────────────────────

const { POLICY_ISSUED, PAYMENT_PENDING, PAYMENT_FAILED, NEEDS_REVIEW } = CHOLA_PROPOSAL_STATUS;

// A connection that never opened cannot have reached Chola.
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Today in Chola's dd/MM/yyyy, on the Indian calendar whatever the server's zone. */
function cholaToday(now = new Date()) {
  // en-GB formats as dd/mm/yyyy already.
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(now);
}

/** Our own reference for a PG tag, sent as PGID. Same shape the website uses. */
function newPaymentReference() {
  return `NC${Date.now().toString(36).toUpperCase()}${Math.floor(Math.random() * 1000)}`;
}

/**
 * Build a PolicyGeneration request body for `mode`.
 *
 * Field order follows the kit samples; each product's differently-spelt fields
 * come from CHOLA_POLICY_GENERATION_FIELDS. The body is exactly what is sent —
 * no `product` key, which is ours and not Chola's.
 *
 * APD carries no instrument at all: the premium comes out of NovaCred's deposit
 * with Chola, so PayMode, bank, PGID and PaymentID are all empty.
 */
function buildPolicyGenerationBody({
  product, mode, genconProposalNumber, amount, paymentReference, now,
}) {
  const fields = CHOLA_POLICY_GENERATION_FIELDS[product];
  if (!fields) {
    throw validationError(`No PolicyGeneration field map for Chola product "${product}"`, { field: 'product' });
  }
  if (!CHOLA_PAYMENT_MODES.includes(mode)) {
    throw validationError(`Unknown Chola payment mode "${mode}". Known: ${CHOLA_PAYMENT_MODES.join(', ')}`, { field: 'mode' });
  }
  if (!genconProposalNumber) {
    throw validationError('GenconProposalNumber is required', { field: 'GenconProposalNumber' });
  }
  const premium = Number(amount);
  if (!Number.isFinite(premium) || premium <= 0) {
    throw validationError(`Amount must be the premium payable incl. GST, got "${amount}"`, { field: 'Amount' });
  }

  const apd = mode === 'APD';
  let pgid = '';
  if (mode === 'PG_CHOLA') pgid = paymentReference || newPaymentReference();
  if (mode === 'PG_DIRECT') {
    // Direct asserts the premium was collected. Without our gateway's own
    // reference there is nothing to reconcile that claim against.
    if (!paymentReference) {
      throw validationError('PG_DIRECT needs the payment reference the premium was collected under', { field: 'paymentReference' });
    }
    pgid = paymentReference;
  }

  return {
    GenconProposalNumber: String(genconProposalNumber),
    TaggingMode: apd ? 'APD' : 'PG',
    PayMode: { APD: '', PG_CHOLA: 'Chola', PG_DIRECT: 'Direct' }[mode],
    [fields.chequeNumber]: '',
    ChequeOrDDDate: '',
    Amount: String(premium),
    BankName: apd ? '' : CHOLA_PG_BANK_CODE,
    BankBranch: '',
    InstrumentType: '',
    [fields.btAdviceNumber]: fields.btAdviceEmpty,
    PaymentID: '',
    PGID: pgid,
    [fields.transactionDate]: cholaToday(now),
  };
}

/** Read a PolicyGeneration answer (extractPolicy's output) into a proposal outcome. */
function outcomeOfResponse(policy, mode) {
  if (!policy.succeeded) {
    return {
      status: PAYMENT_FAILED,
      errorMessage: policy.message || `Chola answered Status "${policy.status ?? ''}" with no message.`,
    };
  }
  if (policy.genconPolicyNumber) {
    return { status: POLICY_ISSUED, genconPolicyNumber: policy.genconPolicyNumber };
  }
  if (policy.paymentUrl && mode === 'PG_CHOLA') {
    return { status: PAYMENT_PENDING, paymentUrl: policy.paymentUrl };
  }
  // "Success" and nothing to show for it. Chola may well have acted — under
  // APD, debited the deposit — so this is not a failure to try again from.
  return {
    status: NEEDS_REVIEW,
    errorMessage: `Chola answered Success but returned no PolicyNumber${mode === 'APD' ? ' (APD)' : ''}. `
      + 'Confirm with Chola MS whether a policy was issued before doing anything else.',
  };
}

/**
 * Read a failed call into a proposal outcome.
 *
 * A 4xx is Chola refusing the request — nothing was tagged, so it is a failure
 * that can be retried by a person once the cause is fixed. A timeout or a 5xx
 * leaves the outcome unknown. An error before anything was sent (the OAuth
 * token, a connection that never opened) is a failure that reached nobody.
 */
function outcomeOfError(err, sent) {
  const httpStatus = err.details?.httpStatus ?? err.details?.status ?? null;
  const code = err.cause?.code || err.details?.errorCode || null;
  if (!sent || NOT_SENT_CODES.has(code)) {
    return { status: PAYMENT_FAILED, errorMessage: `Not sent to Chola MS: ${err.message}` };
  }
  if (httpStatus && httpStatus >= 400 && httpStatus < 500) {
    return { status: PAYMENT_FAILED, errorMessage: `Chola MS refused the request (HTTP ${httpStatus}): ${err.message}` };
  }
  return {
    status: NEEDS_REVIEW,
    errorMessage: `Outcome unknown — ${err.message}. Chola MS may have processed it; `
      + 'reconcile with them before any further attempt.',
  };
}

export {
  cholaToday,
  newPaymentReference,
  buildPolicyGenerationBody,
  outcomeOfResponse,
  outcomeOfError,
};
