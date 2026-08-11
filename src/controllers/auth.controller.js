import { getNivaBupaToken } from '../services/nivabupaAuth.service.js';
import * as journeyService from '../services/journey.service.js';
import config from '../config/env.js';
import { API_NAMES } from '../constants/journey.constants.js';

// Isolated check so we can confirm the client_id/secret/Identifier_code
// combination actually works against the UAT token endpoint before wiring
// up premium/UW/datapush, whose request/response shapes aren't known yet.
//
// Audited into api_transactions with journey_id NULL — this is infrastructure,
// not a journey step, and api_transactions.journey_id is nullable exactly so
// calls like this are still recorded. The token itself is never persisted;
// forAudit() redacts it (see utils/sanitize.js).
export const testToken = async (req, res) => {
  const startedAt = Date.now();

  try {
    const token = await getNivaBupaToken({ forceRefresh: true });

    await journeyService.recordStandaloneApiCall({
      apiName: API_NAMES.TOKEN,
      httpMethod: 'POST',
      endpointUrl: config.nivabupa.tokenUrl,
      status: 'SUCCESS',
      httpStatus: 200,
      durationMs: Date.now() - startedAt,
      responsePayload: { token_preview: `${token.slice(0, 12)}...` },
    });

    return res.status(200).json({
      status: 'SUCCESS',
      message: 'NivaBupa token acquired',
      token_preview: `${token.slice(0, 12)}...`
    });
  } catch (error) {
    console.error('❌ NivaBupa token test failed:', error.response?.data || error.message);

    await journeyService.recordStandaloneApiCall({
      apiName: API_NAMES.TOKEN,
      httpMethod: 'POST',
      endpointUrl: config.nivabupa.tokenUrl,
      status: 'FAILED',
      httpStatus: error.response?.status || null,
      durationMs: Date.now() - startedAt,
      responsePayload: error.response?.data || null,
      errorMessage: error.message,
    });

    return res.status(502).json({
      status: 'ERROR',
      message: error.message,
      nivabupa_response: error.response?.data || null
    });
  }
};
