#!/usr/bin/env node
/*
 * Replays a saved NivaBupa `returnMessage` against the decResp SOAP endpoint
 * and prints the complete request and response — endpoint, SOAPAction, the
 * exact XML sent, HTTP status, every response header, and the full body.
 *
 * Why this exists: the failing decResp call only happens inside a live payment
 * callback, so diagnosing it otherwise costs a real payment per attempt. The
 * returnMessage from a callback that already failed is enough to reproduce it
 * on demand, as many times as needed, from whichever host you run this on.
 *
 * It deliberately does NOT go through utils/nivabupaSoap.js — it builds the
 * request itself so what you see printed is literally what goes on the wire,
 * with no shared helper able to hide a difference.
 *
 * Usage, from the repo root:
 *
 *   node scripts/replay-decresp.js "<returnMessage>"
 *   node scripts/replay-decresp.js --file ./returnmessage.txt
 *
 * A returnMessage usually contains '+' and '=', so ALWAYS quote it — an
 * unquoted value gets mangled by the shell and you will be debugging the
 * wrong ciphertext. --file avoids that risk entirely.
 *
 * Add --all-keys to try every known decryption key in turn. That answers "is
 * the key wrong?" directly: the right key returns a pipe-separated record, a
 * wrong one returns a SOAP Fault or an empty result.
 *
 * Run it on the server that receives the callback. Running it from a laptop
 * tests your laptop's IP against NivaBupa's allow-list, not the server's, and
 * the two can differ — which is itself worth knowing, so run it in both places
 * and compare the status codes.
 */

import axios from 'axios';
import { readFileSync } from 'node:fs';
import config from '../src/config/env.js';

const SOAP_URL = config.nivabupa.payment.soapUrl;
const SOAP_ACTION = 'http://tempuri.org/IService1/decResp';

// The configured key first, then the two documented candidates. '!max#bupa@'
// is the one confirmed working on 2026-07-28 against sourcingsystem=
// TOMMYANDFURRY; '!max#bupaNovacred@' is what NivaBupa support gave for
// sourcingsystem=Novacred, which is what the frontend now sends. Those two
// facts disagree, and this script is how you settle which key the current
// payments actually need.
//
// The payment *encryption* key is included as a candidate deliberately. A
// round-trip test against the live service on 2026-08-05 showed encResp/decResp
// are plain symmetric operations over whatever key you hand them — encResp(text,
// K) then decResp(C, K) returns the original for all three keys, and any other
// key yields HTTP 500. So there is no "encryption key" and "decryption key" in
// the service's own design; nothing rules out NivaBupa encrypting the response
// with the same key we encrypt requests under.
const CANDIDATE_KEYS = [
  { label: 'configured (NIVABUPA_PAYMENT_DECRYPTION_KEY)', key: config.nivabupa.payment.decryptionKey },
  { label: 'TOMMYANDFURRY-era key', key: '!max#bupa@' },
  { label: 'Novacred key (per NivaBupa support)', key: '!max#bupaNovacred@' },
  { label: 'payment encryption key (encResp side)', key: config.nivabupa.payment.encryptionKey },
];

function escapeXml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function extractTag(xml, tagName) {
  const match = String(xml).match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`));
  return match ? match[1] : null;
}

// Never print a key in full — enough to tell two keys apart, not enough to leak
// one out of a pasted log.
function fingerprint(key) {
  return `${key.slice(0, 3)}…${key.slice(-3)} (len=${key.length})`;
}

function buildEnvelope(cipherText, encryptionKey) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tem="http://tempuri.org/">
   <soapenv:Header/>
   <soapenv:Body>
      <tem:decResp>
         <tem:cipherText>${escapeXml(cipherText)}</tem:cipherText>
         <tem:EncryptionKey>${escapeXml(encryptionKey)}</tem:EncryptionKey>
      </tem:decResp>
   </soapenv:Body>
</soapenv:Envelope>`;
}

function describeCipherText(raw) {
  console.log('\n===== returnMessage under test =====');
  console.log('  length          :', raw.length);
  console.log('  first 12 chars  :', JSON.stringify(raw.slice(0, 12)));
  console.log('  last 12 chars   :', JSON.stringify(raw.slice(-12)));
  console.log('  base64-shaped   :', /^[A-Za-z0-9+/=\r\n]+$/.test(raw));
  console.log('  length % 4      :', raw.length % 4, raw.length % 4 === 0 ? '(ok)' : '(NOT a valid base64 length)');
  if (raw.includes(' ')) {
    console.log('  ⚠️  contains spaces — a "+" was almost certainly lost in URL decoding.');
    console.log('      That corrupts the ciphertext before it ever reaches NivaBupa.');
  }
}

async function attempt(cipherText, { label, key }) {
  const body = buildEnvelope(cipherText, key);

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('KEY      :', label, '→', fingerprint(key));
  console.log('ENDPOINT :', SOAP_URL);
  console.log('SOAPACTION:', SOAP_ACTION);
  console.log('REQUEST XML (cipherText elided for length):');
  console.log(body.replace(escapeXml(cipherText), `«${cipherText.length} chars»`));

  const startedAt = process.hrtime.bigint();
  let response;
  try {
    response = await axios.post(SOAP_URL, body, {
      headers: { 'Content-Type': 'text/xml', 'SOAPAction': SOAP_ACTION },
      timeout: 20000,
      validateStatus: () => true,
    });
  } catch (error) {
    const ms = Number((process.hrtime.bigint() - startedAt) / 1000000n);
    console.log(`\nNO RESPONSE after ${ms}ms`);
    console.log('  axios code :', error.code || '(none)');
    console.log('  message    :', error.message);
    console.log('  stack      :', error.stack);
    return { key: label, outcome: 'no-response', detail: error.code || error.message };
  }

  const ms = Number((process.hrtime.bigint() - startedAt) / 1000000n);
  console.log(`\nHTTP ${response.status} in ${ms}ms`);
  console.log('RESPONSE HEADERS:');
  for (const [name, value] of Object.entries(response.headers)) {
    console.log(`  ${name}: ${value}`);
  }
  console.log('RESPONSE BODY:');
  console.log(response.data);

  if (response.status < 200 || response.status >= 300) {
    const fault = extractTag(response.data, 'faultstring');
    console.log('\n→ FAILED at HTTP level.', fault ? `SOAP faultstring: ${fault}` : '');
    return { key: label, outcome: `http-${response.status}`, detail: fault || '' };
  }

  const result = extractTag(response.data, 'decRespResult');
  if (result === null) {
    console.log('\n→ HTTP 200 but no <decRespResult> in the envelope.');
    return { key: label, outcome: 'no-result-tag', detail: '' };
  }

  const fields = result.split('|');
  console.log('\n→ DECRYPTED:', result);
  console.log('  field count:', fields.length, '(11 expected)');
  console.log('  paymentStatus (field 7):', fields[6], fields[6] === 'M001' ? '→ SUCCESS' : '→ FAILED_OR_OTHER');
  console.log('  policy number (field 2):', fields[1]);
  console.log('  txn id        (field 6):', fields[5]);
  return { key: label, outcome: 'decrypted', detail: `${fields.length} fields` };
}

async function main() {
  const args = process.argv.slice(2);
  const allKeys = args.includes('--all-keys');
  const fileFlag = args.indexOf('--file');

  let cipherText;
  if (fileFlag !== -1) {
    cipherText = readFileSync(args[fileFlag + 1], 'utf8').trim();
  } else {
    cipherText = (args.find((a) => !a.startsWith('--')) || '').trim();
  }

  if (!cipherText) {
    console.error('Usage: node scripts/replay-decresp.js "<returnMessage>" [--all-keys]');
    console.error('       node scripts/replay-decresp.js --file ./returnmessage.txt [--all-keys]');
    process.exit(2);
  }

  describeCipherText(cipherText);

  const keys = allKeys ? CANDIDATE_KEYS : [CANDIDATE_KEYS[0]];
  const results = [];
  for (const candidate of keys) {
    results.push(await attempt(cipherText, candidate));
  }

  console.log('\n===== SUMMARY =====');
  for (const r of results) {
    console.log(`  ${r.outcome.padEnd(14)} ${r.key}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  // Identical failures across different keys mean the key is not the variable —
  // the request is being stopped before the method ever examines it.
  if (allKeys && new Set(results.map((r) => r.outcome)).size === 1 && results[0].outcome !== 'decrypted') {
    console.log('\n  All keys failed identically → the key is not the cause.');
    console.log('  A blanket 406/403 points at the IP allow-list; a timeout points at egress.');
  }
}

main().catch((error) => {
  console.error('Unexpected failure:', error);
  process.exit(1);
});
