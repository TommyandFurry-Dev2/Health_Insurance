import axios from 'axios';
import config from '../config/env.js';
import { createTokenCache } from '../utils/tokenCache.js';

// Cached in-process; every caller (premium/UW/datapush services) shares
// this so we don't fetch a new token on every request.
const tokenCache = createTokenCache();

// The scope URL points at an Oracle IDCS/OIC tenant, whose client_credentials
// token endpoints take application/x-www-form-urlencoded bodies — the actual
// curl example was withheld ("to be shared on mail separately"), so this is
// the standard IDCS shape, not a confirmed-working payload. Verify against
// GET /nivabupa/token/test before building on top of it.
async function getNivaBupaToken({ forceRefresh = false } = {}) {
  if (!forceRefresh) {
    const cached = tokenCache.get();
    if (cached) return cached;
  }

  const { clientId, clientSecret, identifierCode, tokenUrl, scope } = config.nivabupa;

  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope,
    Identifier: 'Partner',
    Identifier_code: identifierCode
  });

  const response = await axios.post(tokenUrl, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    timeout: config.timeouts.token
  });

  const accessToken = response.data?.access_token;
  const expiresIn = response.data?.expires_in;
  if (!accessToken) {
    throw new Error(`NivaBupa token response missing access_token: ${JSON.stringify(response.data)}`);
  }

  return tokenCache.set(accessToken, Date.now() + ((expiresIn || 3300) * 1000));
}

export { getNivaBupaToken };
