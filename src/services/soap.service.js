import axios from 'axios';
import config from '../config/env.js';
import { escapeXml, extractTag } from '../helpers/xml.helper.js';

// Names the cause instead of leaving a status code to interpret. Each branch is
// a failure actually observed on this integration, so one log line answers
// "which of these is it?" without another round-trip. Verified 2026-08-05
// against the live UAT service: a key that does not match the ciphertext
// returns HTTP 500 with a bare InternalServiceFault, identical to what garbage
// input returns, so the fault text alone cannot separate the two.
function classifyHttpFailure(status, data, soapUrl) {
  const body = String(data || '');
  if (status === 406) {
    return "WAF / IP allow-list — NivaBupa rejects this server's egress IP outright. "
      + 'The request never reached the SOAP service. Call from a whitelisted host.';
  }
  if (status === 401 || status === 403) {
    return 'Authentication or IP authorization rejected at the edge, before the SOAP method ran.';
  }
  if (status === 404) {
    return `Endpoint not found — check the configured SOAP URL (${soapUrl}).`;
  }
  if (status === 500 && /<(\w+:)?Fault>/i.test(body)) {
    const fault = extractTag(body, 'faultstring') || extractTag(body, 'faultString');
    return `SOAP Fault (WCF returns these as HTTP 500)${fault ? ` — faultstring: ${fault}` : ''}. `
      + 'The request reached the method and the method threw — a wrong EncryptionKey or a '
      + 'corrupted cipherText both land here.';
  }
  if (status === 500) {
    return 'HTTP 500 with no SOAP Fault envelope — server-side error inside NivaBupa.';
  }
  return `Unexpected HTTP ${status} from the SOAP endpoint.`;
}

// Transport failures never reach an HTTP status, so they need their own naming —
// otherwise a TLS handshake failure and a timeout look identical in the log.
function classifyTransportFailure(error, timeoutMs) {
  const code = error.code || '';
  if (code === 'ECONNABORTED' || /timeout/i.test(error.message)) {
    return `Timeout — no response within ${timeoutMs}ms. Nothing was received, so the payment `
      + 'status is unknown rather than failed.';
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'DNS resolution failed for the SOAP host.';
  if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EHOSTUNREACH') {
    return `Connection refused/reset (${code}) — a firewall or egress rule is the usual cause.`;
  }
  if (code.startsWith('CERT_') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
    return `TLS/SSL verification failed (${code}).`;
  }
  return `Transport failure${code ? ` (${code})` : ''} — no HTTP response was received.`;
}

// The encrypt/decrypt services are legacy ASMX/WCF SOAP endpoints (not the
// REST /api/generic/* family) — text/xml body, SOAPAction header, response
// value pulled out of the standard soap envelope by tag name.
async function callSoap({ method, resultTag, params }) {
  const soapUrl = config.nivabupa.payment.soapUrl;
  const soapAction = `http://tempuri.org/IService1/${method}`;

  const paramTags = Object.entries(params)
    .map(([key, value]) => `<tem:${key}>${escapeXml(value)}</tem:${key}>`)
    .join('\n         ');

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:${method}>
         ${paramTags}
      </tem:${method}>
   </soapenv:Body>
</soapenv:Envelope>`;

  console.log(`\n📤 Calling ${method} API`);
  console.log('   Endpoint:', soapUrl);
  console.log('   SOAPAction:', soapAction);
  console.log('   Encryption Key used:', params.EncryptionKey);
  console.log('   Payload (SOAP XML):');
  console.log(body);

  // validateStatus: true — log the full response ourselves for every status
  // (including SOAP Faults, which WCF returns as HTTP 500) instead of losing
  // the response body to a thrown axios exception before we can see it.
  let response;
  try {
    response = await axios.post(soapUrl, body, {
      headers: {
        'Content-Type': 'text/xml',
        'SOAPAction': soapAction
      },
      timeout: config.timeouts.soap,
      validateStatus: () => true
    });
  } catch (error) {
    // No HTTP response at all — timeout, DNS, TLS, refused connection. Without
    // this branch they all reach the caller as a generic axios message with no
    // indication of which one happened.
    const cause = classifyTransportFailure(error, config.timeouts.soap);
    console.error(`\n❌ ${method} API — no response received`);
    console.error('   Cause:', cause);
    console.error('   axios code:', error.code || '(none)');
    console.error('   Stack:', error.stack);
    const err = new Error(`NivaBupa SOAP ${method} call failed before any response: ${cause}`);
    err.soapTransportCode = error.code || null;
    err.soapCause = cause;
    err.cause = error;
    throw err;
  }

  console.log(`📥 ${method} API response — HTTP status ${response.status}`);
  // Response headers separate "the SOAP service answered" from "an edge device
  // answered for it" — a WAF block carries its own server header and an HTML
  // body, not text/xml. x-rcor is NivaBupa's request correlation id: quote it
  // to their support and they can find the exact request server-side, which is
  // the only way past a Fault with IncludeExceptionDetailInFaults disabled.
  console.log('   Response headers:', response.headers);
  console.log('   Full SOAP response:', response.data);

  if (response.status < 200 || response.status >= 300) {
    const cause = classifyHttpFailure(response.status, response.data, soapUrl);
    console.error(`   ❌ Cause: ${cause}`);
    const err = new Error(`NivaBupa SOAP ${method} call failed with HTTP ${response.status}: ${response.data}`);
    err.soapStatus = response.status;
    err.soapResponseData = response.data;
    err.soapResponseHeaders = response.headers;
    err.soapCause = cause;
    throw err;
  }

  const result = extractTag(response.data, resultTag);
  console.log(`   Parsed <${resultTag}>:`, result);
  if (result === null) {
    // HTTP 200 with no result tag: the call succeeded but returned nothing
    // usable. For decResp that is the signature of a key the service accepts
    // but which does not match the one the cipherText was produced with.
    const err = new Error(`NivaBupa SOAP response missing <${resultTag}>: ${response.data}`);
    err.soapStatus = response.status;
    err.soapResponseData = response.data;
    err.soapCause = `HTTP 200 but no <${resultTag}> in the envelope — for decResp this usually `
      + 'means the EncryptionKey does not match the one used to encrypt the returnMessage.';
    throw err;
  }
  return result;
}

// Turns a pipe-separated payment querystring into the encrypted `encparam`
// value the getPaymentValues.aspx form expects.
async function encryptPaymentParams(text) {
  return callSoap({
    method: 'encResp',
    resultTag: 'encRespResult',
    params: {
      text,
      EncryptionKey: config.nivabupa.payment.encryptionKey
    }
  });
}

// Decrypts the `returnMessage` NivaBupa posts back to our registered return
// URL after payment completes, into the pipe-separated status string.
async function decryptPaymentReturn(cipherText) {
  return callSoap({
    method: 'decResp',
    resultTag: 'decRespResult',
    params: {
      cipherText,
      EncryptionKey: config.nivabupa.payment.decryptionKey
    }
  });
}

export { callSoap, encryptPaymentParams, decryptPaymentReturn };
