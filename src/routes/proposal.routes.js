import express from 'express';
import * as controller from '../controllers/proposal.controller.js';

const router = express.Router();

router.post('/nivabupa/uw-decision', controller.getUwDecision);
router.post('/nivabupa/datapush', controller.submitDataPush);

export default router;
