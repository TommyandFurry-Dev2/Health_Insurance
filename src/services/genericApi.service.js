import axios from 'axios';
import config from '../config/env.js';
import { forAudit } from '../utils/sanitize.js';
import { getNivaBupaToken } from './nivabupaAuth.service.js';

// Never log a bearer token in full — a fingerprint is enough to answer the only
// question worth asking of it ("did these two calls use the same credential?"),
// without putting a live partner token in pm2's on-disk logs.
const fingerprint = (token) =>
  token ? `${token.slice(0, 8)}…${token.slice(-6)} (len=${token.length})` : '(none)';

// NivaBupa answers 429 / NBHI-IIP-INT--01 on a fraction of premium calls, and
// measurement shows it is NOT request-rate throttling: with a fixed 12s gap
// between calls the result still alternated 200/429, and every 429 came back
// after ~7.37s of Kong-reported upstream latency while every success returned in
// 2.7–5.5s. That constant is an internal timeout on their side surfacing under a
// misleading status code — no Retry-After or RateLimit-* header is sent, and the
// body is their own premium envelope (STATUS "False", empty ErrorList), which a
// real gateway throttle would never carry.
//
// So the same request retried moments later normally succeeds. Only 429 is
// retried: 4xx validation failures are deterministic and retrying them would
// just multiply load.
const RETRY_STATUSES = new Set([429]);

// Longer and jittered, replacing a first pass at 300/800ms. Since the failure is
// an upstream stall rather than a token bucket, a retry that lands 300ms later
// re-enters an engine that is still stuck; the delay has to give it room to
// drain, and the jitter keeps the four concurrent tier calls a search fires from
// retrying in lockstep. Worst case 7.4 + ~1.3 + 7.4 + ~3.9 + 7.4 ≈ 27s: inside
// this service's own 20s per-attempt timeout and the frontend's 60s one.
const RETRY_BASE_DELAYS_MS = [1000, 3000];
const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The envelope key differs per endpoint (premiumResponse / RESPONSE / bare), so
// look in whichever one is present rather than assuming premium's.
const upstreamMessageCode = (data) => {
  const envelope = data?.premiumResponse || data?.RESPONSE || data;
  return envelope?.STATUS_MESSAGE?.[0]?.MESSAGE_CODE || null;
};

// Redacts whichever credential header is actually present, rather than assuming
// one. The /api/generic/* family sends `Authorization: Bearer …`; the caseapi
// sends `access_token: …`. Hardcoding the first would invent a header the
// caseapi never sent and print its real token in full.
function safeHeaders(headers) {
  const output = {};
  for (const [name, value] of Object.entries(headers || {})) {
    const isCredential = /^(authorization|access_token)$/i.test(name);
    if (!isCredential) {
      output[name] = value;
      continue;
    }
    const bearer = /^Bearer\s+/i.exec(String(value));
    const raw = bearer ? String(value).slice(bearer[0].length) : String(value);
    output[name] = `${bearer ? 'Bearer ' : ''}${fingerprint(raw)}`;
  }
  return output;
}

// The same detail traceBlock prints, as data rather than text, so a controller
// can return it. Deliberately mirrors the log field-for-field: if the two ever
// disagree about what was sent, one of them is lying about the payload.
function buildExchange({ url, headers, body, attempt, response, error }) {
  return {
    url,
    method: 'POST',
    requestHeaders: safeHeaders(headers),
    requestBodyBytes: Buffer.byteLength(JSON.stringify(body ?? '')),
    // The identical object reference passed to axios, not a copy or a
    // re-serialisation — so what a caller reads here is what went on the wire.
    requestBody: body,
    attempts: attempt + 1,
    responseStatus: response?.status ?? error?.response?.status ?? null,
    responseHeaders: response?.headers ?? error?.response?.headers ?? null,
    responseBody: response?.data ?? error?.response?.data ?? null,
  };
}

// Renders one labelled block per call. Built as a single string and printed
// once, for two reasons: console.log on an object abbreviates deep structures
// with [Object] and long arrays with "... N more items", which would silently
// drop exactly the fields you are trying to compare; and concurrent calls
// interleave line-by-line output, which would shuffle two payloads together.
//
// The body is the same object reference handed to axios, stringified with no
// sanitising, so what appears here is what goes over the wire. Only the
// credential header is fingerprinted — it is a live partner secret, not a field
// of the payload, and pm2 keeps these logs on disk.
//
// ⚠️ The Data Push body carries PAN, Aadhaar, DOB and medical answers in the
// clear. That is the point of the trace, but it means these logs hold personal
// data: rotate or delete them once the payload comparison is done, and pass
// no `trace` option to turn it off for a given endpoint.
function traceBlock({ label, url, headers, body, response, error }) {
  const json = (value) => {
    try {
      return JSON.stringify(value, null, 2);
    } catch (stringifyError) {
      return `[unserializable: ${stringifyError.message}]`;
    }
  };

  const lines = [
    '',
    `========== ${label} ==========`,
    'URL:',
    url,
    '',
    'Request Headers:',
    json(safeHeaders(headers)),
    '',
    `Request Body (${Buffer.byteLength(JSON.stringify(body ?? ''))} bytes):`,
    json(body),
  ];

  // Present on the response pass, absent on the pre-send pass — so the same
  // renderer produces both and the request half is guaranteed identical.
  if (response || error) {
    const status = response?.status ?? error?.response?.status ?? '(no response)';
    const responseHeaders = response?.headers ?? error?.response?.headers ?? null;
    const responseBody = response?.data ?? error?.response?.data ?? null;

    lines.push(
      '',
      'Response Status:',
      String(status),
      '',
      'Response Headers:',
      json(responseHeaders),
      '',
      'Response Body:',
      json(responseBody)
    );

    // A transport failure has no response at all; without this the block would
    // end in three nulls with nothing saying why.
    if (error && !error.response) {
      lines.push('', 'Transport error (no HTTP response):', `${error.code || ''} ${error.message}`.trim());
    }
  }

  lines.push('='.repeat(label.length + 22), '');
  console.log(lines.join('\n'));
}

// Premium/UW/Data Push all share the same auth (Bearer token + clientId
// header) and forwarding shape — only the target URL and body differ.
//
// `trace` names an endpoint whose full request/response exchange is printed on
// every call, regardless of the debug flag. Data Push uses it: its payload is
// the one that has to be diffed field-by-field against NivaBupa's dictionary
// when they reject it.
//
// `returnExchange` additionally resolves with { data, exchange } instead of the
// bare response body, so a controller can put the same detail in its own HTTP
// response. Server logs answer "what did we send?" only for whoever can read
// the server; this answers it in the browser's Network tab, next to the reply.
//
// `timeout` overrides the shared per-attempt budget for endpoints that legitimately
// take longer than a compute-and-answer call.
async function forwardToNivaBupa(url, body, { trace = null, returnExchange = false, timeout = null } = {}) {
  const token = await getNivaBupaToken();
  const clientId = config.nivabupa.clientId;

  const headers = {
    'Authorization': `Bearer ${token}`,
    'clientId': clientId,
    'Content-Type': 'application/json'
  };

  if (trace) {
    // Before the request goes out, so the payload survives in the log even if
    // the call then hangs, times out, or the process dies mid-flight.
    traceBlock({ label: `${trace} — REQUEST`, url, headers, body });
  } else if (config.nivabupa.debug) {
    console.log('\n────────── NivaBupa request ──────────');
    console.log('URL           :', url);
    console.log('Method        :', 'POST');
    console.log('Headers       :', { ...headers, Authorization: `Bearer ${fingerprint(token)}` });
    console.log('Content-Length:', Buffer.byteLength(JSON.stringify(body ?? '')));
    console.log('Payload       :', JSON.stringify(forAudit(body), null, 2));
  }

  for (let attempt = 0; ; attempt++) {
    try {
      const response = await axios.post(url, body, {
        headers,
        timeout: timeout ?? config.timeouts.api,
      });

      if (trace) {
        traceBlock({ label: trace, url, headers, body, response });
      } else if (config.nivabupa.debug) {
        console.log('────────── NivaBupa response ─────────');
        console.log('Status :', response.status);
        console.log('Attempt:', attempt + 1);
        console.log('Headers:', response.headers);
        console.log('Body   :', JSON.stringify(forAudit(response.data), null, 2));
        console.log('──────────────────────────────────────\n');
      }

      if (returnExchange) {
        return { data: response.data, exchange: buildExchange({ url, headers, body, attempt, response }) };
      }
      return response.data;
    } catch (error) {
      const status = error.response?.status;
      const upstreamMs = error.response?.headers?.['x-kong-upstream-latency'];
      const canRetry = RETRY_STATUSES.has(status) && attempt < RETRY_BASE_DELAYS_MS.length;

      // Printed per attempt, including ones that are about to be retried: when
      // NivaBupa rejects a payload the rejection body is the thing to read
      // beside the payload that caused it, and a retry that later succeeds
      // would otherwise erase the evidence of what the first one said.
      if (trace) {
        traceBlock({
          label: `${trace} — FAILED (attempt ${attempt + 1})`,
          url, headers, body, error,
        });
      }

      // Attached to every error, retryable or not, so the controller's own
      // error response can carry the payload NivaBupa rejected. The wrapped
      // 429 error below copies it across too.
      if (returnExchange) {
        error.exchange = buildExchange({ url, headers, body, attempt, error });
      }

      if (canRetry) {
        const delay = jitter(RETRY_BASE_DELAYS_MS[attempt]);
        console.warn(
          `⚠️  NivaBupa ${status} on ${url} (upstream ${upstreamMs ?? '?'}ms, ` +
            `code ${upstreamMessageCode(error.response?.data) ?? 'none'}) ` +
            `— retrying in ${delay}ms [attempt ${attempt + 2}/${RETRY_BASE_DELAYS_MS.length + 1}]`
        );
        await sleep(delay);
        continue;
      }

      // Logged in full whether or not debug is on. The controllers persist the
      // failure to api_transactions, but the reason a call was rejected lives in
      // error.response.data, not error.message — without this, both an upstream
      // throttle and a field-validation rejection read only as
      // "Request failed with status code NNN" in the logs.
      console.error('────────── NivaBupa call FAILED ──────');
      console.error('URL          :', url);
      console.error('attempts     :', attempt + 1);
      console.error('error.message:', error.message);
      console.error('error.code   :', error.code);
      console.error('status       :', status);
      console.error('resp headers :', error.response?.headers);
      console.error('resp data    :', JSON.stringify(forAudit(error.response?.data ?? null), null, 2));
      console.error('──────────────────────────────────────');

      // A 429 that survived every retry must not be reported as a rate limit,
      // because it is not one (see the RETRY_STATUSES note above). axios's own
      // message — "Request failed with status code 429" — is all the controllers
      // have to put in the caller's `message` field, and it has repeatedly sent
      // people hunting for throttling, a bad token or a malformed payload when
      // the cause is an intermittent stall inside NivaBupa's pricing engine.
      // Replace the message with what actually happened and keep `.response`
      // intact so the controllers still persist and forward NivaBupa's own body
      // unchanged.
      if (RETRY_STATUSES.has(status)) {
        const code = upstreamMessageCode(error.response?.data);
        const wrapped = new Error(
          `Niva Bupa could not price this request: their gateway answered ${status} on all ` +
            `${attempt + 1} attempts${code ? ` (${code})` : ''}` +
            `${upstreamMs ? `, ~${upstreamMs}ms upstream` : ''}. ` +
            'This is an intermittent internal timeout on their side — not a rate limit, ' +
            'not a rejected payload. The same request usually succeeds on a fresh try.'
        );
        wrapped.response = error.response;
        wrapped.code = error.code;
        wrapped.cause = error;
        wrapped.upstreamStatus = status;
        wrapped.attempts = attempt + 1;
        wrapped.retryable = true;
        wrapped.exchange = error.exchange;
        throw wrapped;
      }

      throw error;
    }
  }
}

// Pass-through: the caller sends the exact Reassure 3.0 premium request shape
// (policyTerm, coverageType, sumInsured, member[], policyAdjustmentList[], ...
// per the Premium Data Dictionary), this just attaches auth and forwards it.
//
// Resolves { data, exchange } rather than the bare envelope — see
// returnExchange in forwardToNivaBupa. The controller unwraps `data` for its
// existing callers and returns `exchange` alongside it, so the exact body that
// went upstream (including policyAdjustmentList / memberAdjustmentList, which
// the browser cannot otherwise confirm survived this hop) is readable in the
// Network tab beside NivaBupa's reply.
function getPremium(payload) {
  return forwardToNivaBupa(config.nivabupa.premiumUrl, payload, { returnExchange: true });
}

// Pass-through: caller sends the UW request shape (Proposal.POLICY / NOMINEE
// / MEMBER[] / PROPOSER, per UW request.txt) — same auth/forward mechanics
// as Premium.
//
// Also resolves { data, exchange } — same reason as getPremium above. This is
// the call whose payload the controller mutates before sending (the business
// defaults in helpers/proposal.helper.js), so what the browser posted and what
// went upstream are deliberately not the same object.
function getUwDecision(payload) {
  return forwardToNivaBupa(config.nivabupa.uwDecisionUrl, payload, { returnExchange: true });
}

// Pass-through: caller sends the full proposal payload (per data push
// dictionary.xlsx) — pushes it to NivaBupa and returns their
// { RESPONSE: { STATUS, POLICY_CODE, STATUS_MESSAGE } } envelope.
//
// Traced unconditionally: this is the payload that has to be compared field by
// field against NivaBupa's dictionary whenever they reject a proposal, and the
// call happens once per policy — not per keystroke — so the log volume is fine.
// Resolves { data, exchange } rather than the bare envelope — see
// returnExchange in forwardToNivaBupa. The controller unwraps `data` for its
// existing callers and returns `exchange` alongside it.
//
// Deliberately NOT added to RETRY_STATUSES, and deliberately not retried on
// timeout. Premium is a pure read, so replaying it is free; this call creates a
// proposal. A timeout means the outcome is unknown, not that it failed — a blind
// replay is how one payment becomes two proposals. Reconcile with
// /nivabupa/proposal-status on SOURCING_APPNO instead of resending.
function submitDataPush(payload) {
  return forwardToNivaBupa(config.nivabupa.dataPushUrl, payload, {
    trace: 'DATAPUSH API',
    returnExchange: true,
    timeout: config.timeouts.dataPush,
  });
}

// traceBlock/buildExchange are exported for caseApi.service.js, which talks to a
// different host with a different credential but needs the identical "show me
// what went out beside what came back" treatment. Kept here rather than moved to
// a util so there is one definition of that format, not two that can drift.
export { forwardToNivaBupa, getPremium, getUwDecision, submitDataPush, traceBlock, buildExchange };
