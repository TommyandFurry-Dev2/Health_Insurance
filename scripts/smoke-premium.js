import axios from 'axios';
import config from '../src/config/env.js';

// Smoke test for NivaBupa's direct partner API (Reassure 3.0) — talks to the
// vendor with no server of ours in between, so token + premium can be verified
// in isolation. When this passes but POST /nivabupa/premium fails, the problem
// is ours; when both fail, it is NivaBupa's.
// Usage: npm run smoke:premium

const TOKEN_URL = config.nivabupa.tokenUrl;
const PREMIUM_URL = config.nivabupa.premiumUrl;
const CLIENT_ID = config.nivabupa.clientId;

async function getToken() {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: config.nivabupa.clientSecret,
    scope: config.nivabupa.scope,
    Identifier: 'Partner',
    Identifier_code: config.nivabupa.identifierCode
  });

  console.log('POST', TOKEN_URL);
  const resp = await axios.post(TOKEN_URL, params, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    },
    timeout: config.timeouts.token
  });
  console.log('TOKEN STATUS:', resp.status);
  console.log(JSON.stringify(resp.data, null, 2));
  return resp.data.access_token;
}

async function getPremium(token) {
  // Same shape as the sample "premium request.txt" from the Reassure 3.0 UAT
  // API kit — one adult, Diamond variant, 10L SI, annual payment, 1 year term.
  const payload = {
    policyTerm: '1',
    city: 'MUMBAI',
    premiumCalculationDate: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).replace(/ /g, '/').toUpperCase(),
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
    member: [
      {
        dateOfBirth: '06/Aug/1998',
        diaPedTenure: '0',
        gender: 'M',
        htnPedTenure: '0',
        insuredType: 'A',
        mbrShpNo: '1',
        portCoverageYears: '0',
        uwLoading: []
      }
    ]
  };

  console.log('\nPOST', PREMIUM_URL);
  const resp = await axios.post(PREMIUM_URL, payload, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'clientId': CLIENT_ID,
      'Content-Type': 'application/json'
    },
    timeout: config.timeouts.api
  });
  console.log('PREMIUM STATUS:', resp.status);
  console.log(JSON.stringify(resp.data, null, 2));
}

try {
  const token = await getToken();
  await getPremium(token);
} catch (err) {
  console.error('ERROR STATUS:', err.response?.status);
  console.error(JSON.stringify(err.response?.data || err.message, null, 2));
}
