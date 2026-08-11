import axios from 'axios';
import config from '../config/env.js';
import { getNivaBupaCaseApiToken } from './caseApiAuth.service.js';
import { traceBlock, buildExchange } from './genericApi.service.js';

// Proposal Status / Policy Download share the caseapi token (access_token
// header, not Authorization) — separate from genericApi.service.js's
// forwardToNivaBupa, which is only for the /api/generic/* family's OAuth token.
//
// Traced for the same reason Data Push is: NivaBupa answers this endpoint with
// HTTP 403 "unauthorized access : Provided APPLICATION_NUMBER ... does not
// matched with authorized access" for several distinct causes — an application
// number they do not recognise, a mobile that does not pair with it, or a
// caseapi identity not entitled to that proposal. The reply alone cannot tell
// them apart; the request beside it can.
async function forwardToCaseApi(url, body, { trace = null, returnExchange = false } = {}) {
  const accessToken = await getNivaBupaCaseApiToken();

  const headers = {
    'access_token': accessToken,
    'Content-Type': 'application/json'
  };

  if (trace) {
    traceBlock({ label: `${trace} — REQUEST`, url, headers, body });
  }

  try {
    const response = await axios.post(url, body, { headers, timeout: config.timeouts.api });

    if (trace) {
      traceBlock({ label: trace, url, headers, body, response });
    }
    if (returnExchange) {
      return { data: response.data, exchange: buildExchange({ url, headers, body, attempt: 0, response }) };
    }
    return response.data;
  } catch (error) {
    if (trace) {
      traceBlock({ label: `${trace} — FAILED`, url, headers, body, error });
    }
    if (returnExchange) {
      error.exchange = buildExchange({ url, headers, body, attempt: 0, error });
    }
    throw error;
  }
}

// Pass-through: caller sends { ApplicationNumber, MobileNumber } (per
// 24_PROPOSAL_STATUS_POLICY_DOWNLOAD.txt) — returns NivaBupa's
// { Status, StatusMessage, preIssuanceStatusData: [...] } envelope.
function getProposalStatus(payload) {
  return forwardToCaseApi(config.nivabupa.caseApi.proposalStatusUrl, payload, {
    trace: 'PROPOSAL STATUS API',
    returnExchange: true,
  });
}

// Document_Head/Document_Type are fixed per the doc ("Hardcode value"), not
// caller-supplied. Response is forwarded as-is; the exact JSON key wrapping
// the base64 PDF isn't shown in the kit (only "Response will be in Base 64
// format" — no sample), so the frontend has to handle whatever shape actually
// comes back on first live call.
function downloadPolicy(policyNumber) {
  return forwardToCaseApi(config.nivabupa.caseApi.policyDownloadUrl, {
    PolicyNumber: policyNumber,
    Document_Head: '1',
    Document_Type: '6'
  });
}

export { forwardToCaseApi, getProposalStatus, downloadPolicy };
