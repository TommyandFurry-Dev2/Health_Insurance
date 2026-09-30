// The Express application. Deliberately thin: everything insurer-specific lives
// inside a router of its own — createNivabupaRouter() and createItgiRouter() —
// each carrying its own CORS policy, body parsers, access log and error
// envelopes, and each scoped to its own path prefix.
//
// The middleware order below reproduces exactly what the NivaBupa endpoints ran
// under when this integration was mounted inside tf-api — helmet first, then
// the NivaBupa router, then the alias mount, then the probes. Nothing else was
// in front of them there (tf-api's CORS, rate limiter and body parsers were all
// registered after the NivaBupa mount and never ran for these paths), and
// nothing else is in front of them here. The IFFCO Tokio router is mounted
// after them, on a prefix none of them match, so nothing about that order
// changed when it was added.
import express from 'express';
import helmet from 'helmet';

import config from './config/env.js';
import {
  createNivabupaRouter, createItgiRouter, createFgRouter, createIciciRouter, createCholaRouter,
  createNivabupaProbeRouter,
} from './index.js';

export function createApp() {
  const app = express();

  // Off by default, which is the behaviour these endpoints have always had.
  // Set TRUST_PROXY when running behind nginx/ELB so req.ip is the buyer's
  // address rather than the proxy's — req.ip is recorded on journey events and
  // on the payment callback.
  if (config.trustProxy !== null && config.trustProxy !== '') {
    const value = config.trustProxy;
    app.set('trust proxy', /^\d+$/.test(value) ? Number(value) : value);
  }

  // Security headers.
  app.use(helmet());

  const nivabupaRouter = createNivabupaRouter();
  app.use(nivabupaRouter);

  // Compatibility alias: the ONDC backend served every route under /health too,
  // so a deployed frontend build whose base URL still ends in /health keeps
  // working without a rebuild. NIVABUPA_ALIAS_PREFIX='' disables it.
  //
  // Safe to mount the same router instance twice because every route and every
  // piece of middleware inside it is scoped to the /nivabupa prefix: a request
  // to /health/nivabupa/premium is offered to the '/' mount first, matches
  // nothing there, and falls through to this one.
  if (config.aliasPrefix) {
    app.use(config.aliasPrefix, nivabupaRouter);
  }

  // IFFCO Tokio, mounted the same way and under the same alias.
  //
  // The alias is not optional decoration for this one: the payment response URL
  // REGISTERED WITH ITGI against our partner code is
  //   https://<host>/health/iffcotokio/payment/return
  // — it goes through the /health alias, so disabling NIVABUPA_ALIAS_PREFIX
  // would take the ITGI payment callback offline with it and lose the policy
  // number of every buyer who pays. Both mounts of the same router instance are
  // safe for the same reason the NivaBupa ones are: every route and every piece
  // of middleware inside it is scoped to /iffcotokio.
  const itgiRouter = createItgiRouter();
  app.use(itgiRouter);
  if (config.aliasPrefix) {
    app.use(config.aliasPrefix, itgiRouter);
  }

  // Future Generali, mounted the same way and under the same alias.
  //
  // The alias matters here too, though for a different reason than ITGI's. FG
  // do not hold a registered return URL — this service SENDS the ResponseURL on
  // every payment form — so FG_PAYMENT_RETURN_URL is what decides where the
  // callback lands, and it must name a path this process actually serves. The
  // deployed frontend reaches this backend through /health (the Apache in front
  // of the host proxies only that prefix), so the alias is what makes
  //   https://<host>/health/future-generali/payment/return
  // reachable at all. config/validate.js checks that variable against the route
  // served and complains when they disagree.
  //
  // Both mounts of the same router instance are safe for the same reason the
  // others are: every route and every piece of middleware inside it is scoped
  // to /future-generali.
  const fgRouter = createFgRouter();
  app.use(fgRouter);
  if (config.aliasPrefix) {
    app.use(config.aliasPrefix, fgRouter);
  }

  // ICICI Lombard, mounted the same way and under the same alias.
  //
  // The alias matters for the plainest of the reasons: the deployed frontend
  // reaches this backend through /health (the Apache in front of the host
  // proxies only that prefix), so https://<host>/health/icici-lombard/quote is
  // the URL a deployed build calls. There is no ICICI payment callback to keep
  // reachable — ICICI's hosted gateway returns the buyer to the SPA directly.
  //
  // Both mounts of the same router instance are safe for the same reason the
  // others are: every route and every piece of middleware inside it is scoped
  // to /icici-lombard.
  const iciciRouter = createIciciRouter();
  app.use(iciciRouter);
  if (config.aliasPrefix) {
    app.use(config.aliasPrefix, iciciRouter);
  }

  // Chola MS, mounted the same way and under the same alias, for ICICI's reason:
  // the deployed frontend reaches this backend through /health (the Apache in
  // front of the host proxies only that prefix), so
  // https://<host>/health/chola-ms/quote is the URL a deployed build calls.
  // There is no Chola payment callback to keep reachable — Chola's hosted page
  // returns the buyer to the SPA directly.
  //
  // Both mounts of the same router instance are safe for the same reason the
  // others are: every route and every piece of middleware inside it is scoped
  // to /chola-ms.
  const cholaRouter = createCholaRouter();
  app.use(cholaRouter);
  if (config.aliasPrefix) {
    app.use(config.aliasPrefix, cholaRouter);
  }

  // GET /healthz, GET /readyz — outside the /nivabupa prefix so a load balancer
  // does not need to know the API's route layout.
  app.use(createNivabupaProbeRouter());

  // Anything that reached here is not a NivaBupa route. The router's own
  // path-scoped notFound already answered every /nivabupa/* miss with the
  // envelope callers expect; this covers the rest of the origin with the same
  // shape rather than Express's HTML default.
  app.use((req, res) => {
    res.status(404).json({
      status: 'ERROR',
      message: `Route not found: ${req.method} ${req.originalUrl}`,
    });
  });

  return app;
}

export default createApp;
