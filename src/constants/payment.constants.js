import config from '../config/env.js';

// Fields the pipe-separated payment querystring is built from, in the order
// the Juspay integration doc's sample payload uses.
//
// Field names and their order are the gateway's contract, not configuration —
// changing either would produce a querystring NivaBupa cannot parse, so these
// three lists stay literal. Only the two default *values* below are
// env-overridable.
const PAYMENT_QUERYSTRING_FIELDS = [
  'unqPolicyNumber', 'premiumValue', 'otherParam', 'paymentType', 'additionalComment',
  'returnPath', 'isjuspay', 'channel', 'subchannel', 'sourcingsystem', 'productname',
  'policynumber', 'mobile', 'email', 'agentid', 'suminsured', 'tenure', 'zone'
];

const PAYMENT_MANDATORY_FIELDS = [
  'unqPolicyNumber', 'premiumValue', 'paymentType', 'additionalComment',
  'returnPath', 'isjuspay', 'channel', 'subchannel', 'sourcingsystem', 'productname', 'mobile', 'email'
];

// Defaults applied to every payment/initiate request before the caller's own
// body is spread over them. Env-overridable (NIVABUPA_PAYMENT_TYPE /
// NIVABUPA_PAYMENT_ISJUSPAY) because the merchant payment type is the kind of
// value NivaBupa can reassign per partner or per environment.
const PAYMENT_DEFAULTS = {
  paymentType: config.nivabupa.payment.defaults.paymentType,
  isjuspay: config.nivabupa.payment.defaults.isjuspay,
};

// The only paymentStatus value NivaBupa's returnMessage uses for a completed
// payment; everything else is treated as failed/other.
const PAYMENT_SUCCESS_CODE = 'M001';

export {
  PAYMENT_QUERYSTRING_FIELDS,
  PAYMENT_MANDATORY_FIELDS,
  PAYMENT_DEFAULTS,
  PAYMENT_SUCCESS_CODE,
};
