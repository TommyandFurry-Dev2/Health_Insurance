import express from 'express';
import cors from 'cors';

import config from '../config/env.js';
import db from '../db/index.js';
import auth_routes from './auth.routes.js';
import quote_routes from './quote.routes.js';
import proposal_routes from './proposal.routes.js';
import payment_routes from './payment.routes.js';
import case_routes from './case.routes.js';
import journey_routes from './journey.routes.js';
import itgi_routes from './itgi.routes.js';
import fg_routes from './fg.routes.js';
import icici_routes from './icici.routes.js';
import { resolveJourney } from '../middleware/journeyContext.js';
import { logRequest } from '../middleware/requestLogger.js';
import { errorHandler, notFound } from '../middleware/errorHandler.js';

// Every NivaBupa route lives under this one prefix, and so does every piece of
// middleware below — nothing in this router runs for a path outside it. That
// scoping is what lets the same router be mounted twice (at '/' and at the
// compatibility alias) without its middleware running twice for one request.
//
// The literal, not config.pathPrefix, because the route tables in the sibling
// *.routes.js files and the journey regex in middleware/journeyContext.js
// contain the same literal; config re-exports it for the payment-return
// default URL.
export const NIVABUPA_PATH_PREFIX = '/nivabupa';

// Every IFFCO Tokio route lives under this one prefix, and so does every piece
// of its middleware — the same scoping property NIVABUPA_PATH_PREFIX has, and
// for the same reason: it lets createItgiRouter() be mounted twice (at '/' and
// at the compatibility alias) without its middleware running twice.
//
// A literal, and not env-driven, for one more reason than the NivaBupa prefix
// has: it is the tail of the payment response URL REGISTERED WITH ITGI against
// our partner code —
//   https://<host>/health/iffcotokio/payment/return
// — so it is fixed on their side. An env var here could not change what they
// redirect to; it could only move this service's route away from it, which is
// precisely the failure that loses a policy number.
export const ITGI_PATH_PREFIX = '/iffcotokio';

// Every Future Generali route lives under this one prefix, and so does every
// piece of its middleware — the same scoping property the two prefixes above
// have, and for the same reason: it lets createFgRouter() be mounted twice (at
// '/' and at the compatibility alias) without its middleware running twice.
//
// A literal, not env-driven, for the same reason ITGI_PATH_PREFIX is not: it is
// the tail of the ResponseURL this service sends to FG's payment gateway on
// every payment, so an env var here could not change where FG post the outcome
// — it could only move this service's route away from it, which is precisely
// the failure that loses a paid buyer's WS_P_ID and PGID.
export const FG_PATH_PREFIX = '/future-generali';

// Every ICICI Lombard route lives under this one prefix, and so does every piece
// of its middleware — the same scoping property the three prefixes above have,
// and for the same reason: it lets createIciciRouter() be mounted twice (at '/'
// and at the compatibility alias) without its middleware running twice.
//
// A literal, not env-driven, like the others. Unlike ITGI and FG there is no
// payment callback behind it that an insurer holds a copy of — ICICI's hosted
// gateway returns the buyer to the SPA directly — so it is fixed only by the
// route table (routes/icici.routes.js) and the SPA's api/elevate.js.
export const ICICI_PATH_PREFIX = '/icici-lombard';

// verify: captures the exact raw bytes on req.rawBody before the body is
// decoded — kept from the original backend for diagnosing the NivaBupa
// payment/return callback (does not change parsing behavior for any route).
const captureRawBody = (req, res, buf) => { req.rawBody = buf; };

// `origins` defaults to the NivaBupa/global list, which is what every existing
// caller passes (none) — the parameter exists so the ITGI router can be given
// ITGI_CORS_ORIGINS when a deployment needs the two to differ. Behaviour with
// no argument is unchanged.
function corsOptions(origins = config.corsOrigins) {
  return origins === '*'
    ? {}
    : { origin: origins.split(',').map((o) => o.trim()).filter(Boolean) };
}

// The NivaBupa router, self-contained: its own CORS policy, its own body
// parsers and its own access log, all scoped to NIVABUPA_PATH_PREFIX.
//
// Three properties of this stack are load-bearing and must not be "tidied up"
// into an app-level equivalent:
//   * CORS — the journey endpoints use PATCH and PUT, so any allow-list must
//     admit them or a browser preflight fails.
//   * no rate limiting — NivaBupa's gateway POSTs /nivabupa/payment/return
//     server-to-server; a 429 there means the buyer paid and never got a
//     confirmation.
//   * body parsing — express.json()/urlencoded() with the raw-body verify hook
//     and the default 100kb limit. req.rawBody is what the payment callback
//     falls back to when form decoding mangles a '+' in the ciphertext.
export function createNivabupaRouter() {
  const router = express.Router();

  router.use(
    NIVABUPA_PATH_PREFIX,
    cors(corsOptions()),
    express.json({ verify: captureRawBody }),
    // NivaBupa's payment gateway posts the return callback as a form body, not JSON.
    express.urlencoded({ extended: true, verify: captureRawBody }),
    logRequest,
  );

  // Journey routes are mounted ABOVE resolveJourney, and the order is load-bearing.
  //
  // resolveJourney deletes journeyId / resumeToken from req.body so the
  // pass-through controllers below cannot forward them into a NivaBupa payload
  // (see middleware/journeyContext.js). The journey endpoints take those same two
  // values as legitimate body fields — POST /nivabupa/journey/resume is nothing
  // but a resumeToken — so running the middleware first would strip the very
  // field the handler needs and answer 400 on every resume.
  router.use(journey_routes);   // POST/GET/PATCH/PUT /nivabupa/journey/*

  // Everything below is a NivaBupa pass-through: resolve the optional journey and
  // scrub the identity fields out of the forwarded body. Registered here rather
  // than in app.js so it runs for both mount points ('/' and the compatibility
  // alias) without being wired up twice.
  router.use(NIVABUPA_PATH_PREFIX, resolveJourney);

  router.use(auth_routes);      // GET  /nivabupa/token/test
  router.use(quote_routes);     // POST /nivabupa/premium
  router.use(proposal_routes);  // POST /nivabupa/uw-decision, /nivabupa/datapush
  router.use(payment_routes);   // POST /nivabupa/payment/initiate, /nivabupa/payment/return
  router.use(case_routes);      // POST /nivabupa/proposal-status, /nivabupa/policy-download

  // Path-scoped, so a request that is not for this router falls through to
  // app.js's own handlers instead of being answered here.
  router.use(NIVABUPA_PATH_PREFIX, notFound);
  router.use(NIVABUPA_PATH_PREFIX, errorHandler);

  return router;
}

// The IFFCO Tokio router — a sibling of the NivaBupa one above, built the same
// way and scoped just as tightly to its own prefix. Kept as a separate router
// rather than another `router.use()` inside createNivabupaRouter() because the
// two integrations must be able to fail independently: nothing here can affect
// a NivaBupa request, and an ITGI deployment that was never configured simply
// answers 503 on its own paths.
//
// Three differences from the NivaBupa stack, each deliberate:
//   * body limit — CKYC create carries base64 document uploads (PAN, address
//     proof, photograph), which do not fit the 100kb express.json default.
//     ITGI_JSON_BODY_LIMIT, 6mb by default.
//   * no rate limiting — same reason: ITGI redirect the buyer to
//     /iffcotokio/payment/return, and a 429 there means the buyer paid and the
//     policy number was thrown away.
//   * its own CORS list — ITGI_CORS_ORIGINS, falling back to the shared one.
export function createItgiRouter() {
  const router = express.Router();

  router.use(
    ITGI_PATH_PREFIX,
    cors(corsOptions(config.itgi.corsOrigins)),
    express.json({ limit: config.itgi.jsonBodyLimit }),
    // The payment return may arrive as a form POST rather than the observed
    // GET, so the urlencoded parser has to be here too.
    express.urlencoded({ extended: true, limit: config.itgi.jsonBodyLimit }),
    logRequest,
  );

  // The same optional journey resolution the NivaBupa pass-throughs use, reused
  // rather than reimplemented. It does two things that matter equally here: it
  // hangs an optional journey on the request so ITGI calls can be audited
  // against it, and it DELETES journeyId / resumeToken from the body so neither
  // can be forwarded into an ITGI payload — ITGI reject unknown fields with the
  // same generic error they use for everything else.
  //
  // Its journey-API bypass keys on '/nivabupa/journey', which no ITGI path
  // matches, so every ITGI request takes the normal branch.
  router.use(ITGI_PATH_PREFIX, resolveJourney);

  router.use(itgi_routes);

  // Path-scoped, so a request that is not for this router falls through to
  // app.js's own handlers instead of being answered here.
  router.use(ITGI_PATH_PREFIX, notFound);
  router.use(ITGI_PATH_PREFIX, errorHandler);

  return router;
}

// The Future Generali router — a sibling of the two above, built the same way
// and scoped just as tightly to its own prefix. Kept separate rather than
// folded into either for the same reason they are separate from each other: the
// three integrations must be able to fail independently. Nothing here can
// affect a NivaBupa or IFFCO Tokio request, and an FG deployment that was never
// configured simply answers 503 on its own paths.
//
// Three differences from the NivaBupa stack, each deliberate:
//   * body parsing — FG's payment gateway posts its callback as a FORM body,
//     not JSON, so the urlencoded parser is load-bearing here rather than
//     defensive. Without it the callback body is empty and a paid customer
//     looks unpaid.
//   * no rate limiting — same reason as ITGI, and sharper: FG POST the payment
//     outcome to /future-generali/payment/return, and a 429 there means the
//     buyer paid and the WS_P_ID and PGID that issuance is impossible without
//     were thrown away.
//   * its own CORS list — FG_CORS_ORIGINS, falling back to the shared one.
export function createFgRouter() {
  const router = express.Router();

  router.use(
    FG_PATH_PREFIX,
    cors(corsOptions(config.fg.corsOrigins)),
    express.json({ limit: config.fg.jsonBodyLimit, verify: captureRawBody }),
    // FG's payment gateway answers with a form POST. `extended: true` because
    // the callback is read as a plain key/value map either way, and matching
    // the other routers costs nothing.
    express.urlencoded({ extended: true, limit: config.fg.jsonBodyLimit, verify: captureRawBody }),
    logRequest,
  );

  // The same optional journey resolution the other two routers use, reused
  // rather than reimplemented. It hangs an optional journey on the request so
  // FG calls can be audited against it, and it DELETES journeyId / resumeToken
  // from the body so neither can be forwarded into an FG payload — FG's <Root>
  // builder would silently ignore them, but the payment session stores the
  // proposal verbatim and they have no business being in it.
  //
  // Its journey-API bypass keys on '/nivabupa/journey', which no FG path
  // matches, so every FG request takes the normal branch.
  router.use(FG_PATH_PREFIX, resolveJourney);

  router.use(fg_routes);

  // Path-scoped, so a request that is not for this router falls through to
  // app.js's own handlers instead of being answered here.
  router.use(FG_PATH_PREFIX, notFound);
  router.use(FG_PATH_PREFIX, errorHandler);

  return router;
}

// The ICICI Lombard router — a sibling of the three above, built the same way
// and scoped just as tightly to its own prefix. Kept separate for the same
// reason they are separate from each other: the integrations must be able to
// fail independently. Nothing here can affect a NivaBupa, IFFCO Tokio or Future
// Generali request, and an ICICI deployment that was never configured simply
// answers 503 on its own paths.
//
// Differences from the NivaBupa stack, each deliberate:
//   * body limit — EL_JSON_BODY_LIMIT, 5mb by default: the working
//     implementation parsed bodies up to 5mb, and the OVD upload needs more
//     than express's 100kb default.
//   * urlencoded — extended:false, matching the working implementation's
//     parser. No ICICI route expects a form body today.
//   * no rate limiting — same policy as every other insurer router.
//   * its own CORS list — EL_CORS_ORIGINS, falling back to the shared one.
export function createIciciRouter() {
  const router = express.Router();

  router.use(
    ICICI_PATH_PREFIX,
    cors(corsOptions(config.icici.corsOrigins)),
    express.json({ limit: config.icici.jsonBodyLimit }),
    express.urlencoded({ extended: false, limit: config.icici.jsonBodyLimit }),
    logRequest,
  );

  // The same optional journey resolution the other routers use, reused rather
  // than reimplemented. It hangs an optional journey on the request so ICICI
  // calls can be audited against it, and it DELETES journeyId / resumeToken
  // from the body so neither is forwarded into an ICICI payload — the premium,
  // proposal and sync bodies go to ICICI verbatim.
  //
  // Its journey-API bypass keys on '/nivabupa/journey', which no ICICI path
  // matches, so every ICICI request takes the normal branch.
  router.use(ICICI_PATH_PREFIX, resolveJourney);

  router.use(icici_routes);

  // Path-scoped, so a request that is not for this router falls through to
  // app.js's own handlers instead of being answered here.
  router.use(ICICI_PATH_PREFIX, notFound);
  router.use(ICICI_PATH_PREFIX, errorHandler);

  return router;
}

// GET /healthz and GET /readyz — the service's own probes, at the paths an
// orchestrator polls. Kept outside the /nivabupa prefix deliberately: a load
// balancer health check should not have to know the API's route layout.
export function createNivabupaProbeRouter() {
  const router = express.Router();

  router.use(['/healthz', '/readyz'], cors(corsOptions()), logRequest);

  // Liveness only — deliberately does NOT touch MySQL. An orchestrator must not
  // restart a healthy process because the database is briefly unreachable: the
  // NivaBupa pass-through endpoints keep serving without it (persistence
  // degrades, the integration does not stop — see services/journey.service.js).
  router.get('/healthz', (req, res) => {
    res.status(200).json({
      status: 'OK',
      service: 'nivabupa-backend',
      env: config.env,
      timestamp: new Date().toISOString()
    });
  });

  // Readiness — this one does check MySQL, and reports 503 when journey
  // persistence is unavailable. Use this for "can this instance serve resume
  // requests", and /healthz for "is the process alive".
  router.get('/readyz', async (req, res) => {
    const result = await db.verifyConnection();
    return res.status(result.ok ? 200 : 503).json({
      status: result.ok ? 'READY' : 'DEGRADED',
      service: 'nivabupa-backend',
      env: config.env,
      database: result.ok
        ? { connected: true, schema: result.db, version: result.version }
        : { connected: false, error: result.error },
      journeyPersistence: result.ok ? 'ENABLED' : 'UNAVAILABLE — NivaBupa pass-through still served',
      timestamp: new Date().toISOString()
    });
  });

  return router;
}
