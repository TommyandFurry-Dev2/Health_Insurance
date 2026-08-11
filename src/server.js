// HTTP entrypoint: validate config, listen, boot the module, shut down cleanly.
//
// Nothing NivaBupa-specific lives here — see app.js for the middleware stack
// and index.js for the module lifecycle.
import config from './config/env.js';
import { validateConfig } from './config/validate.js';
import { createApp } from './app.js';
import { startNivabupa, stopNivabupa } from './index.js';

// Before the socket opens, so a misconfigured process reports why instead of
// accepting traffic it cannot serve. Throws (and exits non-zero) only when the
// configuration is unsafe for the declared NODE_ENV — see config/validate.js.
try {
  validateConfig();
} catch {
  // validateConfig already printed the specific variables and what to do.
  process.exit(1);
}

const app = createApp();
const server = app.listen(config.port, () => {
  console.log(`🚀 nivabupa-api listening on http://localhost:${config.port}  (env: ${config.env})`);

  // Verifies the MySQL connection and starts the stale-journey sweeper.
  // Never rejects — an unreachable database degrades journey persistence
  // without taking the NivaBupa pass-through endpoints down with it.
  void startNivabupa();
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${config.port} is already in use. Set PORT in .env or stop the other process.`);
  } else {
    console.error('❌ HTTP server error:', error.message);
  }
  process.exit(1);
});

// Graceful shutdown. The MySQL pool is drained only after the listener has
// closed: a transaction killed mid-commit could leave a journey pointing at a
// step whose rows are half-written, which is the one state resume cannot
// recover from.
let shuttingDown = false;

const shutdown = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down.`);

  // A connection held open by a slow upstream call must not strand the process
  // forever; 15s is longer than the longest per-attempt budget (Data Push, 55s
  // capped by its own timeout) is expected to need to unwind.
  const force = setTimeout(() => {
    console.error('⚠️  Shutdown timed out — exiting anyway.');
    process.exit(1);
  }, 15000);
  force.unref();

  server.close(() => {
    void stopNivabupa()
      .catch(() => undefined)
      .finally(() => {
        console.log('HTTP server closed.');
        process.exit(0);
      });
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// A rejected promise that nothing handled is a bug, but killing a live payment
// callback over it is worse. Logged, not fatal — matching how every controller
// in this service treats an unexpected failure.
process.on('unhandledRejection', (reason) => {
  console.error('⚠️  Unhandled promise rejection:', reason);
});

export { server, app };
