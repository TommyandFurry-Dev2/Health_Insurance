import express from 'express';
import * as controller from '../controllers/quote.controller.js';

const router = express.Router();

router.post('/nivabupa/premium', controller.getPremium);

export default router;
