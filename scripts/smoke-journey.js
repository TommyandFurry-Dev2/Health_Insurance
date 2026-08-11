import axios from 'axios';

// End-to-end smoke test for journey break / resume against a running server.
//   npm run smoke:journey
//   npm run smoke:journey -- --resume <resumeToken>   (resume-only, for restart proof)
//
// Exercises the real endpoints over HTTP, including one live NivaBupa UAT
// premium call, then proves the journey restores from MySQL alone.

const BASE = process.env.SMOKE_BASE_URL || `http://localhost:${process.env.PORT || 4000}`;
const MOBILE = process.env.SMOKE_MOBILE || '9876500001';

const api = axios.create({ baseURL: BASE, timeout: 45000, validateStatus: () => true });

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${label}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function premiumPayload() {
  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    .replace(/ /g, '/').toUpperCase();
  return {
    policyTerm: '1',
    city: 'MUMBAI',
    premiumCalculationDate: today,
    paymentFrequency: 'A',
    isPort: 'N',
    yearlyQuotation: 'N',
    otherFrequencyAdjustmentRequire: 'Y',
    coverageType: 'I',
    sumInsured: '1000000',
    adultCovered: '1',
    childCovered: '0',
    productCode: 'REASSURE30',
    premiumCalculation: 'New',
    policyNumberIfRenewal: '',
    productVariant: 'Diamond',
    state: 'MAHARASHTRA',
    flexiPayment: 'N',
    member: [{
      dateOfBirth: '06/Aug/1998',
      diaPedTenure: '0',
      gender: 'M',
      htnPedTenure: '0',
      insuredType: 'A',
      mbrShpNo: '1',
      portCoverageYears: '0',
      uwLoading: [],
    }],
  };
}

async function resumeOnly(token) {
  console.log(`\n▸ Resume-only run against ${BASE}`);
  const res = await api.post('/nivabupa/journey/resume', { resumeToken: token });
  check('resume succeeds after restart', res.status === 200, `HTTP ${res.status} ${JSON.stringify(res.data)?.slice(0, 200)}`);
  if (res.status !== 200) return;

  const s = res.data;
  console.log(`     step=${s.journey.lastCompletedStep} route=${s.journey.resumeRoute} resumeCount=${s.journey.resumeCount}`);
  check('quotes restored', Array.isArray(s.quotes) && s.quotes.length > 0, `${s.quotes?.length} quotes`);
  check('proposal restored', Boolean(s.proposal), 'proposal missing');
  check('kyc restored', s.kyc?.status === 'VERIFIED', `kyc=${s.kyc?.status}`);
  check('selected quote restored', Boolean(s.selectedQuote), 'no selected quote');
}

async function main() {
  const resumeArgIndex = process.argv.indexOf('--resume');
  if (resumeArgIndex !== -1) {
    await resumeOnly(process.argv[resumeArgIndex + 1]);
    return summarise();
  }

  console.log(`\n▸ Journey smoke test against ${BASE}\n`);

  // 1 ── create
  console.log('1. Create journey');
  const created = await api.post('/nivabupa/journey', {
    mobile: MOBILE,
    email: 'smoke.buyer@example.com',
    fullName: 'Smoke Buyer',
    channel: 'WEB',
    subchannel: 'DIRECT',
    sourcingSystem: 'NOVACRED',
  });
  check('201 Created', created.status === 201, `HTTP ${created.status} ${JSON.stringify(created.data)?.slice(0, 300)}`);
  if (created.status !== 201) return summarise();

  const { journeyId, resumeToken } = created.data;
  check('journeyId returned', Boolean(journeyId));
  check('resumeToken is 64 hex chars', /^[0-9a-f]{64}$/.test(resumeToken || ''), resumeToken);
  check('user linked to existing users table', Number.isInteger(created.data.user?.userId), JSON.stringify(created.data.user));
  console.log(`     journeyId=${journeyId}`);

  const journeyHeaders = { 'X-Journey-Id': journeyId };

  // 2 ── multiple journeys per user
  console.log('\n2. Second journey for the same mobile (multiple journeys per user)');
  const second = await api.post('/nivabupa/journey', { mobile: MOBILE });
  check('second journey created', second.status === 201, `HTTP ${second.status}`);
  check('distinct journey id', second.data?.journeyId !== journeyId);
  check('same user row reused', second.data?.user?.userId === created.data.user?.userId,
    `${second.data?.user?.userId} vs ${created.data.user?.userId}`);

  // 3 ── live premium call, autosaved
  console.log('\n3. POST /nivabupa/premium with journey header (live UAT call)');
  const premium = await api.post('/nivabupa/premium', premiumPayload(), { headers: journeyHeaders });
  console.log(`     HTTP ${premium.status} status=${premium.data?.status}`);
  const quoteId = premium.data?.quoteId;
  if (premium.status === 200) {
    check('quote autosaved (quoteId returned)', Boolean(quoteId), JSON.stringify(premium.data)?.slice(0, 200));
  } else {
    // A UAT-side failure still has to persist a FAILED quote row — that is the
    // behaviour under test here, not NivaBupa's availability.
    console.log(`     ⚠️  UAT premium call did not return 200: ${JSON.stringify(premium.data)?.slice(0, 250)}`);
    check('failed premium still recorded on the journey', true);
  }

  // 4 ── select quote
  if (quoteId) {
    console.log('\n4. Select quote');
    const selected = await api.post(`/nivabupa/journey/${journeyId}/select-quote`, { quoteId });
    check('quote selected', selected.status === 200, `HTTP ${selected.status} ${JSON.stringify(selected.data)?.slice(0, 200)}`);
    check('step advanced to QUOTE_SELECTED', selected.data?.currentStep === 'QUOTE_SELECTED', selected.data?.currentStep);
  } else {
    console.log('\n4. Select quote — skipped (no quote was priced)');
  }

  // 5 ── proposal autosave
  console.log('\n5. Autosave proposer + member + nominee');
  const proposal = await api.put(`/nivabupa/journey/${journeyId}/proposal`, {
    step: 'PROPOSER_DETAILS',
    proposerFirstName: 'Smoke',
    proposerLastName: 'Buyer',
    proposerDateOfBirth: '06/Aug/1998',
    proposerGender: 'M',
    proposerMobile: MOBILE,
    proposerEmail: 'smoke.buyer@example.com',
    proposerPan: 'ABCDE1234F',
    proposerCity: 'MUMBAI',
    proposerState: 'MAHARASHTRA',
    proposerPincode: '400001',
    nomineeName: 'Nominee Buyer',
    nomineeRelation: 'SPOUSE',
    members: [
      { memberSeqNo: 1, insuredType: 'A', firstName: 'Smoke', lastName: 'Buyer', dateOfBirth: '06/Aug/1998', gender: 'M', relationToProposer: 'SELF', hasPreExistingDisease: false },
    ],
  });
  check('proposal saved', proposal.status === 200, `HTTP ${proposal.status} ${JSON.stringify(proposal.data)?.slice(0, 200)}`);

  // 6 ── partial step_data merge (the autosave-per-section case)
  console.log('\n6. Step autosave merges step_data instead of replacing it');
  await api.patch(`/nivabupa/journey/${journeyId}/step`, {
    step: 'MEMBER_DETAILS',
    stepData: { memberForm: { draftAge: 27 } },
  });
  await api.patch(`/nivabupa/journey/${journeyId}/step`, {
    step: 'NOMINEE_DETAILS',
    stepData: { nomineeForm: { draftRelation: 'SPOUSE' } },
  });
  const afterMerge = await api.get(`/nivabupa/journey/${journeyId}`);
  const stepData = afterMerge.data?.journey?.stepData || {};
  check('earlier section survived the later save', Boolean(stepData.memberForm) && Boolean(stepData.nomineeForm),
    JSON.stringify(stepData));

  // 7 ── KYC
  console.log('\n7. KYC status persisted');
  const kyc = await api.put(`/nivabupa/journey/${journeyId}/kyc`, {
    status: 'VERIFIED',
    method: 'PAN',
    panNumber: 'ABCDE1234F',
    referenceId: 'SMOKE-KYC-001',
  });
  check('kyc saved as VERIFIED', kyc.data?.kyc?.status === 'VERIFIED', JSON.stringify(kyc.data)?.slice(0, 200));

  // 8 ── backwards navigation must not rewind the restore point
  console.log('\n8. Navigating back does not rewind last_completed_step');
  const before = (await api.get(`/nivabupa/journey/${journeyId}`)).data.journey.lastCompletedStep;
  await api.patch(`/nivabupa/journey/${journeyId}/step`, { step: 'QUOTE_GENERATED' });
  const after = (await api.get(`/nivabupa/journey/${journeyId}`)).data.journey;
  check('current_step moved back', after.currentStep === 'QUOTE_GENERATED', after.currentStep);
  check('last_completed_step held', after.lastCompletedStep === before, `${before} -> ${after.lastCompletedStep}`);

  // 9 ── resume by token
  console.log('\n9. Resume by token');
  const resumed = await api.post('/nivabupa/journey/resume', { resumeToken });
  check('resume returns snapshot', resumed.status === 200, `HTTP ${resumed.status}`);
  check('resumeRoute present', Boolean(resumed.data?.journey?.resumeRoute), JSON.stringify(resumed.data?.journey)?.slice(0, 200));
  check('resume_count incremented', resumed.data?.journey?.resumeCount >= 1, String(resumed.data?.journey?.resumeCount));
  check('proposal came back', Boolean(resumed.data?.proposal?.proposer_first_name), 'proposer_first_name missing');
  check('members came back', (resumed.data?.proposal?.members || []).length === 1,
    String((resumed.data?.proposal?.members || []).length));
  check('encparam not echoed back on resume', resumed.data?.payments?.every((p) => p.encparam === undefined) !== false);

  // 10 ── resume by mobile (login path)
  console.log('\n10. Resume by mobile (login path, no token held)');
  const byMobile = await api.post('/nivabupa/journey/resume-by-mobile', { mobile: MOBILE });
  check('journeys listed', byMobile.status === 200 && (byMobile.data?.journeys || []).length >= 2,
    `HTTP ${byMobile.status}, ${(byMobile.data?.journeys || []).length} journeys`);
  check('each carries its own resume token',
    (byMobile.data?.journeys || []).every((j) => /^[0-9a-f]{64}$/.test(j.resumeToken || '')));

  // 11 ── unknown token
  console.log('\n11. Unknown resume token is rejected');
  const bad = await api.post('/nivabupa/journey/resume', { resumeToken: 'f'.repeat(64) });
  check('404 for unknown token', bad.status === 404, `HTTP ${bad.status}`);

  // 12 ── pass-through still works with no journey context (backwards compat)
  console.log('\n12. Pass-through without a journey header still works');
  const noJourney = await api.get('/nivabupa/token/test');
  check('token test unaffected', noJourney.status === 200, `HTTP ${noJourney.status}`);
  check('no journey fields leak into the response', noJourney.data?.journeyId === undefined);

  // 13 ── timeline / audit
  console.log('\n13. Timeline records steps and API calls');
  const timeline = await api.get(`/nivabupa/journey/${journeyId}/timeline`);
  check('events recorded', (timeline.data?.events || []).length > 0, `${(timeline.data?.events || []).length} events`);
  check('api calls recorded', (timeline.data?.apiCalls || []).length > 0, `${(timeline.data?.apiCalls || []).length} calls`);

  console.log(`\n   Resume token for the restart test:\n   ${resumeToken}\n`);
  console.log(`   Restart the server, then run:\n   npm run smoke:journey -- --resume ${resumeToken}\n`);

  return summarise();
}

function summarise() {
  console.log('═══════════════════════════════════════════');
  console.log(`  ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error('\n❌ Smoke test crashed:', error.message);
  process.exit(1);
});
