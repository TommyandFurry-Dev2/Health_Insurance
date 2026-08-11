// Business constants Niva Bupa require on every UW Decision / Data Push
// request (their observations on our payload, 2026-08-07).
//
// These are Novacred's own channel identity, not per-buyer data — there is no
// form field or API response any of them could come from, which is why they are
// constants rather than something traced back to an input.
//
// Why they exist here as well as in the frontend's utils/nivabupaUwPayload.js:
// the frontend builds the payload and is the source of truth for it, but the
// bundle a buyer's browser is holding may predate this fix, and a Data Push
// runs after money has already moved — retrying it is not free. So the last hop
// before NivaBupa asserts them too (see helpers/proposal.helper.js). The two
// copies are constants of the same five values, not two independent mappings.
//
// The values themselves come from config (env with a bundled fallback — see
// config/defaults.js PROPOSAL_DEFAULTS), because Niva Bupa can reassign the
// branch and agent codes per partner.
import config from '../config/env.js';

const PROPOSAL_BUSINESS_DEFAULTS = {
  // POLICY.POLICY_OTHER_DETAILS.LOGIN_BRANCH_CODE / NOC_BRANCH_CODE — both were
  // going out null.
  loginBranchCode: config.nivabupa.proposal.loginBranchCode,
  nocBranchCode: config.nivabupa.proposal.nocBranchCode,
  // POLICY.SOURCING_INFO.AGENT_INFO.AGENT_CODE — was null. Same value as the
  // OAuth Identifier_code (config/env.js nivabupa.identifierCode).
  agentCode: config.nivabupa.proposal.agentCode,
  // POLICY.PAYMENT_INFO.PAYMENT_COLLECT_MODE — was ''. "OL" = collected online,
  // which every payment through the Juspay gateway is.
  paymentCollectMode: config.nivabupa.proposal.paymentCollectMode,
  // POLICY.PAYMENT_INFO.PAYMENT_RECEIVED_FLAG — was 'N'. Data Push only runs
  // after a SUCCESS callback, so the money is always in by then.
  paymentReceivedFlag: config.nivabupa.proposal.paymentReceivedFlag,
};

// Riders whose absence must be expressed by omitting the ADJUSTMENT_DETAILS
// entry entirely rather than sending a zero/blank value. A_COPAY was going out
// as ADJUSTMENT_VALUE "0" on every proposal, which their engine reads as an
// explicit election of zero-percent voluntary copay, not as "no copay chosen".
//
// A protocol fact about their underwriting engine, not an environment setting —
// deliberately not env-configurable.
const OMIT_WHEN_UNSELECTED_ADJUSTMENTS = ['A_COPAY'];

export { PROPOSAL_BUSINESS_DEFAULTS, OMIT_WHEN_UNSELECTED_ADJUSTMENTS };
