import { callIcici } from './iciciApi.service.js';
import { requireFields, validationError, isEmpty } from '../helpers/icici.helper.js';
import { ICICI_PROVIDER, OVD_IDENTITY_PROOF_TYPES, OVD_ADDRESS_PROOF_TYPES } from '../constants/icici.constants.js';

// CKYC kit: "Gender- M, F (Gender is mandatory in case of AadhaarNumber is
// passed)". The premium and proposal APIs take the WORD ("Male"/"Female"), so a
// caller holding the proposal's value is mapped here rather than having ICICI
// decline an Aadhaar CKYC over the spelling.
const CKYC_GENDER = { M: 'M', F: 'F', MALE: 'M', FEMALE: 'F' };

function ckycGender(value) {
  if (isEmpty(value)) return null;
  return CKYC_GENDER[String(value).trim().toUpperCase()] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard CKYC + OVD (from CKYC_API_Kit_V2) — ported from the working
// implementation's ElevateCkycService, with three kit-driven changes: Gender is
// sent as the kit's M/F, OVD proofs may arrive as base64 JSON from the SPA, and
// declined OVD documents are an outcome rather than a 502.
//
//   CKYC : POST {EL_CKYC_PATH}
//          one of PanNumber | CkycNumber | AadhaarNumber (+NameAsPerAadhaar,
//          Gender M/F when Aadhaar). DateOfBirth is dd-MMM-yyyy.
//   OVD  : POST {EL_OVD_INITIATE_PATH}
//          multipart upload of identity + address proofs — ICICI's fallback
//          when CKYC cannot resolve the customer.
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
  const gender = ckycGender(input.gender);
  if (input.aadhaarNumber && !gender) {
    throw validationError('gender must be M or F (Male/Female also accepted) when aadhaarNumber is passed', {
      field: 'gender',
    });
  }
  const body = {
    TransactionId: input.transactionId,
    DateOfBirth: input.dateOfBirth,
    PanNumber: input.panNumber ?? null,
    CkycNumber: input.ckycNumber ?? null,
    AadhaarNumber: input.aadhaarNumber ?? null,
    NameAsPerAadhaar: input.nameAsPerAadhaar ?? null,
    Gender: gender,
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
 * One proof as a form-data part.
 *
 * A browser cannot put a Buffer in a JSON body, so the SPA sends each proof as
 * `{ base64, filename, contentType }` (the same base64-in-JSON the ITGI CKYC
 * create route takes) and it is decoded here. `{ value, options }` — a Buffer
 * or stream plus form-data options — is still accepted for server-side callers.
 */
function ovdFilePart(doc, field) {
  if (doc && !isEmpty(doc.base64)) {
    const value = Buffer.from(String(doc.base64).replace(/^data:[^,]*,/, ''), 'base64');
    if (!value.length) throw validationError(`${field} is empty`, { field });
    return {
      value,
      options: { filename: doc.filename || field, contentType: doc.contentType || 'application/octet-stream' },
    };
  }
  if (doc && doc.value != null) return { value: doc.value, options: doc.options };
  throw validationError(`${field} is required`, { field });
}

/**
 * OVD initiate (multipart).
 * @param {object} input { quoteTransactionId, proofOfIdentityType, proofOfAddressType,
 *                          proofOfIdentity, proofOfAddress } — each proof either
 *                          { base64, filename, contentType } or { value, options }
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
  const proofOfIdentity = ovdFilePart(input.proofOfIdentity, 'proofOfIdentity');
  const proofOfAddress = ovdFilePart(input.proofOfAddress, 'proofOfAddress');

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
  // `ProofOfIdentify` — sic, the kit's own spelling of the field.
  form.append('ProofOfIdentify', proofOfIdentity.value, proofOfIdentity.options);
  form.append('ProofOfAddress', proofOfAddress.value, proofOfAddress.options);

  let res;
  try {
    res = await callIcici({
      operation: 'ovdInitiate',
      body: form,
      headers: form.getHeaders(),
      context: { transactionId: input.quoteTransactionId },
    });
  } catch (err) {
    // Documents ICICI decline are an outcome, exactly as a declined CKYC is:
    // the customer can upload clearer or different ones. Only the Success:false
    // branch of callIcici builds details WITHOUT an httpStatus — a non-2xx or a
    // transport failure still propagates as the failure it is.
    const d = err && err.details;
    if (err && err.code === 'UPSTREAM_ERROR' && d && !('httpStatus' in d)) {
      const errorMessage = d.errorMessage || d.displayMessage || null;
      console.log(
        `[icici] OVD not verified — transactionId=${input.quoteTransactionId} `
        + `errorCode=${d.errorCode ?? null} message=${errorMessage ?? 'none'}`
      );
      return {
        result: {
          ok: true,
          provider: ICICI_PROVIDER,
          operation: 'ovdInitiate',
          data: { isKycSuccess: false, customerName: null, errorMessage },
          meta: { errorCode: d.errorCode ?? null },
        },
        exchange: err.exchange || null,
      };
    }
    throw err;
  }
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
      data: {
        isKycSuccess: !!d.isKycSuccess,
        customerName: d.CustomerName ?? null,
        errorMessage: d.ErrorMessage ?? null,
        raw: d,
      },
      meta: { errorCode: d.ErrorCode },
    },
    exchange: res.exchange,
  };
}

export { ckyc, ovdInitiate };
