// The journey's step machine. Order matters: RESUME_ORDER is what
// "restore from the last completed step" is computed against, so a step's
// position here is the contract, not its name.
//
// Every step below corresponds to something this backend actually persists.
// There is no vehicle step — Reassure 3.0 is a health product whose risk data
// is member[] (see MEMBER_DETAILS), not a vehicle.
const JOURNEY_STEPS = {
  JOURNEY_STARTED: 'JOURNEY_STARTED',
  QUOTE_GENERATED: 'QUOTE_GENERATED',
  QUOTE_SELECTED: 'QUOTE_SELECTED',
  PROPOSER_DETAILS: 'PROPOSER_DETAILS',
  MEMBER_DETAILS: 'MEMBER_DETAILS',
  NOMINEE_DETAILS: 'NOMINEE_DETAILS',
  KYC_PENDING: 'KYC_PENDING',
  KYC_COMPLETED: 'KYC_COMPLETED',
  UW_DECISION: 'UW_DECISION',
  PROPOSAL_SUBMITTED: 'PROPOSAL_SUBMITTED',
  PAYMENT_INITIATED: 'PAYMENT_INITIATED',
  PAYMENT_COMPLETED: 'PAYMENT_COMPLETED',
  POLICY_ISSUED: 'POLICY_ISSUED',
  POLICY_DOWNLOADED: 'POLICY_DOWNLOADED',
  JOURNEY_COMPLETED: 'JOURNEY_COMPLETED',
};

const RESUME_ORDER = [
  JOURNEY_STEPS.JOURNEY_STARTED,
  JOURNEY_STEPS.QUOTE_GENERATED,
  JOURNEY_STEPS.QUOTE_SELECTED,
  JOURNEY_STEPS.PROPOSER_DETAILS,
  JOURNEY_STEPS.MEMBER_DETAILS,
  JOURNEY_STEPS.NOMINEE_DETAILS,
  JOURNEY_STEPS.KYC_PENDING,
  JOURNEY_STEPS.KYC_COMPLETED,
  JOURNEY_STEPS.UW_DECISION,
  JOURNEY_STEPS.PROPOSAL_SUBMITTED,
  JOURNEY_STEPS.PAYMENT_INITIATED,
  JOURNEY_STEPS.PAYMENT_COMPLETED,
  JOURNEY_STEPS.POLICY_ISSUED,
  JOURNEY_STEPS.POLICY_DOWNLOADED,
  JOURNEY_STEPS.JOURNEY_COMPLETED,
];

// Where the SPA should drop the buyer for a given last_completed_step. Kept
// here rather than in the frontend so a step added on the backend cannot
// silently resume into a route that does not exist yet.
const STEP_TO_ROUTE = {
  [JOURNEY_STEPS.JOURNEY_STARTED]: '/quote',
  [JOURNEY_STEPS.QUOTE_GENERATED]: '/quote/compare',
  [JOURNEY_STEPS.QUOTE_SELECTED]: '/proposal/proposer',
  [JOURNEY_STEPS.PROPOSER_DETAILS]: '/proposal/members',
  [JOURNEY_STEPS.MEMBER_DETAILS]: '/proposal/nominee',
  [JOURNEY_STEPS.NOMINEE_DETAILS]: '/kyc',
  [JOURNEY_STEPS.KYC_PENDING]: '/kyc',
  [JOURNEY_STEPS.KYC_COMPLETED]: '/proposal/review',
  [JOURNEY_STEPS.UW_DECISION]: '/proposal/review',
  [JOURNEY_STEPS.PROPOSAL_SUBMITTED]: '/payment',
  [JOURNEY_STEPS.PAYMENT_INITIATED]: '/payment',
  [JOURNEY_STEPS.PAYMENT_COMPLETED]: '/policy/status',
  [JOURNEY_STEPS.POLICY_ISSUED]: '/policy',
  [JOURNEY_STEPS.POLICY_DOWNLOADED]: '/policy',
  [JOURNEY_STEPS.JOURNEY_COMPLETED]: '/policy',
};

const JOURNEY_STATUS = {
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
  ABANDONED: 'ABANDONED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
};

// Only IN_PROGRESS and ABANDONED can be picked back up: an ABANDONED journey
// is one the sweeper aged out, which is precisely the journey-break case this
// feature exists for. COMPLETED / EXPIRED / FAILED are terminal.
const RESUMABLE_STATUSES = [JOURNEY_STATUS.IN_PROGRESS, JOURNEY_STATUS.ABANDONED];

const EVENT_TYPES = {
  JOURNEY_CREATED: 'JOURNEY_CREATED',
  STEP_ENTERED: 'STEP_ENTERED',
  STEP_COMPLETED: 'STEP_COMPLETED',
  STEP_FAILED: 'STEP_FAILED',
  JOURNEY_RESUMED: 'JOURNEY_RESUMED',
  JOURNEY_ABANDONED: 'JOURNEY_ABANDONED',
  JOURNEY_COMPLETED: 'JOURNEY_COMPLETED',
  ERROR: 'ERROR',
};

// api_transactions.api_name values — one per upstream call this backend makes,
// plus the inbound gateway callback.
const API_NAMES = {
  TOKEN: 'TOKEN',
  PREMIUM: 'PREMIUM',
  UW_DECISION: 'UW_DECISION',
  DATAPUSH: 'DATAPUSH',
  PAYMENT_ENCRYPT: 'PAYMENT_ENCRYPT',
  PAYMENT_DECRYPT: 'PAYMENT_DECRYPT',
  PAYMENT_CALLBACK: 'PAYMENT_CALLBACK',
  PROPOSAL_STATUS: 'PROPOSAL_STATUS',
  POLICY_DOWNLOAD: 'POLICY_DOWNLOAD',
};

const PAYMENT_STATUS = {
  INITIATED: 'INITIATED',
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  ERROR: 'ERROR',
};

const KYC_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING: 'PENDING',
  IN_PROGRESS: 'IN_PROGRESS',
  VERIFIED: 'VERIFIED',
  REJECTED: 'REJECTED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
  FAILED: 'FAILED',
};

const POLICY_STATUS = {
  NOT_ISSUED: 'NOT_ISSUED',
  PENDING: 'PENDING',
  UNDER_REVIEW: 'UNDER_REVIEW',
  ISSUED: 'ISSUED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
};

const UW_STATUS = {
  NOT_STARTED: 'NOT_STARTED',
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REFERRED: 'REFERRED',
  DECLINED: 'DECLINED',
  FAILED: 'FAILED',
};

// Never advance last_completed_step backwards. A buyer who resumes at payment
// and then re-opens the quote screen to look at their sum insured must not
// have their restore point dragged back to QUOTE_GENERATED — otherwise every
// backward navigation would lose the proposal they already submitted.
function isStepAfter(candidate, current) {
  const candidateIndex = RESUME_ORDER.indexOf(candidate);
  const currentIndex = RESUME_ORDER.indexOf(current);
  if (candidateIndex === -1) return false;
  if (currentIndex === -1) return true;
  return candidateIndex > currentIndex;
}

function resumeRouteFor(step) {
  return STEP_TO_ROUTE[step] || '/quote';
}

function isValidStep(step) {
  return Object.prototype.hasOwnProperty.call(JOURNEY_STEPS, step);
}

export {
  JOURNEY_STEPS,
  RESUME_ORDER,
  STEP_TO_ROUTE,
  JOURNEY_STATUS,
  RESUMABLE_STATUSES,
  EVENT_TYPES,
  API_NAMES,
  PAYMENT_STATUS,
  KYC_STATUS,
  POLICY_STATUS,
  UW_STATUS,
  isStepAfter,
  resumeRouteFor,
  isValidStep,
};
