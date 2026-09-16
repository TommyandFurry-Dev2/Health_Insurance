import { callIcici } from './iciciApi.service.js';
import { requireFields, validationError } from '../helpers/icici.helper.js';
import { ICICI_PROVIDER, OVD_IDENTITY_PROOF_TYPES, OVD_ADDRESS_PROOF_TYPES } from '../constants/icici.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard CKYC + OVD (from CKYC_API_Kit_V2) — the working implementation's
// ElevateCkycService, unchanged in behaviour.
//
//   CKYC : POST {EL_CKYC_PATH}
//          one of PanNumber | CkycNumber | AadhaarNumber (+NameAsPerAadhaar,
//          Gender when Aadhaar). DateOfBirth is dd-MMM-yyyy.
//   OVD  : POST {EL_OVD_INITIATE_PATH}
//          multipart upload of identity + address proofs.
//
// ⚠️ CKYC IS A HARD GATE on ICICI's side: proposal-payment answers
// `458 KYC PENDING` until a CKYC has resolved against the quote's
// TransactionId (bnc_…). That is why `transactionId` is mandatory here, and why
// it must be ICICI's own id from the premium response. The response's `KycID`
// (kyc_…) is what a proposal sends back as `KYCRefNo`.
//
// Like the working implementation, neither operation pre-checks configuration:
// callIcici refuses an unset EL_BASE_URL, and the token call an unset login.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} input { transactionId, dateOfBirth, panNumber?, ckycNumber?,
 *                          aadhaarNumber?, nameAsPerAadhaar?, gender? }
 */
async function ckyc(input) {
  requireFields(input, ['transactionId', 'dateOfBirth'], 'Elevate CKYC');
  if (!input.panNumber && !input.ckycNumber && !input.aadhaarNumber) {
    throw validationError('Elevate CKYC needs one of panNumber, ckycNumber or aadhaarNumber', {
      field: 'panNumber|ckycNumber|aadhaarNumber',
    });
  }
  if (input.aadhaarNumber && (!input.nameAsPerAadhaar || !input.gender)) {
    throw validationError('nameAsPerAadhaar and gender are mandatory when aadhaarNumber is passed', {
      field: 'nameAsPerAadhaar|gender',
    });
  }
  const body = {
    TransactionId: input.transactionId,
    DateOfBirth: input.dateOfBirth,
    PanNumber: input.panNumber ?? null,
    CkycNumber: input.ckycNumber ?? null,
    AadhaarNumber: input.aadhaarNumber ?? null,
    NameAsPerAadhaar: input.nameAsPerAadhaar ?? null,
    Gender: input.gender ?? null,
  };

  let res;
  try {
    res = await callIcici({ operation: 'ckyc', body, context: { transactionId: input.transactionId } });
  } catch (err) {
    // A CKYC that resolves to "not verified" is a normal outcome, not a
    // transport failure: the customer is expected to try another document.
    // ICICI signal it with Success:false, which the client raises — so it is
    // turned back into a result here, carrying their own wording so the
    // customer sees "retry with alternate KYC options" rather than a generic
    // "could not process this request".
    const d = err && err.details;
    if (err && err.code === 'UPSTREAM_ERROR' && d && (d.displayMessage || d.statusCode)) {
      console.log(
        `[icici] CKYC not verified — transactionId=${input.transactionId} `
        + `statusCode=${d.statusCode ?? null} ovdLink=${d.ovdLink ? 'offered' : 'none'}`
      );
      return {
        result: {
          ok: true,
          provider: ICICI_PROVIDER,
          operation: 'ckyc',
          data: {
            isKycSuccess: false,
            displayMessage: d.displayMessage ?? null,
            statusCode: d.statusCode ?? null,
            // ICICI's own document-upload fallback, when they offer one.
            ovdLink: d.ovdLink ?? null,
            name: null, dob: null, emailId: null, phoneNo: null, gender: null,
            permanentAddress: null, correspondenceAddress: null,
          },
          meta: { corelationId: d.corelationId, statusCode: d.statusCode },
        },
        exchange: err.exchange || null,
      };
    }
    throw err;
  }

  const d = res.data;
  console.log(
    `[icici] CKYC parsed — transactionId=${input.transactionId} isKycSuccess=${Boolean(d.isKycSuccess)} `
    + `kycId=${d.KycID ?? null} statusCode=${d.StatusCode ?? null}`
  );
  return {
    result: {
      ok: true,
      provider: ICICI_PROVIDER,
      operation: 'ckyc',
      data: {
        isKycSuccess: !!d.isKycSuccess,
        // ICICI's own KYC identifier for this verification.
        kycId: d.KycID ?? null,
        displayMessage: d.DisplayMessage ?? null,
        statusCode: d.StatusCode ?? null,
        ovdLink: d.OVDLink ?? null,
        name: d.Name ?? null,
        dob: d.DOB ?? null,
        emailId: d.EmailId ?? null,
        phoneNo: d.PhoneNo ?? null,
        gender: d.Gender ?? null,
        permanentAddress: d.PermanentAddress ?? null,
        correspondenceAddress: d.CorrespondenceAddress ?? null,
        raw: d,
      },
      meta: { corelationId: d.CorelationId, statusCode: d.StatusCode },
    },
    exchange: res.exchange,
  };
}

/**
 * OVD initiate (multipart). Pass file buffers/streams for the two proofs.
 * @param {object} input { quoteTransactionId, proofOfIdentityType, proofOfAddressType,
 *                          proofOfIdentity: {value, options}, proofOfAddress: {value, options} }
 * NOTE: requires the `form-data` package for multipart bodies. It is not
 * declared by this service — it is resolved from axios's own dependency tree,
 * exactly as the working implementation resolved it.
 */
async function ovdInitiate(input) {
  requireFields(input, ['quoteTransactionId', 'proofOfIdentityType', 'proofOfAddressType'], 'Elevate OVD');
  // The kit lists a different set for each: identity allows PAN and calls the
  // voter card VOTERID; address drops PAN and calls it VOTER.
  const allowed = [
    ['proofOfIdentityType', input.proofOfIdentityType, OVD_IDENTITY_PROOF_TYPES],
    ['proofOfAddressType', input.proofOfAddressType, OVD_ADDRESS_PROOF_TYPES],
  ];
  for (const [field, type, types] of allowed) {
    if (!types.includes(String(type).toUpperCase())) {
      throw validationError(`${field} must be one of ${types.join(', ')}`, { field });
    }
  }

  let FormData;
  try {
    ({ default: FormData } = await import('form-data'));
  } catch {
    throw validationError('OVD upload requires the optional "form-data" package (npm i form-data)', {
      field: 'ovd',
    });
  }
  const form = new FormData();
  form.append('quoteTransactionId', input.quoteTransactionId);
  form.append('ProofOfIdentityType', input.proofOfIdentityType);
  form.append('ProofOfAddressType', input.proofOfAddressType);
  form.append('ProofOfIdentify', input.proofOfIdentity.value, input.proofOfIdentity.options);
  form.append('ProofOfAddress', input.proofOfAddress.value, input.proofOfAddress.options);

  const res = await callIcici({
    operation: 'ovdInitiate',
    body: form,
    headers: form.getHeaders(),
    context: { transactionId: input.quoteTransactionId },
  });
  const d = res.data;
  console.log(
    `[icici] OVD initiate parsed — transactionId=${input.quoteTransactionId} `
    + `isKycSuccess=${Boolean(d.isKycSuccess)} errorCode=${d.ErrorCode ?? null}`
  );
  return {
    result: {
      ok: true,
      provider: ICICI_PROVIDER,
      operation: 'ovdInitiate',
      data: { isKycSuccess: !!d.isKycSuccess, customerName: d.CustomerName ?? null, raw: d },
      meta: { errorCode: d.ErrorCode },
    },
    exchange: res.exchange,
  };
}

export { ckyc, ovdInitiate };
