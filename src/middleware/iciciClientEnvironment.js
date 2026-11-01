import { iciciEnvironmentRefusal } from '../config/env.js';
import { ICICI_PROVIDER } from '../constants/icici.constants.js';
import { runInIciciEnvironment } from '../helpers/iciciEnvironment.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Which ICICI a request reaches.
//
// This backend serves the UAT SPA and the production SPA, and both are served
// from the SAME origin (insurance.tommyandfurry.com — /tommyandfurryuat and
// /tommyandfurry), so CORS cannot tell them apart. The build says which it is:
//
//   X-App-Env absent or `uat` → UAT ICICI (EL_*). The UAT SPA sends nothing,
//                               so it is served exactly as before.
//   X-App-Env `prod`          → production ICICI (EL_PROD_*) — only while
//                               EL_PRODUCTION_ENABLED=true; refused otherwise,
//                               never quietly served from UAT.
//   anything else             → refused.
//
// The production SPA's elevateClient sends `prod` (its REACT_APP_MODE). A
// guard against a build reaching the wrong ICICI, not access control: anyone
// can set a header, but production ICICI is what the public production site
// offers anyway. Preflights and GET /icici-lombard/config/test pass untouched.
// ─────────────────────────────────────────────────────────────────────────────

const HEADER = 'X-App-Env';

export function requireIciciClientEnvironment(req, res, next) {
  if (req.method === 'OPTIONS' || (req.method === 'GET' && req.path === '/config/test')) return next();

  const declared = String(req.get(HEADER) || '').trim().toLowerCase();
  if (!declared || declared === 'uat') return runInIciciEnvironment('uat', next);

  const refusal = declared === 'prod'
    ? iciciEnvironmentRefusal('production')
    : `Unknown ${HEADER} "${declared}" — expected uat or prod.`;
  if (!refusal) return runInIciciEnvironment('production', next);

  console.warn(
    `⚠️  [icici] refused ${req.method} ${req.originalUrl} — ${HEADER}: ${declared} `
    + `(origin ${req.get('Origin') || 'none'}): ${refusal}`
  );
  return res.status(403).json({
    ok: false,
    error: {
      code: 'ENVIRONMENT_MISMATCH',
      message: refusal,
      provider: ICICI_PROVIDER,
      details: { declared },
    },
  });
}
