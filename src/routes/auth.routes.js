import express from 'express';
import * as controller from '../controllers/auth.controller.js';

const router = express.Router();

router.get('/nivabupa/token/test', controller.testToken);

export default router;
