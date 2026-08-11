import express from 'express';
import * as controller from '../controllers/case.controller.js';

const router = express.Router();

router.post('/nivabupa/proposal-status', controller.getProposalStatus);
router.post('/nivabupa/policy-download', controller.downloadPolicy);

export default router;
