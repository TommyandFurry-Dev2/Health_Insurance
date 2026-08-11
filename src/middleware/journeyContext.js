import * as journeyRepo from '../repositories/journey.repository.js';

// Resolves an optional journey for the existing NivaBupa pass-through
// endpoints and hangs it on req.journey.
//
// Optional is the whole point: /nivabupa/premium and friends were pure
// pass-throughs before journey persistence existed, and an already-deployed
// frontend build must keep working unchanged. A request with no journey
// identity behaves exactly as it did before, and its upstream call is still
// audited (api_transactions.journey_id is nullable for this reason).
//
// Identity is accepted from, in order of preference:
//   1. X-Journey-Id / X-Resume-Token headers  ← preferred
//   2. journeyId / resumeToken in the JSON body
//
// Body fields are DELETED after being read. The controllers forward req.body
// verbatim to NivaBupa, so leaving journeyId in it would send an
// undocumented field into the Reassure 3.0 premium/UW/datapush payloads —
// which the partner API is entitled to reject. Headers avoid the problem
// altogether, which is why they are preferred.
// The journey API's own endpoints take journeyId / resumeToken as legitimate
// body fields — POST /nivabupa/journey/resume is nothing but a resumeToken — so
// this middleware must not touch them.
//
// Matched on req.originalUrl rather than relying on route-mounting order,
// because app.js mounts the SAME router twice ('/' and the /health alias). A
// request to /health/nivabupa/journey/resume is offered to the '/'-mounted
// router first, and checking the full URL is immune to which mount is handling
// it. The middleware is additionally registered under the `/nivabupa` path
// prefix so it can never strip a field from a non-NivaBupa request body — see
// routes/index.js.
const JOURNEY_API_PATH = /\/nivabupa\/journey(\/|$|\?)/;

async function resolveJourney(req, res, next) {
  if (JOURNEY_API_PATH.test(req.originalUrl)) {
    req.journey = null;
    req.journeyId = null;
    req.journeyContext = {
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    };
    return next();
  }

  try {
    const headerJourneyId = req.headers['x-journey-id'];
    const headerResumeToken = req.headers['x-resume-token'];

    let bodyJourneyId = null;
    let bodyResumeToken = null;
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
      if (req.body.journeyId) {
        bodyJourneyId = req.body.journeyId;
        delete req.body.journeyId;
      }
      if (req.body.resumeToken) {
        bodyResumeToken = req.body.resumeToken;
        delete req.body.resumeToken;
      }
    }

    const journeyUuid = headerJourneyId || bodyJourneyId;
    const resumeToken = headerResumeToken || bodyResumeToken;

    let journey = null;
    if (journeyUuid) {
      journey = await journeyRepo.findByUuid(journeyUuid);
      if (!journey) {
        console.warn(`⚠️  Unknown journey id on ${req.method} ${req.originalUrl}: ${journeyUuid}`);
      }
    } else if (resumeToken) {
      journey = await journeyRepo.findResumableByToken(resumeToken);
    }

    req.journey = journey;
    req.journeyId = journey ? journey.id : null;
    req.journeyContext = {
      ipAddress: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.headers['user-agent'] || null,
    };

    // A journey referenced on a live request is being worked on, even if the
    // upstream call is about to fail — that keeps the sweeper from abandoning
    // a buyer who is mid-form.
    if (journey) {
      journeyRepo.touch(journey.id).catch((error) => {
        console.error('⚠️  journey touch failed:', error.message);
      });
    }

    return next();
  } catch (error) {
    // Never block the NivaBupa call on a journey lookup problem (MySQL down,
    // malformed uuid). The request proceeds without journey context.
    console.error('⚠️  Journey context resolution failed:', error.message);
    req.journey = null;
    req.journeyId = null;
    req.journeyContext = {
      ipAddress: req.ip || null,
      userAgent: req.headers['user-agent'] || null,
    };
    return next();
  }
}

export { resolveJourney };
