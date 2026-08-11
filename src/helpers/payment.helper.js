import {
  PAYMENT_QUERYSTRING_FIELDS,
  PAYMENT_MANDATORY_FIELDS,
  PAYMENT_SUCCESS_CODE,
} from '../constants/payment.constants.js';

function normalizeField(value) {
  return value !== undefined && value !== null ? value : '';
}

function findMissingMandatoryFields(body) {
  return PAYMENT_MANDATORY_FIELDS.filter((field) => !body[field]);
}

// "field=value" pairs, pipe-separated, EVERY field in
// PAYMENT_QUERYSTRING_FIELDS always present in this exact order — never
// omitted, blank ('') when not supplied. Previously optional/absent
// fields were filtered out entirely; changed per the API spec's own
// wording for policynumber ("Mandatory in case of Renewal Only
// otherwise blank" — "blank" meaning present-but-empty, not absent),
// which implies the gateway expects a complete, fixed-length field set
// on every request, not a variable-length one.
function buildPaymentQuerystring(body) {
  return PAYMENT_QUERYSTRING_FIELDS
    .map((field) => `${field}=${normalizeField(body[field])}`)
    .join('|');
}

function logPaymentPlaintext(body, querystring) {
  console.log('\n📤 NivaBupa payment/initiate — plaintext before encryption:');
  for (const field of PAYMENT_QUERYSTRING_FIELDS) {
    console.log(`   ${field} = ${JSON.stringify(normalizeField(body[field]))}`);
  }
  console.log('   Full plaintext:', querystring);
}

// Field order is fixed by NivaBupa's documented returnMessage format.
function parseReturnMessage(decrypted) {
  const fields = decrypted.split('|');

  return {
    source: fields[0],
    uniqueReferenceId: fields[1],       // policy number
    payablePremium: fields[2],          // amount
    transactionDateTime: fields[3],
    uniqueReferenceNoRepeat: fields[4],
    paymentTransactionId: fields[5],    // transaction id
    paymentStatus: fields[6],
    paymentStatusDescription: fields[6] === PAYMENT_SUCCESS_CODE ? 'SUCCESS' : 'FAILED_OR_OTHER',
    failedReason: fields[7],            // error message, if any
    standingInstructionTaken: fields[8],
    standingInstructionNo: fields[9],
    paymentGatewayUsed: fields[10]
  };
}

// User-facing message only — kept generic on purpose so we never put a raw
// axios/SOAP exception string in a redirect URL the buyer's browser carries
// around. The real exception (message, response body, stack) always goes to
// the server log, which is where debugging happens.
function buildSafeCallbackErrorMessage(error) {
  if (error.soapStatus || error.response) {
    return 'We could not confirm your payment status with Niva Bupa right now. If an amount was debited, please contact support with your payment reference.';
  }
  return 'We could not process your payment confirmation right now. If an amount was debited, please contact support.';
}

export {
  findMissingMandatoryFields,
  buildPaymentQuerystring,
  logPaymentPlaintext,
  parseReturnMessage,
  buildSafeCallbackErrorMessage,
};
