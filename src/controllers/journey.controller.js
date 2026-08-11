import * as journeyService from '../services/journey.service.js';
import * as journeyRepo from '../repositories/journey.repository.js';
import * as policyRepo from '../repositories/policy.repository.js';
import * as logRepo from '../repositories/log.repository.js';
import {
  JOURNEY_STEPS,
  KYC_STATUS,
  isValidStep,
} from '../constants/journey.constants.js';

function contextOf(req) {
  return {
    ipAddress: req.ip || req.socket?.remoteAddress || null,
    userAgent: req.headers['user-agent'] || null,
  };
}

// POST /nivabupa/journey — start a journey.
//
// Mobile is the only required field: it is the identity key, and the only value
// mandatory on both payment/initiate and proposal-status, so it is guaranteed to
// exist for any journey that can reach payment.
export const createJourney = async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'mobile is required to start a journey (it is the journey identity key)',
      });
    }

    const { journey, user } = await journeyService.createJourney(req.body, contextOf(req));

    // 201 with the resume token in the body. The SPA stores journeyId +
    // resumeToken and sends them as X-Journey-Id / X-Resume-Token on every
    // subsequent call — that pair is what survives a browser close.
    return res.status(201).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      resumeToken: journey.resume_token,
      currentStep: journey.current_step,
      expiresAt: journey.expires_at,
      user: { userId: user.id, mobile: user.mobile, email: user.email },
    });
  } catch (error) {
    console.error('❌ Journey create failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// POST /nivabupa/journey/resume — resume with a token.
export const resumeJourney = async (req, res) => {
  try {
    const resumeToken = req.body.resumeToken || req.headers['x-resume-token'];
    if (!resumeToken) {
      return res.status(400).json({ status: 'ERROR', message: 'resumeToken is required' });
    }

    const snapshot = await journeyService.resumeByToken(resumeToken, contextOf(req));
    if (!snapshot) {
      // One message for "no such token", "expired" and "already completed" on
      // purpose — the token is a bearer credential, and distinguishing those
      // cases would let a caller probe which tokens exist.
      return res.status(404).json({
        status: 'ERROR',
        message: 'No resumable journey found for this token (it may have expired or completed)',
      });
    }

    return res.status(200).json({ status: 'SUCCESS', ...snapshot });
  } catch (error) {
    console.error('❌ Journey resume failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// POST /nivabupa/journey/resume-by-mobile — restore on login.
//
// This is the path that works from a new device or after browser storage is
// cleared: the buyer proves who they are with their mobile and gets their
// unfinished journeys back, each with its own resume token.
export const resumeByMobile = async (req, res) => {
  try {
    const { mobile } = req.body;
    if (!mobile) {
      return res.status(400).json({ status: 'ERROR', message: 'mobile is required' });
    }

    const { user, journeys } = await journeyService.findResumableForMobile(mobile);
    if (!user) {
      return res.status(200).json({ status: 'SUCCESS', journeys: [], message: 'No journeys found for this mobile' });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      user: { userId: user.id, mobile: user.mobile, email: user.email },
      journeys,
    });
  } catch (error) {
    console.error('❌ Journey resume-by-mobile failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// GET /nivabupa/journey/:journeyId — the full restore snapshot.
export const getJourney = async (req, res) => {
  try {
    const snapshot = await journeyService.getSnapshotByUuid(req.params.journeyId);
    if (!snapshot) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }
    return res.status(200).json({ status: 'SUCCESS', ...snapshot });
  } catch (error) {
    console.error('❌ Journey fetch failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// PATCH /nivabupa/journey/:journeyId/step — the form autosave endpoint.
//
// Called by the SPA after every important form submission that has no upstream
// API call of its own (proposer details, member details, nominee). stepData is
// merged, not replaced, so saving one section never wipes another's draft.
export const saveStep = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const { step, stepData, ...fields } = req.body;
    if (step && !isValidStep(step)) {
      return res.status(400).json({
        status: 'ERROR',
        message: `Unknown step "${step}". Valid steps: ${Object.keys(JOURNEY_STEPS).join(', ')}`,
      });
    }

    const updated = await journeyService.saveStep(journey.id, step || journey.current_step, {
      stepData,
      fields,
      context: contextOf(req),
    });

    if (!updated) {
      return res.status(500).json({ status: 'ERROR', message: 'Step save failed — see server logs' });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      currentStep: updated.current_step,
      lastCompletedStep: updated.last_completed_step,
    });
  } catch (error) {
    console.error('❌ Journey step save failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// POST /nivabupa/journey/:journeyId/select-quote — record the chosen quote
// (and therefore the chosen insurer/variant), and open the proposal.
export const selectQuote = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const { quoteId } = req.body;
    if (!quoteId) {
      return res.status(400).json({ status: 'ERROR', message: 'quoteId (quote uuid) is required' });
    }

    const result = await journeyService.selectQuote(journey.id, quoteId, contextOf(req));
    if (!result) {
      return res.status(400).json({
        status: 'ERROR',
        message: 'Quote could not be selected — it may not belong to this journey',
      });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      currentStep: result.journey.current_step,
      selectedQuote: {
        quoteId: result.quote.uuid,
        productVariant: result.quote.product_variant,
        sumInsured: result.quote.sum_insured,
        totalPremium: result.quote.total_premium,
      },
    });
  } catch (error) {
    console.error('❌ Quote selection failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// PUT /nivabupa/journey/:journeyId/proposal — autosave proposer / member /
// nominee blocks into typed columns, before any UW call happens.
export const saveProposal = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const { step, ...details } = req.body;
    if (step && !isValidStep(step)) {
      return res.status(400).json({ status: 'ERROR', message: `Unknown step "${step}"` });
    }

    const saved = await journeyService.saveProposalDetails(journey.id, details, step, contextOf(req));
    if (!saved) {
      return res.status(500).json({ status: 'ERROR', message: 'Proposal save failed — see server logs' });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      proposalId: saved.uuid,
      uwStatus: saved.uw_status,
      datapushStatus: saved.datapush_status,
    });
  } catch (error) {
    console.error('❌ Proposal save failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// PUT /nivabupa/journey/:journeyId/kyc — record KYC outcome.
//
// No NivaBupa KYC API exists in the current integration kit, so this endpoint
// takes the result from whichever provider the frontend uses and persists it, so
// a buyer who breaks after verifying is not sent through KYC again.
export const saveKyc = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const { status } = req.body;
    if (status && !Object.prototype.hasOwnProperty.call(KYC_STATUS, status)) {
      return res.status(400).json({
        status: 'ERROR',
        message: `Unknown KYC status "${status}". Valid: ${Object.keys(KYC_STATUS).join(', ')}`,
      });
    }

    const kyc = await journeyService.saveKycStatus(journey.id, req.body, contextOf(req));
    if (!kyc) {
      return res.status(500).json({ status: 'ERROR', message: 'KYC save failed — see server logs' });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      kyc: {
        status: kyc.status,
        method: kyc.method,
        referenceId: kyc.reference_id,
        attemptCount: kyc.attempt_count,
        verifiedAt: kyc.verified_at,
      },
    });
  } catch (error) {
    console.error('❌ KYC save failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// GET /nivabupa/journey/:journeyId/policy-document — serve the stored PDF.
//
// Lets a resumed journey hand back the policy document without calling
// NivaBupa again, which is the difference between a resume that works offline
// from our own data and one that depends on the partner API being up.
export const getStoredPolicyDocument = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const document = await policyRepo.findDocument(journey.id);
    if (!document || !document.document_available) {
      return res.status(404).json({
        status: 'ERROR',
        message: 'No policy document stored for this journey yet — call /nivabupa/policy-download first',
      });
    }

    return res.status(200).json({
      status: 'SUCCESS',
      policyNumber: document.policy_number,
      downloadedAt: document.document_downloaded_at,
      documentBase64: document.document_base64,
    });
  } catch (error) {
    console.error('❌ Stored policy document fetch failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// GET /nivabupa/journey/:journeyId/timeline — step trail + API call log.
// Support-facing: answers "where did this buyer stop and what did NivaBupa say".
export const getTimeline = async (req, res) => {
  try {
    const journey = await journeyRepo.findByUuid(req.params.journeyId);
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }

    const [events, apiCalls] = await Promise.all([
      logRepo.listEvents(journey.id, { limit: 200 }),
      logRepo.listApiTransactions(journey.id, { limit: 200 }),
    ]);

    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      currentStep: journey.current_step,
      lastCompletedStep: journey.last_completed_step,
      events,
      apiCalls,
    });
  } catch (error) {
    console.error('❌ Journey timeline fetch failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};

// POST /nivabupa/journey/:journeyId/abandon — explicit abandon.
// Still resumable: ABANDONED is the journey-break state this feature exists
// for, not a terminal one.
export const abandonJourney = async (req, res) => {
  try {
    const journey = await journeyService.abandonJourney(req.params.journeyId, contextOf(req));
    if (!journey) {
      return res.status(404).json({ status: 'ERROR', message: 'Journey not found' });
    }
    return res.status(200).json({
      status: 'SUCCESS',
      journeyId: journey.uuid,
      journeyStatus: journey.status,
      message: 'Journey marked abandoned; it can still be resumed with its resume token until it expires',
    });
  } catch (error) {
    console.error('❌ Journey abandon failed:', error.message);
    return res.status(500).json({ status: 'ERROR', message: error.message });
  }
};
