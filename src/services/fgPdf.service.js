import axios from 'axios';

import config, { missingFgVariables } from '../config/env.js';
import {
  PDF_CONTRACT, PDF_OPERATION, PDF_MAGIC, soapAction,
} from '../constants/fg.constants.js';
import {
  validationError, configError, upstreamError, parseError, escapeXml, buildFgExchange,
} from '../helpers/fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Step 6 — the policy document.
//
// This is NOT the BO service every other FG operation uses. It is a separate WCF
// endpoint with its own path, its own contract name and its own SOAPAction:
//
//   POST {FG_PDF_BASE_URL}/TCSPDFService/Service1.svc
//   SOAPAction: http://tempuri.org/IService1/GetPDF   ← IService1, not IService
//   <tem:GetPDF><tem:PolicyNO>…</tem:PolicyNO></tem:GetPDF>
//
// <PolicyNO> has a capital O. It is reproduced exactly; a "corrected"
// <PolicyNo> is an element the service does not know.
//
// Unlike the BO service, this one DOES answer over https — so a working
// document call is not evidence that the BO service will, and the two hosts are
// configured separately for exactly that reason.
//
// ── What it actually returns ────────────────────────────────────────────────
// A LINK, never base64 (verified on UAT 2026-08-21 against four issued
// policies):
//
//   <GetPDFResult>http://…/TCSPDFService/PDF/FHA-51-26-0000840-00-000sch.pdf</GetPDFResult>
//
// so the link is followed here and the bytes returned. Handing it to the browser
// instead does not work, for two independent reasons: it is plain http, which an
// https page blocks as mixed content, and the host is FG's internal box, which a
// customer's browser has no route to.
//
// The parser still accepts base64, a data: URI and a wrapped element, because
// the kit ships no saved response and no schema for this call — but none of
// those has ever been observed.
//
// ── The document does not exist at the moment of issuance ───────────────────
// For roughly the first 15–25 seconds FG answer with a sentence instead:
//
//   <GetPDFResult>Kindly contact FG for policy document.</GetPDFResult>
//
// Measured on UAT 2026-08-21: not ready at t+14s, a 502 KB PDF at t+24s. That is
// the SAME sentence FG return for a policy number they have never heard of, and
// the two cannot be told apart from the response — so it is reported as
// `retryable` rather than as a dead end. A buyer landing on the return page
// straight from the payment gateway hits this every time, so the frontend polls
// rather than showing a failure; the policy itself is already issued.
// ─────────────────────────────────────────────────────────────────────────────

function assertConfigured() {
  // The document service needs a host, and falls back to the BO host — so the
  // same four-variable check applies. A policy number with nowhere to ask about
  // it is the same failure as an unconfigured quote.
  const missing = missingFgVariables();
  if (missing.length > 0) {
    throw configError(
      `Future Generali is not configured. Set ${missing.join(', ')} in the environment.`,
      { missing }
    );
  }
}

function endpoint() {
  return `${config.fg.pdfBaseUrl}${config.fg.paths.pdfService}`;
}

function buildGetPdfEnvelope(policyNo) {
  const tem = config.fg.soapTempuri;
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="${tem}">`
    + '<soapenv:Header/>'
    + '<soapenv:Body>'
    + '<tem:GetPDF>'
    + `<tem:PolicyNO>${escapeXml(policyNo)}</tem:PolicyNO>`
    + '</tem:GetPDF>'
    + '</soapenv:Body>'
    + '</soapenv:Envelope>'
  );
}

function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Is this string base64 that decodes to an actual PDF? */
function asPdfBuffer(value) {
  const cleaned = String(value).replace(/\s/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/=]+$/.test(cleaned) || cleaned.length < 100) return null;
  try {
    const buf = Buffer.from(cleaned, 'base64');
    return buf.subarray(0, 5).toString('latin1') === PDF_MAGIC ? buf : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{ kind:'pdf'|'url'|'empty'|'unavailable'|'unknown', pdfBase64?:string,
 *             bytes?:number, url?:string, message?:string, retryable?:boolean,
 *             snippet?:string }}
 */
function parseGetPdfResponse(soapXml) {
  if (!soapXml || typeof soapXml !== 'string') {
    throw parseError('The Future Generali document service returned an empty response');
  }

  const fault = soapXml.match(/<(?:\w+:)?Fault>([\s\S]*?)<\/(?:\w+:)?Fault>/i);
  if (fault) {
    const reason = (fault[1].match(/<faultstring[^>]*>([\s\S]*?)<\/faultstring>/i) || [, ''])[1];
    throw upstreamError(
      `Future Generali document service fault: ${unescapeXml(reason).trim() || 'SOAP Fault'}`,
      { snippet: soapXml.slice(0, 300) }
    );
  }

  const hit = soapXml.match(/<GetPDFResult[^>]*>([\s\S]*?)<\/GetPDFResult>/i);
  if (!hit) {
    // A self-closing or absent result is FG saying "nothing for that policy".
    if (/<GetPDFResult\s*\/>/i.test(soapXml)) {
      return {
        kind: 'empty',
        message: 'Future Generali returned no document for this policy number',
        retryable: true,
      };
    }
    throw parseError('The Future Generali document response has no <GetPDFResult>', {
      snippet: soapXml.slice(0, 300),
    });
  }

  const raw = unescapeXml(hit[1]).trim();
  if (!raw) {
    return {
      kind: 'empty',
      message: 'Future Generali returned an empty document for this policy number',
      retryable: true,
    };
  }

  // 1. straight base64 PDF
  const direct = asPdfBuffer(raw);
  if (direct) return { kind: 'pdf', pdfBase64: direct.toString('base64'), bytes: direct.length };

  // 2. a data: URI wrapping it
  const dataUri = raw.match(/^data:application\/pdf;base64,(.+)$/i);
  if (dataUri) {
    const buf = asPdfBuffer(dataUri[1]);
    if (buf) return { kind: 'pdf', pdfBase64: buf.toString('base64'), bytes: buf.length };
  }

  // 3. base64 nested in a wrapper element FG may have added
  const nested = raw.match(/<(?:PDF|Pdf|Base64|FileData|Document)[^>]*>([\s\S]*?)<\//i);
  if (nested) {
    const buf = asPdfBuffer(nested[1]);
    if (buf) return { kind: 'pdf', pdfBase64: buf.toString('base64'), bytes: buf.length };
  }

  // 4. a link to fetch it from — the observed case
  if (/^https?:\/\//i.test(raw) && raw.length < 2000) return { kind: 'url', url: raw };

  // 5. FG's own plain-sentence refusal, passed through verbatim because it is
  //    already the sentence a human needs. Retryable: for a number that came
  //    from a successful issuance, waiting is the right move.
  if (!raw.startsWith('<') && raw.length < 300 && /\s/.test(raw)) {
    return { kind: 'unavailable', message: raw, retryable: true };
  }

  // 6. something else — reported as-is rather than as a broken PDF.
  return {
    kind: 'unknown',
    message: 'Future Generali returned a document response in an unrecognised format',
    snippet: raw.slice(0, 300),
  };
}

/**
 * Is this document link on FG's own host?
 *
 * The URL comes out of an upstream response, so following it unconditionally
 * would let whatever answers that SOAP call aim this server at any address it
 * likes — the whole shape of an SSRF. Both configured FG hosts are allowed,
 * because the document service may legitimately be pointed away from the BO
 * service.
 */
function isFgHost(url) {
  let target;
  try {
    target = new URL(String(url));
  } catch {
    return false;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return false;

  const allowed = new Set();
  for (const base of [config.fg.pdfBaseUrl, config.fg.boBaseUrl]) {
    if (!base) continue;
    try {
      allowed.add(new URL(base).hostname.toLowerCase());
    } catch {
      // A malformed base URL contributes no allowed host rather than throwing:
      // config/validate.js is where that is reported.
    }
  }
  return allowed.has(target.hostname.toLowerCase());
}

/** Fetch the document FG linked to. */
async function fetchDocument(url) {
  const response = await axios.get(url, {
    timeout: config.timeouts.fgPdf,
    responseType: 'arraybuffer',
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      httpStatus: response.status,
      message: `Future Generali's document link returned HTTP ${response.status}`,
    };
  }

  const buf = Buffer.from(response.data);
  if (buf.subarray(0, 5).toString('latin1') !== PDF_MAGIC) {
    // An error page served with a 200 is the usual cause. Reported as what it
    // is, rather than streamed to the buyer as a corrupt download.
    return {
      ok: false,
      httpStatus: response.status,
      message: "Future Generali's document link did not return a PDF",
    };
  }

  return { ok: true, buf, httpStatus: response.status };
}

/**
 * @param {object} p
 * @param {string} p.policyNo  as returned by issuance — never a kit sample
 * @param {boolean} [p.followUrl=true] fetch the document FG link to. Set false
 *   (`?meta=1` on the route) to see what FG answered without pulling half a
 *   megabyte with it — which is what makes polling cheap enough to do.
 */
async function getPdf({ policyNo, followUrl = true } = {}) {
  assertConfigured();

  if (!policyNo || String(policyNo).trim() === '') {
    throw validationError(
      'A policy number is required to fetch the document. It comes from a successful issuance.',
      'policyNo'
    );
  }

  const url = endpoint();
  const envelope = buildGetPdfEnvelope(policyNo);
  const headers = {
    'Content-Type': 'text/xml; charset=utf-8',
    SOAPAction: soapAction(config.fg.soapTempuri, PDF_OPERATION, PDF_CONTRACT),
  };

  let response;
  try {
    response = await axios.post(url, envelope, {
      headers,
      timeout: config.timeouts.fgPdf,
      validateStatus: () => true,
      responseType: 'text',
      transformResponse: [(data) => data],
    });
  } catch (error) {
    const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
    const wrapped = timedOut
      ? Object.assign(new Error(`Future Generali GetPDF timed out after ${config.timeouts.fgPdf}ms`), {
        status: 504, code: 'FG_TIMEOUT_ERROR', provider: 'fg',
      })
      : upstreamError(`Future Generali GetPDF failed: ${error.message}`, {
        errorCode: error.code || null, endpoint: url,
      });
    wrapped.exchange = buildFgExchange({ url, headers, body: envelope, error });
    throw wrapped;
  }

  const bodyText = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const exchange = buildFgExchange({ url, headers, body: envelope, response });
  const parsed = parseGetPdfResponse(bodyText);

  console.log(
    `[fg] policy document response — policyNo=${policyNo} httpStatus=${response.status} `
    + `kind=${parsed.kind}${parsed.bytes ? ` bytes=${parsed.bytes}` : ''}`
    // The document itself, and its link, are never logged.
  );

  const base = { policyNo: String(policyNo), httpStatus: response.status, exchange };

  // FG answer with a link, so this is the ordinary path rather than a fallback.
  if (parsed.kind === 'url' && followUrl) {
    if (!isFgHost(parsed.url)) {
      console.warn('⚠️  FG document link is not on a configured FG host — not fetched.');
      return {
        ...base,
        ...parsed,
        ok: false,
        message: 'Future Generali returned a document link on an unexpected host, so it was not '
          + 'fetched. The policy is unaffected; report the link to Future Generali.',
      };
    }

    const document = await fetchDocument(parsed.url);
    if (document.ok) {
      console.log(`[fg] policy document downloaded — bytes=${document.buf.length}`);
      return {
        ...base,
        ok: true,
        kind: 'pdf',
        pdfBase64: document.buf.toString('base64'),
        bytes: document.buf.length,
        url: parsed.url,
      };
    }

    return { ...base, ...parsed, ok: false, message: document.message, retryable: true };
  }

  return { ...base, ...parsed, ok: parsed.kind === 'pdf' };
}

export {
  getPdf,
  endpoint,
  buildGetPdfEnvelope,
  parseGetPdfResponse,
  isFgHost,
  fetchDocument,
  assertConfigured,
};
