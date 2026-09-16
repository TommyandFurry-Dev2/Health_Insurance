// ─────────────────────────────────────────────────────────────────────────────
// ICICI Lombard — "Elevate" Health constants.
//
// Verified from IL's API kits ("Elevate_Fresh_API_Kit_V3", "CKYC_API_Kit_V2",
// "AccessToken_and_EncryptedKey") and carried over unchanged from the working
// NovaCred implementation (src/providers/elevate/constants.js there).
//
// Nothing here is environment-dependent: no host, no login, no key. The request
// PATHS moved to config (defaults.js ICICI_DEFAULTS.paths, overridable by
// EL_*_PATH) the same way ITGI's and FG's did; ICICI_OPERATIONS below names
// which config path and HTTP method each operation uses.
//
// Auth: POST {base}{paths.token} with { Login, Password(AES-encrypted) } returns
// a JWT `token` (Bearer, ~15-20 min) + `encKey` (RSA public key). Every business
// call is plain JSON with `Authorization: Bearer <token>`.
// ─────────────────────────────────────────────────────────────────────────────

// Business operations → { pathKey, method }. `pathKey` resolves against
// config.icici.paths — see services/iciciApi.service.js's endpointFor(). COI's
// {clientname}/{transactionId} are interpolated per call.
const ICICI_OPERATIONS = {
  premium: { pathKey: 'premium', method: 'POST' },
  proposal: { pathKey: 'proposal', method: 'POST' },
  policySync: { pathKey: 'policySync', method: 'POST' },
  policyStatus: { pathKey: 'policyStatus', method: 'POST' },
  emiDue: { pathKey: 'emiDue', method: 'POST' },
  emiProcess: { pathKey: 'emiProcess', method: 'POST' },
  coi: { pathKey: 'coi', method: 'GET' },
  zone: { pathKey: 'zone', method: 'POST' },
  ckyc: { pathKey: 'ckyc', method: 'POST' },
  ovdInitiate: { pathKey: 'ovdInitiate', method: 'POST' },
};

// The provider key the working implementation stamped on every response and
// error envelope. Kept verbatim: the SPA's ICICI pages were written against
// those envelopes (see controllers/icici.controller.js).
const ICICI_PROVIDER = 'elevate';

// api_transactions.api_name for each ICICI call. Prefixed so one query separates
// insurers in a table they all write to.
const ICICI_API_NAMES = {
  QUOTE: 'ICICI_PREMIUM',
  PROPOSAL: 'ICICI_PROPOSAL',
  POLICY_SYNC: 'ICICI_POLICY_SYNC',
  POLICY_STATUS: 'ICICI_POLICY_STATUS',
  EMI_DUE: 'ICICI_EMI_DUE',
  EMI_PROCESS: 'ICICI_EMI_PROCESS',
  COI: 'ICICI_COI',
  ZONE: 'ICICI_ZONE',
  CKYC: 'ICICI_CKYC',
  OVD_INITIATE: 'ICICI_OVD_INITIATE',
};

// Product codes (from Premium spec: ProductCode field).
const PRODUCT_CODES = {
  ELEVATE_HEALTH: 18,
  ACTIVATE_BOOSTER: 19,
};

// PaymentOption (Premium spec).
const PAYMENT_OPTION = { ANNUAL: 0, MONTHLY: 1, QUARTERLY: 3 };

// RoomModifier (Premium spec).
const ROOM_MODIFIER = { SINGLE_PRIVATE: 1, DOUBLE_OCCUPANCY: 2, NO_LIMIT: 3 };

// Policy status master (from "Status Master" sheet).
const STATUS_MASTER = {
  NCN: 'Rejected',
  NC: 'Policy generated',
  ACDC: 'Cancelled',
  NCCN: 'Proposal generated',
  CUWP: 'Counter offer',
  NPA: 'Pending for approval',
  NPMR: 'Pending for medical reports',
};

// Porting reasons (from "Porting Master" sheet) — used when IsPorting = true.
const PORTING_REASONS = {
  111: 'Service problem',
  112: 'Price is better',
  113: 'Product is not suitable',
  114: 'Dissatisfied with existing insurer',
  115: 'Claim not handled properly',
  116: 'Policy servicing by current insurer is not good',
  117: 'Premium rates with existing insurer is high or costly',
};

// Common add-on short codes (from "AddOns" / "AddOns Type" sheets). Not
// exhaustive — the Masters Data workbook is the source of truth.
const ADDON_CODES = [
  'CI', 'MA', 'VAC', 'NB', 'AHC', 'DAA', 'DAB', 'NH', 'SCA', 'DMEC', 'CB', 'JS',
  'SIWP', 'ROMO', 'WCWP', 'PA', 'SCADD',
];

// OVD proof types (CKYC kit). The two lists differ: identity accepts PAN and
// spells the voter card VOTERID, address rejects PAN and spells it VOTER.
const OVD_IDENTITY_PROOF_TYPES = ['AADHAAR', 'PAN', 'VOTERID', 'PASSPORT', 'DL'];
const OVD_ADDRESS_PROOF_TYPES = ['AADHAAR', 'VOTER', 'PASSPORT', 'DL'];
// Union of both, kept for callers that imported the single list this used to be.
const OVD_PROOF_TYPES = [...new Set([...OVD_IDENTITY_PROOF_TYPES, ...OVD_ADDRESS_PROOF_TYPES])];

export {
  ICICI_OPERATIONS,
  ICICI_PROVIDER,
  ICICI_API_NAMES,
  PRODUCT_CODES,
  PAYMENT_OPTION,
  ROOM_MODIFIER,
  STATUS_MASTER,
  PORTING_REASONS,
  ADDON_CODES,
  OVD_PROOF_TYPES,
  OVD_IDENTITY_PROOF_TYPES,
  OVD_ADDRESS_PROOF_TYPES,
};
