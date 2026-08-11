// The Express application. Deliberately thin: everything NivaBupa-specific
// lives inside the router returned by createNivabupaRouter(), which carries its
// own CORS policy, body parsers, access log and error envelopes.
//
// The middleware order below reproduces exactly what these endpoints ran under
// when this integration was mounted inside tf-api — helmet first, then the
// NivaBupa router, then the alias mount, then the probes. Nothing else was in
// front of them there (tf-api's CORS, rate limiter and body parsers were all
// registered after the NivaBupa mount and never ran for these paths), and
// nothing else is in front of them here.
import express from 'express';
import helmet from 'helmet';

import config from './config/env.js';
import { createNivabupaRouter, createNivabupaProbeRouter } from './index.js';

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
