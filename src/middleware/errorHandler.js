// Same response shape the shared ONDC backend used for uncaught errors, so a
// caller that already handles it keeps working. Every NivaBupa controller
// catches its own errors and answers 502/400 itself — this only fires for
// something unexpected (bad JSON body, a throw outside a try block).
//
// Both handlers are registered path-scoped to the NivaBupa mount inside
// routes/index.js, so a request for any other path falls through to app.js.
// `next` is unused but must stay declared: Express identifies an error handler
// by its 4-argument arity, so dropping it would turn this into ordinary
// middleware that never runs.
const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error', message: err.message });
};

const notFound = (req, res) => {
  res.status(404).json({
    status: 'ERROR',
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
};

export { errorHandler, notFound };
