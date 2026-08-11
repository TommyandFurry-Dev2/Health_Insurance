import express from 'express';
import * as controller from '../controllers/journey.controller.js';

const router = express.Router();

// Journey lifecycle — all new endpoints. None of the pre-existing NivaBupa
// routes change shape; these sit alongside them.
router.post('/nivabupa/journey', controller.createJourney);
router.post('/nivabupa/journey/resume', controller.resumeJourney);
router.post('/nivabupa/journey/resume-by-mobile', controller.resumeByMobile);

// Declared before '/:journeyId' would otherwise shadow them — Express matches
// in declaration order, so a literal path registered after a parameterised one
// at the same depth is unreachable.
router.get('/nivabupa/journey/:journeyId/timeline', controller.getTimeline);
router.get('/nivabupa/journey/:journeyId/policy-document', controller.getStoredPolicyDocument);
router.post('/nivabupa/journey/:journeyId/select-quote', controller.selectQuote);
router.post('/nivabupa/journey/:journeyId/abandon', controller.abandonJourney);
router.patch('/nivabupa/journey/:journeyId/step', controller.saveStep);
router.put('/nivabupa/journey/:journeyId/proposal', controller.saveProposal);
router.put('/nivabupa/journey/:journeyId/kyc', controller.saveKyc);

router.get('/nivabupa/journey/:journeyId', controller.getJourney);

export default router;
