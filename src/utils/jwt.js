// The caseapi token response carries no expires_in — only a JWT — so its
// lifetime has to come from the token's own "exp" claim rather than a guessed
// duration. Returns null when the value isn't a decodable JWT, so the caller
// can fall back to a default window.
function decodeJwtExpiryMs(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export { decodeJwtExpiryMs };
