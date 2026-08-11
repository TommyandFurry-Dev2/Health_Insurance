// Console-only access log, scoped to the NivaBupa mount points.
//
// The ONDC project logged every request into MySQL keyed by the Beckn `context`
// envelope — none of which exists here, so requests are logged to stdout.
// Deliberately console rather than a structured logger: each NivaBupa call
// already prints its own payload detail from the service layer, and those are
// multi-line blocks a JSON-line logger would mangle. This just frames them with
// method/path/status/duration.
const logRequest = (req, res, next) => {
  const startedAt = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - startedAt;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${durationMs}ms)`);
  });

  next();
};

export { logRequest };
