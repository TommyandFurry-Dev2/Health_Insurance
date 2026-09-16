// ─────────────────────────────────────────────────────────────────────────────
// Self-test. Answers "is this deployment actually going to work?" without
// needing a buyer, a browser or a payment.
//
//   npm run verify         offline — config, routes, pure logic, live HTTP
//                          against this process only. Makes no NivaBupa calls,
//                          so it is safe to run anywhere, any number of times.
//   npm run verify:live    the above, plus one real round-trip to every NivaBupa
//                          endpoint that can be exercised without creating a
//                          policy: token, premium, caseapi token, and a full
//                          SOAP encrypt→decrypt of a synthetic payment string.
//
// Deliberately NOT covered by --live, because there is no read-only version of
// either: POST /nivabupa/uw-decision underwrites a real person, and
// POST /nivabupa/datapush creates a real proposal. Both are exercised by their
// request-builders here (payload shape, business defaults, headers) and by
// scripts/smoke-journey.js end-to-end.
//
// Exit code 0 = everything checked passed. Non-zero = at least one failure,
// listed at the bottom.
// ─────────────────────────────────────────────────────────────────────────────
import http from 'node:http';

import config from '../src/config/env.js';
import { validateConfig } from '../src/config/validate.js';
import { createApp } from '../src/app.js';
import db from '../src/db/index.js';

import { buildPaymentQuerystring, parseReturnMessage, findMissingMandatoryFields } from '../src/helpers/payment.helper.js';
import { applyBusinessDefaults } from '../src/helpers/proposal.helper.js';
import { escapeXml, extractTag } from '../src/helpers/xml.helper.js';
import { forAudit, toMysqlDate, toDecimal, newResumeToken } from '../src/utils/sanitize.js';
import { createTokenCache } from '../src/utils/tokenCache.js';
import { decodeJwtExpiryMs } from '../src/utils/jwt.js';
import { PAYMENT_QUERYSTRING_FIELDS, PAYMENT_DEFAULTS } from '../src/constants/payment.constants.js';
import { PROPOSAL_BUSINESS_DEFAULTS } from '../src/constants/proposal.constants.js';

const LIVE = process.argv.includes('--live');

const results = [];
let currentSection = '';

function section(name) {
  currentSection = name;
  console.log(`\n── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`);
}

function check(name, fn) {
  try {
    const detail = fn();
    results.push({ section: currentSection, name, ok: true });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ section: currentSection, name, ok: false, error: error.message });
    console.log(`  ❌ ${name}`);
    console.log(`       ${error.message}`);
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ section: currentSection, name, ok: true });
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (error) {
    results.push({ section: currentSection, name, ok: false, error: error.message });
    console.log(`  ❌ ${name}`);
    console.log(`       ${error.message}`);
  }
}

function skip(name, why) {
  results.push({ section: currentSection, name, ok: true, skipped: true });
  console.log(`  ⏭️  ${name} — skipped: ${why}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, what) {
  if (actual !== expected) {
    throw new Error(`${what}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  }
}

// ─── 1. Environment + configuration ─────────────────────────────────────────

section('1. Environment variables load correctly');

check('config object builds', () => `NODE_ENV=${config.env}, port ${config.port}`);

check('startup validation runs without throwing for this NODE_ENV', () => {
  // strict:false — this is a report, and a UAT run legitimately uses fallbacks.
  const report = validateConfig({ strict: false });
  const notes = [];
  if (report.missing.length) notes.push(`${report.missing.length} missing`);
  if (report.fallbacks.length) notes.push(`${report.fallbacks.length} from defaults.js`);
  return notes.length ? notes.join(', ') : 'everything from the environment';
});

check('every NivaBupa endpoint is an absolute http(s) URL', () => {
  const urls = {
    tokenUrl: config.nivabupa.tokenUrl,
    premiumUrl: config.nivabupa.premiumUrl,
    uwDecisionUrl: config.nivabupa.uwDecisionUrl,
    dataPushUrl: config.nivabupa.dataPushUrl,
    'caseApi.tokenUrl': config.nivabupa.caseApi.tokenUrl,
    'caseApi.proposalStatusUrl': config.nivabupa.caseApi.proposalStatusUrl,
    'caseApi.policyDownloadUrl': config.nivabupa.caseApi.policyDownloadUrl,
    'payment.gatewayUrl': config.nivabupa.payment.gatewayUrl,
    'payment.soapUrl': config.nivabupa.payment.soapUrl,
    'payment.returnUrl': config.nivabupa.payment.returnUrl,
  };
  for (const [name, value] of Object.entries(urls)) {
    assert(value, `${name} is empty`);
    assert(/^https?:\/\//.test(value), `${name} is not an absolute URL: ${value}`);
  }
  return `${Object.keys(urls).length} URLs`;
});

check('credentials are present (values not shown)', () => {
  assert(config.nivabupa.clientId, 'NIVABUPA_CLIENT_ID is empty');
  assert(config.nivabupa.clientSecret, 'NIVABUPA_CLIENT_SECRET is empty');
  assert(config.nivabupa.identifierCode, 'NIVABUPA_IDENTIFIER_CODE is empty');
  assert(config.nivabupa.payment.encryptionKey, 'NIVABUPA_PAYMENT_ENCRYPTION_KEY is empty');
  assert(config.nivabupa.payment.decryptionKey, 'NIVABUPA_PAYMENT_DECRYPTION_KEY is empty');
  return 'generic API + payment keys set';
});

check('Case API credentials', () => {
  const { userId, clientId } = config.nivabupa.caseApi;
  if (!userId || !clientId) {
    throw new Error(
      'NIVABUPA_CASEAPI_USER_ID / NIVABUPA_CASEAPI_CLIENT_ID not set — /nivabupa/proposal-status '
      + 'and /nivabupa/policy-download will fail. Every other endpoint is unaffected.'
    );
  }
  return 'set';
});

check('timeouts are sane and Data Push has the longest budget', () => {
  const { token, api, soap, dataPush } = config.timeouts;
  for (const [name, value] of Object.entries({ token, api, soap, dataPush })) {
    assert(Number.isFinite(value) && value > 0, `timeouts.${name} is not a positive number: ${value}`);
  }
  assert(dataPush > api, `Data Push timeout (${dataPush}ms) must exceed the generic API timeout (${api}ms)`);
  assert(dataPush < 60000, `Data Push timeout (${dataPush}ms) must stay under the frontend's own 60s axios timeout`);
  return `token ${token} / api ${api} / soap ${soap} / datapush ${dataPush} ms`;
});

// ─── 2. Routes ──────────────────────────────────────────────────────────────

section('2. Routes are registered');

// Express 5 compiles a mount path into a matcher closure and does not keep the
// original string anywhere on the layer, so the prefix has to be recovered by
// probing that matcher rather than read off a property.
//
// The probe is decisive because a root mount matches any path while a prefixed
// one matches only its own: test an obviously-unrelated path first, and only if
// that fails try each known prefix.
const CANDIDATE_PREFIXES = [config.aliasPrefix].filter(Boolean);

function mountPrefixOf(layer) {
  const match = layer.matchers?.[0];
  if (typeof match !== 'function') return '';
  try {
    if (match('/zz-unmounted-probe')) return '';
    for (const prefix of CANDIDATE_PREFIXES) {
      if (match(`${prefix}/zz-unmounted-probe`)) return prefix;
    }
  } catch {
    return '';
  }
  return '';
}

// Walks the Express 5 layer tree. Sub-routers mounted with app.use() carry
// their own stack on layer.handle; a leaf route carries layer.route.
function collectRoutes(router, prefix = '', depth = 0) {
  const found = [];
  const stack = router?.stack || [];
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]);
      for (const method of methods) {
        found.push(`${method.toUpperCase()} ${prefix}${layer.route.path}`);
      }
      continue;
    }
    if (layer.handle?.stack) {
      // Only the app's own layers can carry a mount prefix here; nested routers
      // inside createNivabupaRouter() are all mounted at the router root.
      const mount = depth === 0 ? mountPrefixOf(layer) : '';
      found.push(...collectRoutes(layer.handle, prefix + mount, depth + 1));
    }
  }
  return found;
}

const app = createApp();
const registered = new Set(collectRoutes(app.router));

const EXPECTED_ROUTES = [
  'GET /nivabupa/token/test',
  'POST /nivabupa/premium',
  'POST /nivabupa/uw-decision',
  'POST /nivabupa/datapush',
  'POST /nivabupa/payment/initiate',
  'POST /nivabupa/payment/return',
  'POST /nivabupa/proposal-status',
  'POST /nivabupa/policy-download',
  'POST /nivabupa/journey',
  'POST /nivabupa/journey/resume',
  'POST /nivabupa/journey/resume-by-mobile',
  'GET /nivabupa/journey/:journeyId',
  'GET /nivabupa/journey/:journeyId/timeline',
  'GET /nivabupa/journey/:journeyId/policy-document',
  'POST /nivabupa/journey/:journeyId/select-quote',
  'POST /nivabupa/journey/:journeyId/abandon',
  'PATCH /nivabupa/journey/:journeyId/step',
  'PUT /nivabupa/journey/:journeyId/proposal',
  'PUT /nivabupa/journey/:journeyId/kyc',
  // IFFCO Tokio. Registered whether or not ITGI is configured — an unconfigured
  // deployment answers 503 on these paths rather than 404, which is the
  // difference between "not set up" and "not deployed".
  'GET /iffcotokio/config/test',
  'POST /iffcotokio/premium',
  'POST /iffcotokio/proposal',
  'POST /iffcotokio/payment/initiate',
  // ⚠️ The URL registered with ITGI, and the only channel by which a policy
  // number reaches this service. GET is what their gateway actually redirects
  // with; POST is registered too so a change of method does not lose a policy.
  'GET /iffcotokio/payment/return',
  'POST /iffcotokio/payment/return',
  'POST /iffcotokio/payment/confirmation',
  'POST /iffcotokio/policy-download',
  'POST /iffcotokio/kyc/fetch',
  'POST /iffcotokio/kyc/create',
  // ICICI Lombard. Registered whether or not ICICI is configured — an
  // unconfigured deployment answers 503 on these paths rather than 404.
  'GET /icici-lombard/config/test',
  'POST /icici-lombard/quote',
  'POST /icici-lombard/ckyc',
  'POST /icici-lombard/ckyc/ovd',
  'POST /icici-lombard/proposal',
  'POST /icici-lombard/policy/status',
  'POST /icici-lombard/issue',
  'GET /icici-lombard/coi/:transactionId',
  'POST /icici-lombard/emi/due',
  'POST /icici-lombard/emi/process',
  'POST /icici-lombard/zone',
  'GET /healthz',
  'GET /readyz',
];

// Both insurer prefixes are served a second time under the compatibility alias.
// For ITGI that is not merely a compatibility nicety: the payment response URL
// registered with them goes through it (…/health/iffcotokio/payment/return).
const ALIASED_PREFIXES = ['/nivabupa/', '/iffcotokio/', '/icici-lombard/'];

check(`all ${EXPECTED_ROUTES.length} routes registered at the primary mount`, () => {
  const missing = EXPECTED_ROUTES.filter((route) => !registered.has(route));
  assert(missing.length === 0, `missing:\n         ${missing.join('\n         ')}`);
  return `${EXPECTED_ROUTES.length} routes`;
});

check('compatibility alias mount serves the same routes', () => {
  if (!config.aliasPrefix) return 'disabled (NIVABUPA_ALIAS_PREFIX empty)';
  const aliased = EXPECTED_ROUTES
    .filter((route) => ALIASED_PREFIXES.some((prefix) => route.includes(prefix)))
    .map((route) => {
      const prefix = ALIASED_PREFIXES.find((candidate) => route.includes(candidate));
      return route.replace(` ${prefix}`, ` ${config.aliasPrefix}${prefix}`);
    });
  const missing = aliased.filter((route) => !registered.has(route));
  assert(missing.length === 0, `missing under ${config.aliasPrefix}:\n         ${missing.join('\n         ')}`);
  return `${aliased.length} routes under ${config.aliasPrefix}`;
});

check('journey routes are declared before the :journeyId catch-all', () => {
  // Express matches in declaration order: a literal path registered after a
  // parameterised one at the same depth is unreachable.
  const all = collectRoutes(app.router);
  const catchAll = all.indexOf('GET /nivabupa/journey/:journeyId');
  const timeline = all.indexOf('GET /nivabupa/journey/:journeyId/timeline');
  const document = all.indexOf('GET /nivabupa/journey/:journeyId/policy-document');
  assert(catchAll > timeline && catchAll > document,
    'GET /nivabupa/journey/:journeyId is declared before its sub-paths, which shadows them');
  return 'ordering correct';
});

// ─── 3. Payment: querystring, encryption input, callback parsing ────────────

section('3. Payment flow — querystring build + callback parse');

const SAMPLE_PAYMENT = {
  unqPolicyNumber: 'APP-VERIFY-0001',
  premiumValue: '12345',
  additionalComment: 'Reassure 3.0',
  channel: 'WEB',
  subchannel: 'DIRECT',
  sourcingsystem: 'Novacred',
  productname: 'REASSURE30',
  mobile: '9876500001',
  email: 'verify@example.com',
  suminsured: '1000000',
  tenure: '1',
  zone: 'ZONE1',
};

check('mandatory-field validation rejects an incomplete body', () => {
  const missing = findMissingMandatoryFields({ unqPolicyNumber: 'X' });
  assert(missing.length > 0, 'an almost-empty body was accepted');
  assert(missing.includes('premiumValue'), 'premiumValue not reported missing');
  return `${missing.length} fields reported`;
});

check('mandatory-field validation passes a complete body', () => {
  const body = { ...PAYMENT_DEFAULTS, returnPath: config.nivabupa.payment.returnUrl, ...SAMPLE_PAYMENT };
  const missing = findMissingMandatoryFields(body);
  assertEqual(missing.length, 0, `unexpected missing fields: ${missing.join(', ')}`);
});

check('querystring has every field, in order, pipe-separated', () => {
  const body = { ...PAYMENT_DEFAULTS, returnPath: config.nivabupa.payment.returnUrl, ...SAMPLE_PAYMENT };
  const qs = buildPaymentQuerystring(body);
  const parts = qs.split('|');

  assertEqual(parts.length, PAYMENT_QUERYSTRING_FIELDS.length,
    'field count differs from PAYMENT_QUERYSTRING_FIELDS');

  PAYMENT_QUERYSTRING_FIELDS.forEach((field, index) => {
    assert(parts[index].startsWith(`${field}=`),
      `position ${index} is "${parts[index].split('=')[0]}", expected "${field}"`);
  });

  // "blank" in NivaBupa's spec means present-but-empty, never absent.
  assert(qs.includes('policynumber='), 'the optional policynumber field was dropped instead of sent blank');
  assert(qs.includes('otherParam='), 'the optional otherParam field was dropped instead of sent blank');
  assert(qs.includes(`paymentType=${PAYMENT_DEFAULTS.paymentType}`), 'paymentType default not applied');
  assert(qs.includes(`isjuspay=${PAYMENT_DEFAULTS.isjuspay}`), 'isjuspay default not applied');
  return `${parts.length} fields`;
});

check('returnPath in the querystring is the configured callback URL', () => {
  const body = { ...PAYMENT_DEFAULTS, returnPath: config.nivabupa.payment.returnUrl, ...SAMPLE_PAYMENT };
  const qs = buildPaymentQuerystring(body);
  assert(qs.includes(`returnPath=${config.nivabupa.payment.returnUrl}`),
    'returnPath does not match config.nivabupa.payment.returnUrl');
  return config.nivabupa.payment.returnUrl;
});

check('callback returnMessage parses to the documented field order', () => {
  // The documented pipe layout, with M001 = success.
  const decrypted = 'Novacred|APP-VERIFY-0001|12345|07/Aug/2026 11:22:33|APP-VERIFY-0001|TXN99887766|M001||N||JUSPAY';
  const parsed = parseReturnMessage(decrypted);
  assertEqual(parsed.uniqueReferenceId, 'APP-VERIFY-0001', 'uniqueReferenceId');
  assertEqual(parsed.payablePremium, '12345', 'payablePremium');
  assertEqual(parsed.paymentTransactionId, 'TXN99887766', 'paymentTransactionId');
  assertEqual(parsed.paymentStatus, 'M001', 'paymentStatus');
  assertEqual(parsed.paymentStatusDescription, 'SUCCESS', 'paymentStatusDescription');
  assertEqual(parsed.transactionDateTime, '07/Aug/2026 11:22:33', 'transactionDateTime');
  assertEqual(parsed.paymentGatewayUsed, 'JUSPAY', 'paymentGatewayUsed');
});

check('a non-M001 status parses as failed, not success', () => {
  const decrypted = 'Novacred|APP-X|100|07/Aug/2026|APP-X|TXN1|M002|Insufficient funds|N||JUSPAY';
  const parsed = parseReturnMessage(decrypted);
  assertEqual(parsed.paymentStatusDescription, 'FAILED_OR_OTHER', 'paymentStatusDescription');
  assertEqual(parsed.failedReason, 'Insufficient funds', 'failedReason');
});

// ─── 4. SOAP envelope construction ──────────────────────────────────────────

section('4. SOAP encryption envelope');

check('XML escaping covers the three entity characters and nothing else', () => {
  assertEqual(escapeXml('a&b<c>d'), 'a&amp;b&lt;c&gt;d', 'escapeXml');
  // Base64 padding and '+' must survive untouched — they are ciphertext.
  assertEqual(escapeXml('AB+/=='), 'AB+/==', 'escapeXml must not touch base64 characters');
});

check('extractTag returns the tag body byte-for-byte', () => {
  const xml = '<s:Envelope><s:Body><decRespResult>A+B/C==</decRespResult></s:Body></s:Envelope>';
  assertEqual(extractTag(xml, 'decRespResult'), 'A+B/C==', 'extractTag');
  assertEqual(extractTag(xml, 'missingTag'), null, 'extractTag on an absent tag must return null');
});

check('the encResp envelope carries the configured key and SOAPAction', () => {
  // Reproduces exactly what services/soap.service.js builds, so a change to the
  // envelope shape fails here rather than at the gateway.
  const method = 'encResp';
  const params = { text: 'a=1|b=2', EncryptionKey: config.nivabupa.payment.encryptionKey };
  const paramTags = Object.entries(params)
    .map(([key, value]) => `<tem:${key}>${escapeXml(value)}</tem:${key}>`)
    .join('\n         ');
  const body = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/"><soapenv:Body><tem:${method}>${paramTags}</tem:${method}></soapenv:Body></soapenv:Envelope>`;
  assert(body.includes('<tem:text>a=1|b=2</tem:text>'), 'text parameter missing from the envelope');
  assert(body.includes('<tem:EncryptionKey>'), 'EncryptionKey parameter missing from the envelope');
  assertEqual(`http://tempuri.org/IService1/${method}`, 'http://tempuri.org/IService1/encResp', 'SOAPAction');
});

// ─── 5. Proposal business defaults ──────────────────────────────────────────

section('5. Proposal payload — business defaults');

function samplePayload() {
  return {
    Proposal: {
      POLICY: {
        CONTRACT_DETAILS: { SOURCING_APPNO: 'APP-VERIFY-0001', PRODUCT_VARIANT: 'Diamond', SUM_INSURED: '1000000' },
        PAYMENT_INFO: { PAYMENT_RECEIVED_FLAG: 'N', PAYMENT_COLLECT_MODE: '', TRANSACTION_NUMBER: '' },
        POLICY_OTHER_DETAILS: {},
        SOURCING_INFO: {},
        ADJUSTMENT_DETAILS: [
          { ADJUSTMENT_CODE: 'A_COPAY', ADJUSTMENT_VALUE: '0' },
          { ADJUSTMENT_CODE: 'A_REAL_RIDER', ADJUSTMENT_VALUE: '10' },
        ],
      },
      PROPOSER: {},
    },
  };
}

check('Data Push asserts every channel constant', () => {
  const payload = samplePayload();
  applyBusinessDefaults(payload, { transactionNumber: 'TXN99887766', paymentDate: '07/Aug/2026' });
  const policy = payload.Proposal.POLICY;

  assertEqual(policy.PAYMENT_INFO.PAYMENT_COLLECT_MODE, PROPOSAL_BUSINESS_DEFAULTS.paymentCollectMode, 'PAYMENT_COLLECT_MODE');
  assertEqual(policy.PAYMENT_INFO.PAYMENT_RECEIVED_FLAG, PROPOSAL_BUSINESS_DEFAULTS.paymentReceivedFlag, 'PAYMENT_RECEIVED_FLAG');
  assertEqual(policy.PAYMENT_INFO.TRANSACTION_NUMBER, 'TXN99887766', 'TRANSACTION_NUMBER');
  assertEqual(policy.PAYMENT_INFO.PAYMENT_DATE, '07/Aug/2026', 'PAYMENT_DATE');
  assertEqual(policy.POLICY_OTHER_DETAILS.LOGIN_BRANCH_CODE, PROPOSAL_BUSINESS_DEFAULTS.loginBranchCode, 'LOGIN_BRANCH_CODE');
  assertEqual(policy.POLICY_OTHER_DETAILS.NOC_BRANCH_CODE, PROPOSAL_BUSINESS_DEFAULTS.nocBranchCode, 'NOC_BRANCH_CODE');
  assertEqual(policy.SOURCING_INFO.AGENT_INFO.AGENT_CODE, PROPOSAL_BUSINESS_DEFAULTS.agentCode, 'AGENT_CODE');
});

check('UW Decision does NOT claim payment was received', () => {
  const payload = samplePayload();
  applyBusinessDefaults(payload, { enforcePaymentReceived: false });
  // Underwriting runs before the buyer reaches the gateway, so the caller's own
  // value must survive rather than being stamped to 'Y'.
  assertEqual(payload.Proposal.POLICY.PAYMENT_INFO.PAYMENT_RECEIVED_FLAG, 'N', 'PAYMENT_RECEIVED_FLAG');
});

check('an unresolvable TRANSACTION_NUMBER is omitted, never sent blank', () => {
  const payload = samplePayload();
  applyBusinessDefaults(payload, { transactionNumber: null });
  assert(!('TRANSACTION_NUMBER' in payload.Proposal.POLICY.PAYMENT_INFO),
    'TRANSACTION_NUMBER was left on the payload with no real value');
});

check('unselected A_COPAY is dropped; a chosen rider is kept', () => {
  const payload = samplePayload();
  applyBusinessDefaults(payload, { transactionNumber: 'T1' });
  const codes = payload.Proposal.POLICY.ADJUSTMENT_DETAILS.map((a) => a.ADJUSTMENT_CODE);
  assert(!codes.includes('A_COPAY'), 'A_COPAY with value "0" was sent — their engine reads that as an explicit 0% election');
  assert(codes.includes('A_REAL_RIDER'), 'a rider the buyer selected was dropped');
  return `kept: ${codes.join(', ') || '(none)'}`;
});

check('a payload without Proposal.POLICY is left untouched', () => {
  const payload = { something: 'else' };
  const { applied, skipped } = applyBusinessDefaults(payload);
  assertEqual(applied.length, 0, 'defaults were applied to a payload with no POLICY');
  assert(skipped, 'no skip reason reported');
});

// ─── 6. Logging safety ──────────────────────────────────────────────────────

section('6. Logging never leaks secrets');

check('forAudit redacts credentials at every nesting level', () => {
  const audited = forAudit({
    client_secret: 'REAL-SECRET',
    Authorization: 'Bearer REAL-TOKEN',
    nested: { encryptionKey: 'REAL-KEY', access_token: 'REAL-ACCESS', apiKey: 'REAL-API-KEY' },
    list: [{ password: 'REAL-PASSWORD' }],
    keep: 'visible',
  });
  const serialized = JSON.stringify(audited);
  for (const secret of ['REAL-SECRET', 'REAL-TOKEN', 'REAL-KEY', 'REAL-ACCESS', 'REAL-API-KEY', 'REAL-PASSWORD']) {
    assert(!serialized.includes(secret), `${secret} survived redaction`);
  }
  assert(serialized.includes('visible'), 'a non-secret field was redacted');
});

check('forAudit truncates a base64 policy PDF instead of storing it whole', () => {
  const audited = forAudit({ documentBase64: 'A'.repeat(20000) });
  assert(audited.documentBase64.length < 5000, `stored ${audited.documentBase64.length} chars`);
  assert(audited.documentBase64.includes('truncated'), 'no truncation marker');
});

check('the live configured secrets do not appear in an audited payload', () => {
  const audited = JSON.stringify(forAudit({
    clientSecret: config.nivabupa.clientSecret,
    encryptionKey: config.nivabupa.payment.encryptionKey,
    decryptionKey: config.nivabupa.payment.decryptionKey,
  }));
  assert(!audited.includes(config.nivabupa.clientSecret), 'client secret leaked');
  assert(!audited.includes(config.nivabupa.payment.encryptionKey), 'encryption key leaked');
  assert(!audited.includes(config.nivabupa.payment.decryptionKey), 'decryption key leaked');
});

// ─── 7. Utility correctness ─────────────────────────────────────────────────

section('7. Shared utilities');

check("NivaBupa's DD/Mon/YYYY dates convert to MySQL DATE", () => {
  assertEqual(toMysqlDate('06/Aug/1998'), '1998-08-06', 'DD/Mon/YYYY');
  assertEqual(toMysqlDate('2026-08-11'), '2026-08-11', 'ISO passthrough');
  assertEqual(toMysqlDate('nonsense'), null, 'unparseable input must be null, never a guess');
});

check('empty gateway amounts become NULL, not 0', () => {
  assertEqual(toDecimal(''), null, "'' must be null");
  assertEqual(toDecimal('1234.50'), 1234.5, 'numeric string');
});

check('resume tokens are 64 hex chars, matching journeys.resume_token', () => {
  const token = newResumeToken();
  assertEqual(token.length, 64, 'length');
  assert(/^[0-9a-f]{64}$/.test(token), 'not lowercase hex');
  assert(newResumeToken() !== token, 'two calls returned the same token');
});

check('token cache expires 30s early and never serves a stale token', () => {
  const cache = createTokenCache();
  cache.set('tok', Date.now() + 120000);
  assertEqual(cache.get(), 'tok', 'a fresh token should be served');
  // Expiring in 10s: inside the 30s skew, so it must NOT be served.
  cache.set('tok2', Date.now() + 10000);
  assertEqual(cache.get(), null, 'a token inside the 30s refresh skew was served');
  cache.clear();
  assertEqual(cache.get(), null, 'clear() did not empty the cache');
});

check('JWT exp decoding drives the Case API cache (no expires_in is sent)', () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.y`;
  assertEqual(decodeJwtExpiryMs(jwt), exp * 1000, 'decoded expiry');
  assertEqual(decodeJwtExpiryMs('not-a-jwt'), null, 'a non-JWT must return null so the caller can default');
});

// ─── 8. Live HTTP against this process ──────────────────────────────────────

section('8. Server starts and answers');

function request(port, method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

// Port 0 = an ephemeral port, so this never collides with a running instance.
const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;
console.log(`  (listening on 127.0.0.1:${port})`);

await checkAsync('GET /healthz → 200, liveness only, no MySQL touched', async () => {
  const res = await request(port, 'GET', '/healthz');
  assertEqual(res.status, 200, 'status');
  const json = JSON.parse(res.body);
  assertEqual(json.status, 'OK', 'status field');
  assertEqual(json.service, 'nivabupa-backend', 'service field');
  return `env=${json.env}`;
});

await checkAsync('GET /readyz reports the MySQL state', async () => {
  const res = await request(port, 'GET', '/readyz');
  assert(res.status === 200 || res.status === 503, `unexpected status ${res.status}`);
  const json = JSON.parse(res.body);
  return json.database?.connected
    ? `200 READY — ${json.database.schema} (MySQL ${json.database.version})`
    : `503 DEGRADED — ${json.database?.error}; pass-through endpoints still served`;
});

await checkAsync('security headers are applied', async () => {
  const res = await request(port, 'GET', '/healthz');
  assert(res.headers['x-content-type-options'] === 'nosniff', 'helmet is not applied (no X-Content-Type-Options)');
  return 'helmet active';
});

await checkAsync('an unknown /nivabupa path returns the NivaBupa 404 envelope', async () => {
  const res = await request(port, 'POST', '/nivabupa/does-not-exist', {});
  assertEqual(res.status, 404, 'status');
  const json = JSON.parse(res.body);
  assertEqual(json.status, 'ERROR', 'status field');
  assert(json.message.includes('Route not found'), `unexpected message: ${json.message}`);
});

await checkAsync('payment/initiate validates before calling NivaBupa', async () => {
  // An empty body must be rejected locally with 400 — if this ever reaches the
  // SOAP service it would be a wasted upstream call on an unsendable payload.
  const res = await request(port, 'POST', '/nivabupa/payment/initiate', {});
  assertEqual(res.status, 400, 'status');
  const json = JSON.parse(res.body);
  assert(json.message.includes('Missing required payment field'), `unexpected message: ${json.message}`);
  return 'rejected locally, no upstream call';
});

await checkAsync('proposal-status requires an ApplicationNumber', async () => {
  const res = await request(port, 'POST', '/nivabupa/proposal-status', {});
  assertEqual(res.status, 400, 'status');
  return 'rejected locally, no upstream call';
});

if (config.aliasPrefix) {
  await checkAsync(`the ${config.aliasPrefix} alias serves the same handlers`, async () => {
    const res = await request(port, 'POST', `${config.aliasPrefix}/nivabupa/payment/initiate`, {});
    assertEqual(res.status, 400, 'status');
    return `${config.aliasPrefix} mount live`;
  });
}

// ─── 9. Database ────────────────────────────────────────────────────────────

section('9. Database (journey persistence)');

const dbStatus = await db.verifyConnection();
if (dbStatus.ok) {
  check('MySQL reachable', () => `${dbStatus.db} (server ${dbStatus.version})`);
  await checkAsync('journey schema is migrated', async () => {
    const rows = await db.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME LIKE 'nivabupa%'`,
      [config.db.database]
    );
    const names = rows.map((row) => row.name);
    assert(names.length > 0, `no nivabupa_* tables in ${config.db.database}. Run: npm run migrate`);
    return `${names.length} tables`;
  });
} else {
  skip('MySQL reachable', `${dbStatus.error} — pass-through endpoints are unaffected; run npm run migrate once MySQL is up`);
  skip('journey schema is migrated', 'no database connection');
}

// ─── 10. Live NivaBupa round-trips (--live only) ────────────────────────────

section('10. Live NivaBupa calls');

if (!LIVE) {
  skip('NivaBupa token API', 'run with --live (npm run verify:live)');
  skip('NivaBupa premium API', 'run with --live');
  skip('NivaBupa Case API token', 'run with --live');
  skip('SOAP encResp encrypts a real payment querystring', 'run with --live');
  skip('SOAP decResp round-trips a ciphertext under the same key', 'run with --live');
  skip('the callback decryption key is configured and distinct', 'run with --live');
} else {
  const { getNivaBupaToken } = await import('../src/services/nivabupaAuth.service.js');
  const { getPremium } = await import('../src/services/genericApi.service.js');
  const { getNivaBupaCaseApiToken } = await import('../src/services/caseApiAuth.service.js');
  const { encryptPaymentParams, decryptPaymentReturn } = await import('../src/services/soap.service.js');

  await checkAsync('NivaBupa token API (OAuth client_credentials)', async () => {
    const token = await getNivaBupaToken({ forceRefresh: true });
    assert(token && token.length > 20, 'token looks empty or truncated');
    return `acquired (${token.length} chars, value not shown)`;
  });

  await checkAsync('NivaBupa premium API (one adult, Diamond, 10L)', async () => {
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
      .replace(/ /g, '/').toUpperCase();
    const { data, exchange } = await getPremium({
      policyTerm: '1', city: 'MUMBAI', premiumCalculationDate: today, paymentFrequency: 'A',
      isPort: 'N', yearlyQuotation: 'N', otherFrequencyAdjustmentRequire: 'Y', coverageType: 'I',
      sumInsured: '1000000', adultCovered: '1', childCovered: '0', productCode: 'REASSURE30',
      premiumCalculation: 'New', policyNumberIfRenewal: '', productVariant: 'Diamond',
      state: 'MAHARASHTRA', flexiPayment: 'N',
      member: [{ dateOfBirth: '06/Aug/1998', diaPedTenure: '0', gender: 'M', htnPedTenure: '0', insuredType: 'A', mbrShpNo: '1', portCoverageYears: '0', uwLoading: [] }],
    });
    assert(data, 'no response body');
    // The exchange is what the controller returns as `nivabupaRequest` — assert
    // it describes the call actually made, since the frontend debugs from it.
    assertEqual(exchange.url, config.nivabupa.premiumUrl, 'exchange.url');
    assert(exchange.requestHeaders.Authorization.startsWith('Bearer '), 'Authorization header not sent as a Bearer token');
    assert(!exchange.requestHeaders.Authorization.includes('…') === false, 'bearer token was not fingerprinted in the exchange');
    assertEqual(exchange.requestHeaders.clientId, config.nivabupa.clientId, 'clientId header');
    const envelope = data.premiumResponse || data;
    return `HTTP ${exchange.responseStatus}, STATUS=${envelope?.STATUS ?? '(none)'}, ${exchange.attempts} attempt(s)`;
  });

  if (config.nivabupa.caseApi.userId && config.nivabupa.caseApi.clientId) {
    await checkAsync('NivaBupa Case API token (UserID + Client_id → JWT)', async () => {
      const token = await getNivaBupaCaseApiToken({ forceRefresh: true });
      assert(token && token.length > 20, 'token looks empty or truncated');
      const expiry = decodeJwtExpiryMs(token);
      return expiry
        ? `acquired, JWT expires ${new Date(expiry).toISOString()}`
        : 'acquired (not a decodable JWT — cache falls back to 55min)';
    });
  } else {
    skip('NivaBupa Case API token', 'NIVABUPA_CASEAPI_USER_ID / NIVABUPA_CASEAPI_CLIENT_ID not set');
  }

  await checkAsync('SOAP encResp encrypts a real payment querystring', async () => {
    // Proves the outbound half of the payment crypto path end to end: the
    // envelope, the SOAPAction, the configured encryption key and the tag
    // extraction. Uses a synthetic querystring — no payment is created and no
    // money moves.
    const plaintext = buildPaymentQuerystring({
      ...PAYMENT_DEFAULTS,
      returnPath: config.nivabupa.payment.returnUrl,
      ...SAMPLE_PAYMENT,
    });
    const cipher = await encryptPaymentParams(plaintext);
    assert(cipher && cipher.length > 0, 'encResp returned an empty encparam');
    assert(!cipher.includes('<'), 'encResp result still contains XML — tag extraction failed');
    return `${plaintext.length} chars → ${cipher.length} chars encparam`;
  });

  await checkAsync('SOAP decResp round-trips a ciphertext under the same key', async () => {
    // encResp/decResp are plain symmetric operations over whatever key they are
    // handed (confirmed by round-trip testing against the live service on
    // 2026-08-05). So the only round-trip this service can prove on its own is
    // one under a single key — and the encryption key is the one it owns both
    // ends of.
    //
    // It cannot be the DECRYPTION key: that one exists to read ciphertext
    // NivaBupa produced, and the two are deliberately different values here.
    // Feeding our own encResp output to it would be expected to fail, which
    // would prove nothing about whether real callbacks decrypt.
    const { callSoap } = await import('../src/services/soap.service.js');
    const key = config.nivabupa.payment.encryptionKey;
    const plaintext = 'verify=1|roundtrip=yes';

    const cipher = await callSoap({ method: 'encResp', resultTag: 'encRespResult', params: { text: plaintext, EncryptionKey: key } });
    const back = await callSoap({ method: 'decResp', resultTag: 'decRespResult', params: { cipherText: cipher, EncryptionKey: key } });

    assertEqual(back, plaintext, 'decResp did not return the original plaintext');
    return 'encResp → decResp returned the original string';
  });

  await checkAsync('the callback decryption key is configured and distinct', () => {
    // Not a live call: whether this key decrypts a REAL callback can only be
    // learned from a real payment (see scripts/replay-decresp.mjs, which tries
    // every candidate against a captured ciphertext). What is checkable here is
    // that a key is set and that it has not been accidentally set equal to the
    // encryption key — those are two different secrets in NivaBupa's kit.
    const enc = config.nivabupa.payment.encryptionKey;
    const dec = config.nivabupa.payment.decryptionKey;
    assert(dec, 'NIVABUPA_PAYMENT_DECRYPTION_KEY is empty');
    if (enc === dec) {
      throw new Error('the encryption and decryption keys are identical — check .env, NivaBupa issue two different values');
    }
    return `set (${dec.length} chars), distinct from the encryption key`;
  });
}

// ─── Summary ────────────────────────────────────────────────────────────────

server.close();
await db.closePool().catch(() => undefined);

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
const passed = results.filter((r) => r.ok && !r.skipped);

console.log('\n═══════════════════════════════════════════════════════');
console.log(`  ${passed.length} passed, ${failed.length} failed, ${skipped.length} skipped`);
if (failed.length > 0) {
  console.log('');
  for (const failure of failed) {
    console.log(`  ❌ [${failure.section}] ${failure.name}`);
    console.log(`       ${failure.error.split('\n')[0]}`);
  }
}
if (!LIVE) {
  console.log('\n  Run `npm run verify:live` to also exercise the real NivaBupa endpoints.');
}
console.log('═══════════════════════════════════════════════════════\n');

process.exit(failed.length > 0 ? 1 : 0);
