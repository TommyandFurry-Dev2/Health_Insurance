import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import config from '../config/env.js';
import { encryptPaymentParams, decryptPaymentReturn } from '../services/soap.service.js';
import { PAYMENT_DEFAULTS } from '../constants/payment.constants.js';
import * as journeyService from '../services/journey.service.js';
import * as logRepo from '../repositories/log.repository.js';
import { JOURNEY_STEPS } from '../constants/journey.constants.js';
import {
  findMissingMandatoryFields,
  buildPaymentQuerystring,
  logPaymentPlaintext,
  parseReturnMessage,
  buildSafeCallbackErrorMessage,
} from '../helpers/payment.helper.js';

// Builds and encrypts the payment querystring (`encparam`). The frontend
// takes the response and auto-submits an HTML form POST to `gatewayUrl` —
// getPaymentValues.aspx is a redirect-based payment page, not a JSON API.
//
// The persisted journey_payments row created here is what makes the gateway
// callback recoverable: unqPolicyNumber is stored now so the callback, which
// arrives with no session of any kind, can be matched back to this journey.
export const initiatePayment = async (req, res) => {
  const startedAt = Date.now();
  const journeyId = req.journeyId;

  try {
    const body = {
      ...PAYMENT_DEFAULTS,
      returnPath: config.nivabupa.payment.returnUrl,
      ...req.body
    };

    const missing = findMissingMandatoryFields(body);
    if (missing.length > 0) {
      // Validation failures have no api_transactions row of their own (nothing
      // was called upstream), so they go on journey_events as an ERROR — this
      // is the case the schema's "no separate error_logs table" note covers.
      await journeyService.safeSave('paymentValidation', () => logRepo.recordError({
        journeyId,
        toStep: JOURNEY_STEPS.PAYMENT_INITIATED,
        message: 'payment/initiate rejected: missing mandatory fields',
        errorCode: 'MISSING_FIELDS',
        errorMessage: missing.join(', '),
      }));

      return res.status(400).json({
        status: 'ERROR',
        message: `Missing required payment field(s): ${missing.join(', ')}`
      });
    }

    const querystring = buildPaymentQuerystring(body);
    logPaymentPlaintext(body, querystring);

    const encparam = await encryptPaymentParams(querystring);

    console.log('📥 NivaBupa payment/initiate — final encparam:', encparam);

    const payment = await journeyService.recordPaymentInitiate({
      journeyId,
      body,
      querystring,
      encparam,
      gatewayUrl: config.nivabupa.payment.gatewayUrl,
      httpSucceeded: true,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.payment.soapUrl,
      context: req.journeyContext,
    });

    return res.status(200).json({
      status: 'SUCCESS',
      encparam,
      gatewayUrl: config.nivabupa.payment.gatewayUrl,
      method: 'POST',
      ...(payment
        ? {
          journeyId: req.journey.uuid,
          paymentAttempt: payment.attempt_no,
          unqPolicyNumber: payment.unq_policy_number,
        }
        : {}),
    });
  } catch (error) {
    console.error('❌ NivaBupa payment encryption failed:', error.response?.data || error.message);

    await journeyService.recordPaymentInitiate({
      journeyId,
      body: req.body,
      httpSucceeded: false,
      durationMs: Date.now() - startedAt,
      endpointUrl: config.nivabupa.payment.soapUrl,
      errorMessage: error.message,
      context: req.journeyContext,
    });

    return res.status(502).json({
      status: 'ERROR',
      message: error.message,
      nivabupa_response: error.response?.data || null
    });
  }
};

// NivaBupa POSTs here (the URL registered as `returnPath`) once payment
// completes, with an encrypted `returnMessage`. This request IS the buyer's
// browser being carried back from NivaBupa's payment page (see
// initiatePayment's comment — the frontend auto-submitted a form POST to get
// there), so the response has to be a redirect back into the SPA, not a raw
// JSON body — returning JSON here would leave the buyer looking at plain
// text instead of the app.
//
// Persistence changes what this hand-off can carry. Previously every field the
// return page needed had to travel in the redirect query string because nothing
// was stored. Now the payment outcome is written to journey_payments first and
// the redirect also carries journeyId + resumeToken, so the SPA rehydrates the
// whole journey on landing instead of rebuilding it from four query params. The
// original query params are still sent, unchanged, so an existing return page
// keeps working.
// TEMPORARY (2026-08-05) — see captureCiphertext below. Pulls returnMessage out
// of the raw request bytes rather than the parsed body. decodeURIComponent
// resolves percent-escapes but leaves a literal '+' alone, which is exactly the
// difference being hunted: form-encoding says '+' means space, so a base64
// ciphertext posted with an unescaped '+' reaches req.body with spaces in those
// positions and can never decrypt. req.rawBody is captured by the verify hook
// in routes/index.js.
function extractRawReturnMessage(req) {
  if (!req.rawBody || !req.rawBody.length) return null;
  const raw = req.rawBody.toString('utf8');
  const match = raw.match(/(?:^|&)(?:returnMessage|encResp|cipherText)=([^&]*)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1]; // malformed percent-escape — keep the original bytes
  }
}

// TEMPORARY (2026-08-05) — writes the callback ciphertext to disk so it can be
// replayed against decResp without anyone copy-pasting a base64 blob out of a
// terminal, which is itself a way to corrupt it. Re-capturing costs a real
// payment each time, so the capture has to be right first go.
//
// returnmessage.txt is what the replay script's --file flag expects; the
// timestamped copy keeps a second attempt from overwriting the first. Only the
// encrypted blob is written — it decrypts to payment status fields, not
// plaintext PII — but delete these files once the cause is confirmed.
function captureCiphertext({ parsedValue, rawValue }) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const write = (file, value) => {
    try {
      writeFileSync(join(process.cwd(), file), value, 'utf8');
      console.log(`   📝 wrote ${file} (${value.length} chars)`);
    } catch (error) {
      console.error(`   ⚠️ could not write ${file}: ${error.message}`);
    }
  };
  // No trailing newline — a stray one inside a base64 value changes what gets sent.
  if (parsedValue) {
    write('returnmessage.txt', String(parsedValue));
    write(`returnmessage-${stamp}.txt`, String(parsedValue));
  }
  // Written only when it differs, so its existence alone is the signal that the
  // parsed value was mangled in transit.
  if (rawValue && rawValue !== String(parsedValue)) {
    write('returnmessage.raw.txt', rawValue);
  }
}

export const handlePaymentReturn = async (req, res) => {
  const startedAt = Date.now();
  const frontendUrl = config.frontendUrl;
  // Default '/nivabupa-return' (FRONTEND_RETURN_PATH) — the SPA route that
  // reads the payment outcome off the query string this handler builds.
  const returnPath = config.frontendReturnPath;

  // Logged verbatim, before any processing/decryption — req.body/req.query
  // are read but never mutated here, so this is exactly what NivaBupa sent.
  console.log('\n========== NivaBupa Callback Received ==========');
  console.log('Timestamp:', new Date().toISOString());
  console.log('Request URL:', req.originalUrl);
  console.log('HTTP Method:', req.method);
  console.log('Headers:', req.headers);
  console.log('Query Parameters:', req.query);
  console.log('Request Body:', req.body);
  console.log('Raw Callback Payload:', req.body && Object.keys(req.body).length ? req.body : req.query);
  // Which container it arrived in matters: a body value went through
  // express.urlencoded's decoder and a query value through Express's query
  // parser, and the two treat '+' differently.
  const bodyField = ['returnMessage', 'encResp', 'cipherText'].find((f) => req.body?.[f]);
  const queryField = ['returnMessage', 'encResp', 'cipherText'].find((f) => req.query?.[f]);
  const parsedValue = bodyField ? req.body[bodyField] : queryField ? req.query[queryField] : null;
  console.log('returnMessage source:', bodyField ? `body.${bodyField}` : queryField ? `query.${queryField}` : '(not found)');
  console.log('Encrypted returnMessage / cipherText:', parsedValue);

  const rawValue = extractRawReturnMessage(req);

  if (parsedValue) {
    const v = String(parsedValue);
    console.log('returnMessage length:', v.length, '| first 12:', v.slice(0, 12), '| last 12:', v.slice(-12));
    console.log('returnMessage base64-shaped:', /^[A-Za-z0-9+/=\r\n]+$/.test(v), '| length % 4 =', v.length % 4);
    if (v.includes(' ')) {
      console.warn('   ⚠️ contains spaces — a "+" was lost in URL decoding, which corrupts the ciphertext.');
    }
  } else {
    console.warn('   ⚠️ no returnMessage/encResp/cipherText found in body or query.');
  }

  if (rawValue && parsedValue && rawValue !== String(parsedValue)) {
    console.warn('   ⚠️ RAW BODY DIFFERS FROM PARSED VALUE — the parsed one is corrupted.');
    console.warn('      parsed length:', String(parsedValue).length, '| raw length:', rawValue.length);
    console.warn('      The decrypt below retries with the raw value if the parsed one fails.');
  }

  console.log('Content-Type:', req.headers['content-type']);
  captureCiphertext({ parsedValue, rawValue }); // TEMPORARY — remove with the two helpers above
  console.log('===============================================');

  const returnMessage = parsedValue;
  const rawCallback = req.body && Object.keys(req.body).length ? req.body : req.query;

  try {
    if (!returnMessage) {
      throw Object.assign(new Error('returnMessage missing from NivaBupa payment callback'), { noResponse: true });
    }

    // decResp API request/response (endpoint, SOAPAction, key, payload, HTTP
    // status, full SOAP response, parsed decRespResult) are all logged inside
    // callSoap() in services/soap.service.js — shared by every SOAP call so the
    // detail is identical whether this succeeds or throws a SOAP Fault.
    // The retry is the corruption test, run against the live service instead of
    // argued about: if the parsed value fails and the raw one succeeds, '+' was
    // eaten by form decoding and that is the whole bug — proven by the same key
    // decrypting the same payment a moment later. If both fail, corruption is
    // excluded and the key (or the IP) is what remains. Costs one extra SOAP
    // call only on a path that was already failing.
    let decrypted;
    try {
      decrypted = await decryptPaymentReturn(returnMessage);
    } catch (firstError) {
      if (!rawValue || rawValue === String(returnMessage)) throw firstError;
      console.warn('\n⚠️ decResp failed on the parsed returnMessage — retrying with the raw request bytes.');
      decrypted = await decryptPaymentReturn(rawValue);
      console.warn('✅ The raw value decrypted. The parsed body was corrupted by URL decoding;');
      console.warn('   the key is correct. Fix: read returnMessage from req.rawBody, not req.body.');
    }
    const parsed = parseReturnMessage(decrypted);

    console.log('\n----- Decrypted Payment Details -----');
    console.log('   Transaction ID:', parsed.paymentTransactionId);
    console.log('   Payment Status:', parsed.paymentStatus, '→', parsed.paymentStatusDescription);
    console.log('   Policy Number (uniqueReferenceId):', parsed.uniqueReferenceId);
    console.log('   Amount:', parsed.payablePremium);
    console.log('   Error/Failed Reason:', parsed.failedReason || null);
    console.log('   Full decrypted record:', parsed);

    // No separate "policy creation" step happens here — for this integration
    // the policy is created via Data Push, which the frontend's return page
    // fires once it lands back in the app. This stage confirms the gateway's
    // payment outcome and now also persists it: the journey is located by the
    // unqPolicyNumber stored at initiate time (the callback echoes it back as
    // uniqueReferenceId), which is the only identity this request carries.
    const saved = await journeyService.recordPaymentCallback({
      parsed,
      decrypted,
      rawBody: rawCallback,
      durationMs: Date.now() - startedAt,
      context: { ipAddress: req.ip || null },
    });

    console.log('\n----- Backend Processing -----');
    console.log('   Payment outcome confirmed for reference =', parsed.uniqueReferenceId);
    if (saved?.journey) {
      console.log('   Correlated to journey', saved.journey.uuid, '→ step', saved.journey.current_step);
    } else {
      console.log('   ⚠️  Not correlated to any journey — see api_transactions for the unmatched callback row.');
    }

    const query = new URLSearchParams({
      status: parsed.paymentStatusDescription,
      policyNumber: parsed.uniqueReferenceId || '',
      premium: parsed.payablePremium || '',
      // paymentTxnId is what the return page stamps onto Data Push as
      // PAYMENT_INFO.TRANSACTION_NUMBER, and paymentDate as PAYMENT_DATE —
      // Niva Bupa were receiving both blank because nothing carried the
      // gateway's own values past this redirect (observations, 2026-08-07).
      paymentTxnId: parsed.paymentTransactionId || '',
      paymentDate: parsed.transactionDateTime || '',
    });
    if (parsed.paymentStatusDescription !== 'SUCCESS' && parsed.failedReason) {
      query.set('message', parsed.failedReason);
    }
    // The resume pair. With these the return page calls
    // POST /nivabupa/journey/resume and gets the full journey back, so a buyer
    // whose browser lost its storage during the gateway round-trip still lands
    // in a restored app.
    if (saved?.journey) {
      query.set('journeyId', saved.journey.uuid);
      query.set('resumeToken', saved.journey.resume_token);
    }

    console.log('\n----- Final Callback Response (redirect to frontend) -----');
    console.log('   ', `${frontendUrl}${returnPath}?${query.toString()}`);

    return res.redirect(302, `${frontendUrl}${returnPath}?${query.toString()}`);
  } catch (error) {
    console.error('\n❌ NivaBupa payment return processing failed');
    // soapCause names which failure mode this was (WAF 406 / SOAP Fault / key
    // mismatch / timeout / TLS) — see classifyHttpFailure and
    // classifyTransportFailure in services/soap.service.js. Without it the log
    // showed a status code and left the diagnosis to whoever read it.
    console.error('   Cause:', error.soapCause || '(not a SOAP failure — see message below)');
    console.error('   Error message:', error.message);
    console.error('   HTTP status:', error.soapStatus ?? '(no response)');
    console.error('   Response headers:', error.soapResponseHeaders || null);
    console.error('   Error response data:', error.soapResponseData || error.response?.data || null);
    console.error('   Stack:', error.stack);
    if (error.cause) {
      console.error('   Underlying error:', error.cause.message);
      console.error('   Underlying stack:', error.cause.stack);
    }

    // A callback that arrived but could not be decrypted or parsed is the worst
    // case in this flow: money may have moved with no record linking it to a
    // journey. Persisting the raw body and the failure is what makes that
    // reconcilable instead of stdout-only.
    await journeyService.recordPaymentCallbackFailure({
      rawBody: rawCallback,
      errorMessage: error.message,
      errorStack: error.stack,
      referenceId: null,
    });

    const safeMessage = error.noResponse ? error.message : buildSafeCallbackErrorMessage(error);
    const query = new URLSearchParams({ status: 'ERROR', message: safeMessage });

    console.log('\n----- Final Callback Response (redirect to frontend) -----');
    console.log('   ', `${frontendUrl}${returnPath}?${query.toString()}`);

    return res.redirect(302, `${frontendUrl}${returnPath}?${query.toString()}`);
  }
};
