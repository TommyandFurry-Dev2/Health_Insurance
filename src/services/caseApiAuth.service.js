import axios from 'axios';
import config from '../config/env.js';
import { createTokenCache } from '../utils/tokenCache.js';
import { decodeJwtExpiryMs } from '../utils/jwt.js';

// Proposal Status / Policy Download use a completely separate auth mechanism
// from Premium/UW/DataPush's OAuth token (nivabupaAuth.service.js): a different
// host (/caseapi/ not /api/generic/), a different credential pair (UserID +
// Client_id, not client_id/client_secret), and the resulting token goes in
// an `access_token` header, not `Authorization`. Cached the same way
// (in-process) since both endpoints share it.
const tokenCache = createTokenCache();

// Unlike every other NivaBupa credential in this codebase, there is no
// known-good UAT value to fall back to here — 24_PROPOSAL_STATUS_POLICY_DOWNLOAD.txt
// explicitly labels UserID/Client_id "Partner specific to be shared
// separately on mail" with no sample value anywhere in the kit. Must be
// set via env; fails loudly rather than silently sending "undefined"
// credentials.
async function getNivaBupaCaseApiToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = tokenCache.get();
    if (cached) return cached;
  }

  const { tokenUrl, userId, clientId } = config.nivabupa.caseApi;
  if (!userId || !clientId) {
    throw new Error('NIVABUPA_CASEAPI_USER_ID / NIVABUPA_CASEAPI_CLIENT_ID not configured — request these from NivaBupa (they are separate from the generic API client_id/secret).');
  }

  const response = await axios.post(tokenUrl, {
    UserID: userId,
    Client_id: clientId,
    Identifier_Code: null,
    Identifier: 'PARTNER'
  }, {
    headers: { 'Content-Type': 'application/json' },
    timeout: config.timeouts.token
  });

  // Confirmed live 2026-07-28 with real credentials: actual shape is
  // { Status, Token, StatusMessage } — no expires_in, so decode the JWT's own
  // "exp" claim for cache expiry instead of guessing a duration.
  const accessToken = response.data?.Token;
  if (!accessToken) {
    throw new Error(`NivaBupa caseapi token response missing Token: ${JSON.stringify(response.data)}`);
  }

  const expiryMs = decodeJwtExpiryMs(accessToken) || Date.now() + 3300 * 1000;
  return tokenCache.set(accessToken, expiryMs);
}

export { getNivaBupaCaseApiToken };
