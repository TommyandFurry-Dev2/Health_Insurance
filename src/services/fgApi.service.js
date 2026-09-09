import axios from 'axios';

import config, { missingFgVariables } from '../config/env.js';
import {
  SOAP_OP, METHOD, PRODUCTS, sellableProductKeys, unimplementedProductNames,
} from '../constants/fg.constants.js';
import {
  fgError, validationError, configError, upstreamError,
  buildEnvelope, boSoapAction, parseSoapResponse,
  extractQuote, extractPolicyResult, buildFgExchange, safeHeaders,
} from '../helpers/fg.helper.js';
import { buildRootXml, genUid } from '../helpers/fgXml.helper.js';
import { validateCodedFields } from '../helpers/fgCodes.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Transport for Future Generali's TCS "BO" SOAP service, plus the three
// business operations that ride on it.
//
// One endpoint, two SOAP operations, and the business step chosen by the
// combination of operation + the <METHOD> tag inside the payload:
//
//   getQuote       → CreatePolicy         METHOD=ENQ
//   createProposal → HealthPreCRTValidate METHOD=CRT
//   issuePolicy    → CreatePolicy         METHOD=CRT + a filled Receipt
//
// Unlike NivaBupa there is no token service, nothing to cache and nothing to
// refresh: FG identify the caller by VendorCode / AgentCode / BranchCode inside
// the payload itself.
//
// Every environment-dependent value is read from config.fg, which reads the
// environment and has no bundled host or code of any kind. A process that was
// never given them cannot reach FG: assertConfigured() throws a 503 naming the
// missing variables, which is the failure an operator can act on.
// ─────────────────────────────────────────────────────────────────────────────

// Retried only on a transport failure or a gateway-level 5xx — never on a 4xx,
// and never on a 200 whose payload carried a business rejection, which is
// deterministic and would only repeat.
//
// Nor on issuance: see issuePolicy.
const RETRYABLE_STATUSES = new Set([502, 503, 504]);
const RETRYABLE_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED',
]);

const RETRY_BASE_DELAY_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The four variables without which no FG call can be made. Checked per call
 * rather than at boot so an FG-less deployment still starts and serves NivaBupa
 * and IFFCO Tokio — only the /future-generali endpoints answer 503.
 */
function assertConfigured() {
  const missing = missingFgVariables();
  if (missing.length > 0) {
    throw configError(
      `Future Generali is not configured. Set ${missing.join(', ')} in the environment.`,
      { missing }
    );
  }
}

/** `${boBaseUrl}${boServicePath}` — the only place the BO URL is built. */
function endpoint() {
  return `${config.fg.boBaseUrl}${config.fg.paths.boService}`;
}

/**
 * Resolve a product key, refusing anything FG no longer write.
 *
 * A discontinued product does not fail loudly upstream — FG answer with an
 * empty *Result, which reads as a provisioning or credential problem and sends
 * an operator chasing the wrong thing. Failing here names the actual cause and
 * what to use instead.
 */
function resolveProduct(productKey) {
  const definition = PRODUCTS[productKey];
  const sellable = sellableProductKeys();

  if (!definition) {
    throw validationError(
      `Unknown Future Generali product "${productKey}". Valid: ${sellable.join(', ')}`,
      'product',
      { got: productKey, valid: sellable }
    );
  }
  if (definition.discontinued) {
    const pending = unimplementedProductNames();
    throw validationError(
      `Future Generali product "${productKey}" cannot be used for new business: `
      + `${definition.discontinued}. Implemented alternatives: ${sellable.join(', ')}. `
      + `Also offered by Generali Central but not implemented here: ${pending.join(', ')}.`,
      'product',
      { got: productKey, discontinued: true, valid: sellable, pendingImplementation: pending }
    );
  }
  return definition;
}

function isRetryable(error) {
  if (RETRYABLE_CODES.has(error?.code)) return true;
  return RETRYABLE_STATUSES.has(error?.response?.status);
}

/**
 * One SOAP call to the BO service.
 *
 * Resolves { inner, exchange, httpStatus } — never the bare body — because
 * every FG controller returns the exchange beside the answer, the same way the
 * NivaBupa and ITGI ones do. That is not decoration here: FG's single generic
 * rejection is an EMPTY *Result with no reason attached, so the payload that
 * produced one is the only thing that makes it diagnosable at all.
 */
async function callFg({ operation, product, innerXml, timeoutMs = null, maxRetries = 1 }) {
  assertConfigured();

  const url = endpoint();
  const envelope = buildEnvelope({ operation, product, innerXml });
  const action = boSoapAction(operation);
  const headers = {
    'Content-Type': 'text/xml; charset=utf-8',
    SOAPAction: action,
  };
  const timeout = timeoutMs ?? config.timeouts.fg;
  const attemptsAllowed = maxRetries + 1;

  if (config.fg.debug) {
    console.log('\n────────── FG SOAP request ───────');
    console.log('Operation :', `${operation}(${product})`);
    console.log('URL       :', url);
    console.log('SOAPAction:', action);
    console.log('Bytes     :', Buffer.byteLength(envelope, 'utf8'));
    console.log('Envelope  :', envelope);
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.post(url, envelope, {
        headers,
        timeout,
        // Read the body ourselves: a SOAP Fault arrives as HTTP 500 WITH an
        // envelope and carries the only useful description of the failure, so
        // an axios throw on status would discard exactly the part worth having.
        validateStatus: () => true,
        // FG answer XML. Without this axios sniffs the body and can hand back a
        // parsed object, which the SOAP parser cannot read.
        responseType: 'text',
        transformResponse: [(data) => data],
      });

      const bodyText = typeof response.data === 'string' ? response.data : String(response.data ?? '');
      const exchange = buildFgExchange({ url, headers, body: envelope, attempt, response });

      if (config.fg.debug) {
        console.log('────────── FG SOAP response ──────');
        console.log('Status :', response.status);
        console.log('Attempt:', attempt + 1);
        console.log('Bytes  :', bodyText.length);
        console.log('Body   :', bodyText.slice(0, 4000));
        console.log('──────────────────────────────────\n');
      }

      // A gateway-level 5xx is retried HERE, before parsing, and the placement
      // is load-bearing: `validateStatus: () => true` means axios never throws
      // for a status, so a 502/503/504 would otherwise never reach the retry
      // logic in the catch block.
      //
      // Only when the operation allows it — issuePolicy passes maxRetries 0, so
      // a 503 there stops with its outcome unknown rather than being replayed
      // into a second policy.
      if (RETRYABLE_STATUSES.has(response.status) && attempt < attemptsAllowed - 1) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `⚠️  FG ${operation} answered HTTP ${response.status} — retrying in ${delay}ms `
          + `[attempt ${attempt + 2}/${attemptsAllowed}]`
        );
        await sleep(delay);
        continue;
      }

      // A non-200 WITHOUT a SOAP envelope is the transport answering, not FG's
      // service. Handing it to the SOAP parser turns an endpoint fault into
      // "empty response", which reads like a payload problem and loses the one
      // fact worth having — the status FG's web tier returned.
      //
      // This is the shape a POST over https produces on the UAT host: FG bind
      // the BO service to http only, so https serves the .svc help page on GET
      // (the URL looks alive) and answers every POST with a zero-byte 404.
      if (response.status !== 200 && !/<[^>]*Envelope/i.test(bodyText)) {
        const error = upstreamError(
          `Future Generali's BO service returned HTTP ${response.status} with no SOAP body for `
          + `${operation} at ${url}. If this is a zero-byte 404 over https, the service is bound `
          + 'to http only — check the scheme on FG_BO_BASE_URL.',
          {
            httpStatus: response.status,
            endpoint: url,
            soapAction: action,
            bytes: bodyText.length,
            snippet: bodyText.slice(0, 300) || null,
          }
        );
        error.exchange = exchange;
        throw error;
      }

      try {
        const parsed = parseSoapResponse(bodyText, response.status);
        return { inner: parsed.inner, raw: parsed.raw, exchange, httpStatus: response.status };
      } catch (rejection) {
        rejection.exchange = exchange;
        throw rejection;
      }
    } catch (error) {
      // A failure this function already classified — never retryable, and its
      // exchange is attached. Nothing to add.
      if (error.provider === 'fg') throw error;

      const canRetry = isRetryable(error) && attempt < attemptsAllowed - 1;
      if (canRetry) {
        const delay = RETRY_BASE_DELAY_MS * 2 ** attempt;
        console.warn(
          `⚠️  FG ${operation} failed (${error.code || error.response?.status}) — `
          + `retrying in ${delay}ms [attempt ${attempt + 2}/${attemptsAllowed}]`
        );
        await sleep(delay);
        continue;
      }

      // Logged in full whether or not debug is on — the reason a call failed
      // lives in the response body, not in error.message.
      console.error('────────── FG call FAILED ────────');
      console.error('operation    :', operation);
      console.error('URL          :', url);
      console.error('attempts     :', attempt + 1);
      console.error('error.message:', error.message);
      console.error('error.code   :', error.code);
      console.error('status       :', error.response?.status);
      console.error('──────────────────────────────────');

      const timedOut = error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
      const wrapped = fgError(
        timedOut
          ? `Future Generali ${operation} timed out after ${timeout}ms`
          : `Future Generali ${operation} failed: ${error.message}`,
        {
          status: timedOut ? 504 : 502,
          code: timedOut ? 'FG_TIMEOUT_ERROR' : 'FG_UPSTREAM_ERROR',
          details: {
            errorCode: error.code || null,
            httpStatus: error.response?.status ?? null,
            endpoint: url,
          },
        }
      );
      wrapped.cause = error;
      wrapped.timedOut = timedOut;
      wrapped.exchange = buildFgExchange({ url, headers, body: envelope, attempt, error });
      throw wrapped;
    }
  }
}

// ── Operations ──────────────────────────────────────────────────────────────

/**
 * Premium enquiry (ENQ). A pure read: nothing is created at FG, so it is the
 * only FG call that is safe to retry, and callFg's default retry applies.
 *
 * @param {object} input { product, policy, client, risk }
 */
async function getQuote(input = {}) {
  assertConfigured();
  const productDef = resolveProduct(input.product);
  const innerXml = buildRootXml({ ...input, method: METHOD.ENQUIRY, productDef });

  const { inner, exchange, httpStatus } = await callFg({
    operation: SOAP_OP.CREATE_POLICY,
    product: productDef.product,
    innerXml,
  });

  const quote = extractQuote(inner);
  console.log(
    `[fg] quote parsed — product=${productDef.product} status=${quote.status} `
    + `premium=${quote.totalPremium}`
  );

  return { data: quote, request: innerXml, exchange, httpStatus, product: productDef };
}

/**
 * Run a CRT-method call, transparently completing FG's client handshake.
 *
 * For a customer FG have not seen before, the FIRST CRT call creates the client
 * record and FAILS with "Please retry with Client ID <n>." The same request
 * must then be replayed with that value in <ClientID>. That happens here, once,
 * automatically, so a caller sees one logical operation rather than a failure
 * they are expected to know how to interpret.
 */
async function crtCall(operation, productDef, rawInput, { timeoutMs = null, maxRetries = 1 } = {}) {
  // Coded fields are checked HERE, once, before the handshake loop — so a bad
  // occupation or relation costs no round trip, and the normalised nominee
  // relation reaches both attempts.
  //
  // CRT only. FG check none of this on a quote and price the risk regardless,
  // so enforcing it there would break quoting to fix proposals. That is also
  // why the failure lands here rather than earlier: this is the first request
  // whose outcome actually depends on the codes.
  const input = validateCodedFields(rawInput, METHOD.CREATE);

  // UAT test switch — see config.fg.suppressClientIdOnCrt. OFF: this behaves
  // exactly as FG document. ON: <ClientID> is left EMPTY on every attempt,
  // including the replay that follows FG's own instruction to populate it. The
  // handshake is still detected, still logged and still triggers the retry —
  // only the value is withheld from the wire.
  const suppress = config.fg.suppressClientIdOnCrt;

  const send = async (clientId) => {
    let payload;

    if (suppress) {
      // A fresh Uid per attempt — FG reject a repeat with "UID Duplicate", and
      // the retry is a second attempt, so it must not reuse the first's.
      payload = { ...input, policy: { ...input.policy, uid: genUid(), clientId: '' } };
    } else {
      payload = clientId ? { ...input, policy: { ...input.policy, clientId } } : input;
    }

    const innerXml = buildRootXml({ ...payload, method: METHOD.CREATE, productDef });
    const res = await callFg({
      operation, product: productDef.product, innerXml, timeoutMs, maxRetries,
    });

    if (suppress) {
      console.log(
        `[fg] CRT attempt with ClientID SUPPRESSED — operation=${operation} `
        + `clientIdFromHandshake=${clientId || 'none'} `
        + `onWire=${(innerXml.match(/<ClientID>[^<]*<\/ClientID>/) || [])[0]}`
      );
    }

    return { ...res, request: innerXml, result: extractPolicyResult(res.inner) };
  };

  let res = await send(input.policy?.clientId);
  let clientId = input.policy?.clientId || null;

  if (!res.result.ok && res.result.retryClientId && !clientId) {
    clientId = res.result.retryClientId;
    console.log(
      `[fg] retrying CRT with the FG-issued ClientID — operation=${operation} `
      + `clientId=${clientId} actuallySending=${suppress ? 'EMPTY (suppressed for test)' : clientId}`
    );
    res = await send(clientId);
  }

  return { ...res, clientId };
}

/**
 * Validate and register the full proposal (HealthPreCRTValidate, METHOD=CRT).
 *
 * Retried at the transport level only, like the quote: HealthPreCRTValidate
 * VALIDATES, it does not create a policy, so a replayed 5xx cannot produce a
 * duplicate policy. It can produce a duplicate client record on FG's side via
 * the handshake, which is why the handshake replay itself happens exactly once.
 *
 * @param {object} input { product, policy, client, risk, receipt?, posMisp? }
 */
async function createProposal(input = {}) {
  assertConfigured();
  const productDef = resolveProduct(input.product);

  const { result, request, exchange, httpStatus, clientId } = await crtCall(
    SOAP_OP.PRE_CRT_VALIDATE, productDef, input
  );

  console.log(
    `[fg] proposal parsed — product=${productDef.product} status=${result.status} `
    + `preCrtTranId=${result.preCrtTranId}`
  );

  return { data: result, request, exchange, httpStatus, clientId, product: productDef };
}

/**
 * Issue the policy after payment (CreatePolicy, METHOD=CRT + a filled Receipt).
 *
 * ⚠️ NOT retried, on anything, including a timeout. A quote is a pure read and a
 * proposal only validates, but this WRITES a policy, a receipt and an
 * application at FG's end against money that has already been collected. A
 * timeout means the outcome is UNKNOWN, not that it failed — and a blind replay
 * is how one premium becomes two policies. The payment service records that
 * case as `unresolved` and refuses to retry it automatically; only a deliberate
 * human `force` gets past it.
 *
 * Given the longer issuance budget for the same reason: measured on UAT
 * 2026-08-17, a real issuance did not answer within 30s at all.
 *
 * @param {object} input { product, policy, client, risk, receipt }
 */
async function issuePolicy(input = {}) {
  assertConfigured();
  const productDef = resolveProduct(input.product);

  if (!input.receipt || input.receipt.amount == null || input.receipt.amount === '') {
    throw validationError(
      'Issuance requires receipt.amount — the premium actually paid.',
      'receipt.amount'
    );
  }

  const { result, request, exchange, httpStatus, clientId } = await crtCall(
    SOAP_OP.CREATE_POLICY, productDef, input,
    { timeoutMs: config.timeouts.fgIssuance, maxRetries: 0 }
  );

  console.log(
    `[fg] issuance parsed — product=${productDef.product} status=${result.status} `
    + `policyNo=${result.policyNo}`
  );

  return { data: result, request, exchange, httpStatus, clientId, product: productDef };
}

export {
  assertConfigured,
  endpoint,
  resolveProduct,
  callFg,
  getQuote,
  createProposal,
  issuePolicy,
  safeHeaders,
};
