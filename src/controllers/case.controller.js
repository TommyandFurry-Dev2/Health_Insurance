import * as caseApi from '../services/caseApi.service.js';
import * as journeyService from '../services/journey.service.js';
import * as proposalRepo from '../repositories/proposal.repository.js';
import * as policyRepo from '../repositories/policy.repository.js';
import config from '../config/env.js';

// Pass-through: caller sends { ApplicationNumber, MobileNumber } (per
// 24_PROPOSAL_STATUS_POLICY_DOWNLOAD.txt) — returns NivaBupa's
// { Status, StatusMessage, preIssuanceStatusData: [...] } envelope.
//
// With a journey in context, ApplicationNumber and MobileNumber are filled in
// from the stored proposal when the caller omits them. That is what lets a
// resumed journey check its own status without the frontend having had to keep
// the application number across a browser close — it was returned exactly once,
// by data push.
export const getProposalStatus = async (req, res) => {
  const startedAt = Date.now();
  const journeyId = req.journeyId;

  try {
    const payload = { ...req.body };

    if (journeyId) {
      const proposal = await proposalRepo.findByJourneyId(journeyId);
      if (proposal) {
        if (!payload.ApplicationNumber && proposal.application_number) {
          payload.ApplicationNumber = proposal.application_number;
        }
        if (!payload.MobileNumber && proposal.proposer_mobile) {
          payload.MobileNumber = proposal.proposer_mobile;
        }
      }
    }

    if (!payload.ApplicationNumber) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'ApplicationNumber is required (no stored application number found for this journey)',
        data: null,
      });
    }

    const { data, exchange } = await caseApi.getProposalStatus(payload);

    const saved = await journeyService.recordProposalStatus({
      journeyId,
      requestPayload: payload,
      responsePayload: data,
      httpSucceeded: true,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.caseApi.proposalStatusUrl,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      data,
      // The ApplicationNumber/MobileNumber pair this server actually sent —
      // note the controller may substitute stored values above, so what the
      // browser posted is not necessarily what went upstream.
      nivabupaRequest: exchange,
      ...(saved
        ? {
          journeyId: req.journey.uuid,
          policyStatus: saved.status,
          policyNumber: saved.policy_number,
        }
        : {}),
    });
  } catch (error) {
    console.error('❌ NivaBupa proposal status call failed:', error.response?.data || error.message);

    await journeyService.recordProposalStatus({
      journeyId,
      requestPayload: req.body,
      responsePayload: error.response?.data || null,
      httpSucceeded: false,
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.caseApi.proposalStatusUrl,
      errorMessage: error.message,
    });

    return res.status(502).json({
      status: 'ERROR',
      message: error.message,
      nivabupa_response: error.response?.data || null,
      // NivaBupa's 403 names the application number but not which part of the
      // pair failed to match. Returning what was sent is the only way to tell a
      // wrong identifier from an unmatched mobile from an unentitled caseapi
      // identity, without shell access to the server.
      nivabupaRequest: error.exchange || null,
    });
  }
};

// Caller sends { PolicyNumber } — Document_Head/Document_Type are fixed per
// the doc ("Hardcode value"), not caller-supplied. Response is forwarded
// as-is; the exact JSON key wrapping the base64 PDF isn't shown in the kit
// (only "Response will be in Base 64 format" — no sample), so the frontend
// has to handle whatever shape actually comes back on first live call.
//
// Two persistence behaviours here:
//   * PolicyNumber falls back to the journey's stored policy, so a resumed
//     journey can download without the frontend having kept it.
//   * An already-downloaded document is served from MySQL instead of calling
//     NivaBupa again, so resume works even while the caseapi is unavailable.
export const downloadPolicy = async (req, res) => {
  const startedAt = Date.now();
  const journeyId = req.journeyId;

  try {
    let { PolicyNumber } = req.body;

    if (!PolicyNumber && journeyId) {
      const policy = await policyRepo.findByJourneyId(journeyId);
      PolicyNumber = policy?.policy_number || policy?.application_number || null;
    }

    if (!PolicyNumber) {
      return res.status(400).json({ status: 'ERROR', message: 'PolicyNumber is required', data: null });
    }

    if (journeyId && !req.body.forceRefresh) {
      const stored = await policyRepo.findDocument(journeyId);
      if (stored?.document_available && stored.document_base64) {
        console.log('📄 Serving stored policy document for journey — no NivaBupa call made.');
        return res.status(200).json({
          status: 'SUCCESS',
          source: 'CACHE',
          data: { PolicyNumber: stored.policy_number || PolicyNumber, documentBase64: stored.document_base64 },
          journeyId: req.journey.uuid,
          downloadedAt: stored.document_downloaded_at,
        });
      }
    }

    const data = await caseApi.downloadPolicy(PolicyNumber);

    const saved = await journeyService.recordPolicyDownload({
      journeyId,
      policyNumber: PolicyNumber,
      responsePayload: data,
      httpSucceeded: true,
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.caseApi.policyDownloadUrl,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      data,
      ...(saved
        ? {
          journeyId: req.journey.uuid,
          source: 'NIVABUPA',
          documentStored: Boolean(saved.document_available),
        }
        : {}),
    });
  } catch (error) {
    console.error('❌ NivaBupa policy download call failed:', error.response?.data || error.message);

    await journeyService.recordPolicyDownload({
      journeyId,
      policyNumber: req.body?.PolicyNumber,
      responsePayload: error.response?.data || null,
      httpSucceeded: false,
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.caseApi.policyDownloadUrl,
      errorMessage: error.message,
    });

    return res.status(502).json({
      status: 'ERROR',
      message: error.message,
      nivabupa_response: error.response?.data || null
    });
  }
};
