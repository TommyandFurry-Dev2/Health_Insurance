// Minimal XML primitives for the legacy ASMX/WCF SOAP endpoints — not a full
// parser, just enough to build a tempuri.org envelope and pull one result tag
// back out of it.
//
// Deliberately not a real XML parser (fast-xml-parser and friends): NivaBupa's
// encResp/decResp results are opaque cipher strings, and a real parser would
// entity-decode and whitespace-normalise them. extractTag returns the tag body
// byte-for-byte, which is what the gateway expects back.
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function extractTag(xml, tagName) {
  const match = xml.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? match[1] : null;
}

export { escapeXml, extractTag };
