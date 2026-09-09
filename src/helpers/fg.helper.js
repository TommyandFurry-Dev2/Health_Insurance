import { XMLParser } from 'fast-xml-parser';

import config from '../config/env.js';
import { soapAction } from '../constants/fg.constants.js';

// ─────────────────────────────────────────────────────────────────────────────
// Future Generali — the small set of transformations either side of the wire.
//
//   * fgError / validationError — the typed failure this integration throws
//   * buildEnvelope             — the SOAP 1.1 envelope for the BO service
//   * parseSoapResponse         — envelope → the inner <Root> document
//   * extractQuote              — an ENQ (premium) response, normalised
//   * extractPolicyResult       — a CRT (proposal / issuance) response
//   * requireFields / isDdMmYyyy / assert — the payload guards the builder uses
//
// The <Root> BUILDER lives next door in fgXml.helper.js and the payment
// cryptography in fgPayment.helper.js, for the same reason ITGI splits
// itgi.helper.js from itgiValidation.helper.js: each file is one concern, and
// the builder is the one that has to be read field-by-field against FG's kit.
//
// Nothing here reads process.env — config.fg is the only environment this file
// touches, and it arrives through config/env.js like everything else.
// ─────────────────────────────────────────────────────────────────────────────

// The convention for a typed failure in this codebase is an Error with extra
// properties, not a class hierarchy — the same shape itgi.helper.js's itgiError
// produces, with `fg` where that one says `itgi`.
//
//   status  — the HTTP status the controller answers with
//   code    — machine-readable, stable across message rewording
//   field   — the offending request field, when there is one
//   details — anything the caller needs in order to act
function fgError(message, { status = 502, code = 'FG_ERROR', field = null, details = null } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  error.provider = 'fg';
  if (field) error.field = field;
  if (details) error.details = details;
  return error;
}

function validationError(message, field = null, details = null) {
  return fgError(message, { status: 400, code: 'FG_VALIDATION_ERROR', field, details });
}

function configError(message, details = null) {
  return fgError(message, { status: 503, code: 'FG_CONFIG_ERROR', details });
}

function upstreamError(message, details = null) {
  return fgError(message, { status: 502, code: 'FG_UPSTREAM_ERROR', details });
}

function parseError(message, details = null) {
  return fgError(message, { status: 502, code: 'FG_PARSE_ERROR', details });
}

// ── Payload guards ──────────────────────────────────────────────────────────
//
// Deliberately minimal and dependency-free, matching the working
// implementation's core/validate.js: enough to guard the required fields of an
// FG payload without pulling in a schema library.

function isEmpty(value) {
  return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
}

function getPath(obj, path) {
  return path.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

/**
 * Assert that every dot-notation path is present and non-empty.
 * @param {string[]} fields e.g. ['policy.startDate', 'client.dob']
 */
function requireFields(obj, fields, context = 'request') {
  const missing = fields.filter((path) => isEmpty(getPath(obj, path)));
  if (missing.length) {
    throw validationError(
      `Missing required field(s) for ${context}: ${missing.join(', ')}`,
      missing[0],
      { context, missing }
    );
  }
}

/** dd/mm/yyyy — what the SOAP payload wants. */
function isDdMmYyyy(value) {
  return typeof value === 'string' && /^\d{2}\/\d{2}\/\d{4}$/.test(value);
}

/** dd-mm-yyyy — what the CKYC payload wants. The two are NOT interchangeable. */
function isDdMmYyyyDash(value) {
  return typeof value === 'string' && /^\d{2}-\d{2}-\d{4}$/.test(value);
}

function assert(condition, message, details = null) {
  if (!condition) {
    throw validationError(message, details?.field ?? null, details);
  }
}

// ── SOAP ────────────────────────────────────────────────────────────────────

function escapeXml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The SOAP 1.1 envelope for the BO service. The operation body is always:
 *
 *   <tem:{OP}>
 *     <tem:Product>{product}</tem:Product>
 *     <tem:XML><![CDATA[ {innerXml} ]]></tem:XML>
 *   </tem:{OP}>
 *
 * `innerXml` is the fully-rendered <Root> business payload, wrapped in CDATA
 * exactly as the kit's Postman samples do.
 */
function buildEnvelope({ operation, product, innerXml }) {
  const tem = config.fg.soapTempuri;
  return (
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="${tem}">`
    + '<soapenv:Header/>'
    + '<soapenv:Body>'
    + `<tem:${operation}>`
    + `<tem:Product>${escapeXml(product)}</tem:Product>`
    + `<tem:XML><![CDATA[${innerXml}]]></tem:XML>`
    + `</tem:${operation}>`
    + '</soapenv:Body>'
    + '</soapenv:Envelope>'
  );
}

/** The SOAPAction header for a BO-service operation. */
function boSoapAction(operation) {
  return soapAction(config.fg.soapTempuri, operation);
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  trimValues: true,
  // Namespace-agnostic: strip prefixes so s:Body and soap:Body both become Body.
  transformTagName: (tag) => tag.replace(/^[^:]+:/, ''),
});

/**
 * Parse a BO SOAP response into its inner <Root> document.
 *
 *   <s:Envelope><s:Body>
 *     <{Op}Response><{Op}Result> …inner Root XML, escaped or CDATA… </…Result>
 *   </s:Body></s:Envelope>
 *
 * A SOAP Fault is surfaced as an upstream failure rather than parsed.
 *
 * @returns {{ raw: object, inner: object }}
 */
function parseSoapResponse(soapXml, httpStatus) {
  if (!soapXml || typeof soapXml !== 'string') {
    throw parseError('Empty Future Generali SOAP response', { httpStatus });
  }

  let doc;
  try {
    doc = parser.parse(soapXml);
  } catch (error) {
    throw parseError('Future Generali SOAP response is not valid XML', {
      httpStatus, snippet: soapXml.slice(0, 300), cause: error.message,
    });
  }

  const body = deepGet(doc, ['Envelope', 'Body']);
  if (!body) {
    throw parseError('Future Generali SOAP response has no <Body>', {
      httpStatus, snippet: soapXml.slice(0, 300),
    });
  }

  if (body.Fault) {
    const faultString = body.Fault.faultstring ?? body.Fault.Reason?.Text ?? 'SOAP Fault';
    throw upstreamError(`Future Generali SOAP fault: ${textOf(faultString)}`, {
      httpStatus, fault: body.Fault,
    });
  }

  // The *Response → *Result node; the element name varies by operation.
  const responseNode = firstValueMatching(body, /Response$/);
  const resultRaw = responseNode ? firstValueMatching(responseNode, /Result$/) : undefined;

  if (resultRaw === undefined || resultRaw === null || resultRaw === '') {
    // An empty <…Result/> is FG's ONE generic rejection and it carries no
    // reason of its own. Observed live for all of:
    //   - a product not provisioned against the calling agent code
    //   - a missing or invalid VendorCode / AgentCode / BranchCode
    //   - a CoverType the product does not rate on (FHA sent 'VITAL')
    //   - FG's rating service being down while validation stayed up
    //     (2026-08-13: identical requests empty for minutes, then priced again
    //     with no change at either end)
    //
    // Naming one of those as THE cause is what sends someone chasing
    // provisioning for a fault that clears itself, so they are listed as
    // candidates and the transient case is called out first — it is the only
    // one worth retrying.
    throw parseError(
      'Future Generali returned an empty *Result — their generic rejection, with no reason '
      + 'attached. If an identical request worked recently, retry: their rating service '
      + 'answers this while it is down. Otherwise check that the product is provisioned for '
      + 'this agent code, that the CoverType is one the product rates on, and that '
      + 'FG_VENDOR_CODE / FG_AGENT_CODE / FG_BRANCH_CODE are correct.',
      { httpStatus, keys: Object.keys(body), retryable: true }
    );
  }

  return { raw: doc, inner: parseInnerRoot(String(resultRaw), httpStatus) };
}

function parseInnerRoot(innerXml, httpStatus) {
  const trimmed = innerXml.trim();
  // Some FG errors come back as a plain sentence rather than a document.
  if (!trimmed.startsWith('<')) return { Root: null, message: trimmed };
  try {
    return parser.parse(trimmed);
  } catch (error) {
    throw parseError('Future Generali inner <Root> XML is not valid XML', {
      httpStatus, snippet: trimmed.slice(0, 300), cause: error.message,
    });
  }
}

// ── Quote (ENQ) ─────────────────────────────────────────────────────────────

/**
 * Normalise an ENQ response.
 *
 * Verified against FG's live UAT service, which returns:
 *
 *   <Root><Policy>
 *     <InputParameters>…<BeneficiaryDetails><Member>…<BeneBasePremium>
 *     <OutputRes><BasePremium><PremiumAmt><ServiceTax><PremWithServTax><ErrorMsg>
 *   </Policy></Root>
 *
 * There is NO <Status> element on a successful ENQ — success is inferred from
 * an empty <ErrorMsg> plus a resolved premium. Failures instead use the flat
 * envelope <Root><Status>Fail</Status><ValidationError>…</ValidationError>.
 */
function extractQuote(inner) {
  const root = deepGet(inner, ['Root']) || {};
  const policy = root.Policy || {};
  const out = policy.OutputRes;

  const rootStatus = textOf(root.Status);
  const validationError_ = textOf(root.ValidationError);

  if (!out) {
    if (deepGet(policy, ['NewDataSet', 'Premium'])) return extractQuoteLegacy(policy);
    return {
      ...emptyQuote(),
      status: rootStatus || null,
      // FG's server-side faults arrive as text sitting DIRECTLY under <Root>,
      // with no element around it:
      //   <Root><Status>Fail</Status>The device is not ready.&#xD;</Root>
      // Without the last fallback that sentence is dropped and the caller sees
      // status 'Fail' with errorMessage null — the shape that says least about
      // a failure FG have actually explained.
      errorMessage: validationError_ || textOf(inner?.message) || bareText(root) || null,
    };
  }

  const errorMessage = textOf(out.ErrorMsg) || validationError_;
  // FG expose several premium totals; PremiumAmt is the payable base.
  const totalPremium = num(out.PremiumAmt) ?? num(out.TermPremium) ?? num(out.BasePremium);
  const ok = !errorMessage && totalPremium != null && !/^fail/i.test(rootStatus);

  const members = toArray(deepGet(policy, ['InputParameters', 'BeneficiaryDetails', 'Member']))
    .map((m) => ({
      memberId: textOf(m.MemberId) || null,
      name: textOf(m.InsuredName) || null,
      relationship: textOf(m.Relation) || null,
      gender: textOf(m.InsuredGender) || null,
      birthdate: textOf(m.InsuredDob) || null,
      age: num(m.Age),
      coverCode: textOf(m.CoverType) || null,
      occupation: textOf(m.InsuredOccpn) || null,
      sumInsured: num(m.SumInsured),
      premium: num(m.BeneBasePremium) ?? num(m.PerPrsnPremium),
      perPersonPremium: num(m.PerPrsnPremium),
    }));

  const discounts = {
    longTerm: num(out.LngTrmDisc), longTermRate: num(out.LngTrmDiscRate),
    family: num(out.FamilyDiscount), familyRate: num(out.FmlyDiscRate),
    employee: num(out.EmpDisc), employeeRate: num(out.EmpDiscRate),
    online: num(out.OnlineDisc), onlineRate: num(out.OnlineDiscRate),
    deductible: num(out.DeductDisc), deductibleRate: num(out.DeductDiscRate),
    installmentLoad: num(out.InstallLoad), installmentLoadRate: num(out.InstallLoadRate),
  };

  return {
    status: rootStatus || (ok ? 'Successful' : 'Fail'),
    ok,
    totalPremium,
    basePremium: num(out.BasePremium),
    termPremium: num(out.TermPremium),
    premiumWithoutServiceTax: num(out.PremWithoutServTax),
    premiumWithLoad: num(out.PremWithLoad),
    serviceTax: num(out.ServiceTax),
    serviceTaxRate: num(out.ServiceTaxRate),
    premiumWithServiceTax: num(out.PremWithServTax),
    keralaCess: num(out.KeralaCess),
    totalInstallments: num(out.TtlInstallment),
    // Sum of FG's individual discount fields (loadings excluded).
    totalDiscount: sumOf([discounts.longTerm, discounts.family, discounts.employee,
      discounts.online, discounts.deductible]),
    discounts,
    errorMessage: errorMessage || null,
    members,
  };
}

/**
 * The legacy <NewDataSet><Premium> shape. Retained as a defensive fallback for
 * other products and renewals; it has never been observed on UAT.
 */
function extractQuoteLegacy(policy) {
  const premium = deepGet(policy, ['NewDataSet', 'Premium']) || {};
  const status = textOf(premium.Status);
  // FG misspell "Details" as "Deatils"; accept both.
  const detailsNode = deepGet(policy, ['NewDataSet', 'PremiumDeatils'])
    ?? deepGet(policy, ['NewDataSet', 'PremiumDetails']);

  return {
    ...emptyQuote(),
    status: status || null,
    ok: /^success/i.test(status || ''),
    totalPremium: num(premium.TotalPremium),
    serviceTax: num(premium.ServiceTax),
    premiumWithServiceTax: num(premium.PremiumWithServiceTax),
    members: toArray(detailsNode).map((d) => ({
      relationship: textOf(d.Relationship) || null,
      gender: textOf(d.Gender) || null,
      birthdate: textOf(d.Birthdate) || null,
      coverCode: textOf(d.CoverCode) || null,
      sumInsured: num(d.SumInsured),
      premium: num(d.Premium),
    })),
  };
}

/**
 * Sum of the discount fields FG actually returned. Null — not 0 — when they
 * returned none, because "no discount was applied" and "FG did not price this"
 * are different answers and a 0 in the UI asserts the first.
 */
function sumOf(values) {
  const present = values.filter((value) => typeof value === 'number');
  if (!present.length) return null;
  return Number(present.reduce((a, b) => a + b, 0).toFixed(2));
}

function emptyQuote() {
  return {
    status: null, ok: false, totalPremium: null, basePremium: null, termPremium: null,
    premiumWithoutServiceTax: null, premiumWithLoad: null, serviceTax: null,
    serviceTaxRate: null, premiumWithServiceTax: null, keralaCess: null,
    totalInstallments: null, totalDiscount: null, discounts: {}, errorMessage: null,
    members: [],
  };
}

// ── Proposal / issuance (CRT) ───────────────────────────────────────────────

/**
 * Normalise a CRT response.
 *
 * HealthPreCRTValidate returns a flat envelope:
 *   <Root><Status>Fail</Status>
 *     <ValidationError>BancaChannel Value INVALID</ValidationError>
 *     <strPreCRTTranID>webaggbank-7A34710082026162402</strPreCRTTranID></Root>
 *
 * Issuance returns a multi-block document instead, recording everything FG
 * created:
 *   <Root><Client><Status/><ClientId/></Client>
 *         <Receipt><Status/><ReceiptNo/></Receipt>
 *         <Policy><Status/><PolicyNo/><Message/></Policy>
 *         <Application><WinNo/><ApplicationNo/></Application></Root>
 */
function extractPolicyResult(inner) {
  const root = deepGet(inner, ['Root']) || {};

  const policyBlock = root.Policy && root.Policy.Status !== undefined ? root.Policy : null;
  const ds = policyBlock || deepGet(root, ['Policy', 'NewDataSet']) || root;

  const status = textOf(ds.Status ?? root.Status);
  const policyNo = textOf(ds.PolicyNo ?? root.PolicyNo);

  // FG use <ValidationError> on the pre-CRT step, <Message> on issuance and
  // <ErrorMessage> elsewhere.
  const errorMessage =
    textOf(ds.ValidationError ?? root.ValidationError)
    || (policyBlock && !/^success/i.test(status) ? textOf(policyBlock.Message) : '')
    || textOf(ds.ErrorMessage ?? root.ErrorMessage)
    // As on the quote leg: a fault raised inside FG's own server comes back as
    // bare text under <Root> with no element to name it.
    || (/^fail/i.test(status || '') ? bareText(root) : '');

  const clientBlock = root.Client || {};
  const receiptBlock = root.Receipt || {};
  const appBlock = root.Application || {};

  // FG's client handshake: the first CRT call for a new customer creates the
  // client record and answers "Please retry with Client ID 80006820." The same
  // request must then be replayed with that value in <ClientID>.
  const retryClientId = (errorMessage.match(/Client\s*ID\s*(\d+)/i) || [])[1] || null;

  return {
    status: status || null,
    // HealthPreCRTValidate signals success with Status alone (no PolicyNo);
    // issuance additionally returns a PolicyNo.
    ok: /^success/i.test(status || ''),
    policyNo: policyNo || null,
    proposalNo: textOf(ds.ProposalNo) || null,
    preCrtTranId: textOf(ds.strPreCRTTranID ?? root.strPreCRTTranID) || null,
    retryClientId,
    errorMessage: errorMessage || null,
    // Records FG created along the way (issuance only).
    clientId: textOf(clientBlock.ClientId) || null,
    receiptNo: textOf(receiptBlock.ReceiptNo) || null,
    winNo: textOf(appBlock.WinNo) || null,
    applicationNo: textOf(appBlock.ApplicationNo) || null,
    message: policyBlock ? textOf(policyBlock.Message) || null : null,
  };
}

// ── Audit ───────────────────────────────────────────────────────────────────

/**
 * The exchange returned beside every FG answer — the URL, headers and complete
 * body that went upstream, and what came back.
 *
 * Deliberately NOT genericApi.service.js's buildExchange, which the ITGI
 * service imports: that one measures the request with
 * `Buffer.byteLength(JSON.stringify(body))`, which is right for a JSON body and
 * wrong for FG's, where the body is a SOAP envelope STRING. JSON-stringifying
 * it reports the escaped length and re-quotes the XML, so the one number an
 * operator uses to check a payload against FG's kit would be wrong. Nothing in
 * the NivaBupa or ITGI paths changes as a result — this is additive.
 */
function buildFgExchange({ url, headers, body, attempt = 0, response, error }) {
  const isText = typeof body === 'string';
  return {
    url,
    method: 'POST',
    requestHeaders: safeHeaders(headers),
    requestBodyBytes: isText
      ? Buffer.byteLength(body, 'utf8')
      : Buffer.byteLength(JSON.stringify(body ?? ''), 'utf8'),
    requestBody: body,
    attempts: attempt + 1,
    responseStatus: response?.status ?? error?.response?.status ?? null,
    responseHeaders: response?.headers ?? error?.response?.headers ?? null,
    responseBody: response?.data ?? error?.response?.data ?? null,
  };
}

/**
 * Fingerprint anything credential-shaped before it can reach a log or a
 * response body. FG's SOAP headers carry no secret, but the CKYC services send
 * a Bearer token and a static `token` header, and both go through here.
 */
function safeHeaders(headers = {}) {
  const out = {};
  for (const [name, value] of Object.entries(headers || {})) {
    if (/authorization|token|client-id|secret|password|key/i.test(name)) {
      out[name] = value ? `***set (${String(value).length} chars)***` : null;
    } else {
      out[name] = value;
    }
  }
  return out;
}

// ── small helpers ───────────────────────────────────────────────────────────

function deepGet(obj, path) {
  return path.reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

function firstValueMatching(obj, re) {
  const key = Object.keys(obj || {}).find((k) => re.test(k));
  return key ? obj[key] : undefined;
}

function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'object') return textOf(value['#text']);
  return String(value).trim();
}

/**
 * A node's own text, for the faults FG send as bare text under <Root>. Those
 * arrive double-escaped, so the line break survives one round of unescaping as
 * the literal characters "&#xD;" — "The device is not ready.&#xD;". Decoding
 * the numeric entities turns that back into whitespace and leaves the sentence,
 * which is what a caller shows and what an FG ticket quotes. Only whitespace
 * changes; nothing is reworded or dropped.
 */
function bareText(node) {
  return textOf(node)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .trim();
}

function num(value) {
  const text = textOf(value);
  if (text === '') return null;
  const parsed = Number(text);
  return Number.isNaN(parsed) ? null : parsed;
}

export {
  fgError,
  validationError,
  configError,
  upstreamError,
  parseError,
  requireFields,
  getPath,
  isEmpty,
  isDdMmYyyy,
  isDdMmYyyyDash,
  assert,
  escapeXml,
  buildEnvelope,
  boSoapAction,
  parseSoapResponse,
  extractQuote,
  extractPolicyResult,
  buildFgExchange,
  safeHeaders,
  textOf,
  num,
};
