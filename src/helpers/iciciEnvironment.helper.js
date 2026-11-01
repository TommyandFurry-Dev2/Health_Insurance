import { AsyncLocalStorage } from 'node:async_hooks';

// ─────────────────────────────────────────────────────────────────────────────
// Which ICICI environment the current call belongs to — 'uat' or 'production'.
//
// Set once per request by middleware/iciciClientEnvironment.js and read by the
// ICICI services wherever they need a host, a credential, a path or the cached
// token, so one process can serve the UAT SPA from UAT ICICI and the
// production SPA from production ICICI without either reaching the other.
// Anything outside a request (smoke scripts, tests) is UAT unless it says
// otherwise with runInIciciEnvironment.
// ─────────────────────────────────────────────────────────────────────────────

const store = new AsyncLocalStorage();

export function runInIciciEnvironment(environment, fn) {
  return store.run(environment === 'production' ? 'production' : 'uat', fn);
}

export function currentIciciEnvironment() {
  return store.getStore() || 'uat';
}
