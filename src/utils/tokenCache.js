// In-process token cache shared by the two NivaBupa auth flows (the
// /api/generic/* OAuth token and the /caseapi/ access_token). Each caller
// creates its own instance — the two tokens are never interchangeable.
//
// Deliberately its own thing rather than a generic provider token manager:
// these two refresh 30s before expiry, and the caseapi token has no expires_in
// at all (its lifetime comes from the JWT's own exp claim). A shared manager
// that refreshed at a percentage of TTL would change when tokens are renewed.
//
// Refresh 30s early so an in-flight request never races token expiry.
const EXPIRY_SKEW_MS = 30000;

function createTokenCache() {
  let cachedToken = null;
  let cachedTokenExpiry = 0;

  return {
    get() {
      if (cachedToken && Date.now() < cachedTokenExpiry) {
        return cachedToken;
      }
      return null;
    },
    set(token, expiresAtMs) {
      cachedToken = token;
      cachedTokenExpiry = expiresAtMs - EXPIRY_SKEW_MS;
      return token;
    },
    clear() {
      cachedToken = null;
      cachedTokenExpiry = 0;
    },
  };
}

export { createTokenCache, EXPIRY_SKEW_MS };
