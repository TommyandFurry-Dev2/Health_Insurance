import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { getPath, isEmpty } from './galaxy.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// GHI's data dictionary for Galaxy Marvel (GALMARVEL_Data_Dictionary.ods, sheet
// DATA_GXGLXYMRVL), which GHI supplied when it deprecated getDomain (29 Oct
// 2026). constants/galaxy/GALMARVEL_Data_Dictionary.json holds the workbook's
// cell text verbatim (sha256 of the .ods recorded in its `source`); this module
// only indexes it.
//
// Reference data, not validation: GHI has not confirmed every entry, so a code
// that is not listed here is not proof that GHI will reject it. Lookups are
// exact: nothing is trimmed, re-cased or reconciled.
//
// Moved from the working implementation (reference/marvelDictionary.js and
// quickQuoteCheck.js). checkQuickQuote is what the quickQuote route logs before
// a quote goes out — information only, nothing is refused on it.
// ─────────────────────────────────────────────────────────────────────────────

const DICTIONARY_FILE = fileURLToPath(new URL('../constants/galaxy/GALMARVEL_Data_Dictionary.json', import.meta.url));
const dictionary = JSON.parse(fs.readFileSync(DICTIONARY_FILE, 'utf8'));

const SHEET = 'DATA_GXGLXYMRVL';

// Key → GHI's "Data Item" (column A), spelled exactly as in the workbook. The
// member and nominee relationship lists are separate items in GHI's file.
export const DATA_ITEMS = Object.freeze({
  policyTenure: 'Policy Tenure',
  policyDurationUnit: 'Policy Duration Unit',
  premiumFrequency: 'Premium Frequency',
  planType: 'Plan Type',
  applicableSumInsured: 'Applicable Sum Insured',
  partyType: 'Party Type',
  title: 'Title',
  gender: 'Gender',
  maritalStatus: 'Marital Status',
  nationality: 'Nationality',
  occupation: 'Occupation',
  hniCustomer: 'HNI Customer',
  mailingAddressSameAsPrimary: 'Is The Mailing/Communication Address Same As The Primary Address?',
  intermediaryCode: 'Intermediary Code',
  addressType: 'Select Type of Address',
  proposerIsPayer: 'Is proposer also the Payer ?',
  city: 'City',
  businessType: 'Business Type',
  state: 'State',
  country: 'Country',
  nomineeRelationship: 'Relationship with Proposer',
  primarySecondary: 'Primary / Secondary',
  cover: 'Cover',
  familySize: 'Family Size',
  memberStatus: 'MemberStatus',
  policyTerm: 'Policy Term',
  typeOfRenewal: 'Type of Renewal',
  memberSubstatus: 'Member Substatus',
  memberRelationship: 'Relationship',
});

export const SOURCE = Object.freeze({ ...dictionary.source });

const rows = Object.freeze(dictionary.sheets[SHEET].rows.map((r) => Object.freeze({ ...r })));

// GHI's Cover rows hold the cover code under "Attribute Name" and its
// description under "Code"; every other item has them the other way round.
const toEntry = (r) => Object.freeze(r.dataItem === DATA_ITEMS.cover
  ? { code: r.attributeName, name: r.code, row: r.row }
  : { code: r.code, name: r.attributeName, row: r.row });

const ENTRIES = Object.freeze(Object.fromEntries(Object.entries(DATA_ITEMS).map(([key, item]) => [
  key, Object.freeze(rows.filter((r) => r.dataItem === item).map(toEntry)),
])));

export function entries(key) {
  const list = ENTRIES[key];
  if (!list) throw new Error(`Unknown Galaxy Marvel dictionary item "${key}"`);
  return list;
}

export const codes = (key) => entries(key).map((e) => e.code);

/** The entry whose code is exactly `code`, or null. */
export const find = (key, code) => entries(key).find((e) => e.code === code) || null;

export const isListed = (key, code) => find(key, code) !== null;

// ── quickQuote pre-flight ───────────────────────────────────────────────────

// The spec's conditions name these two plan types.
const FLOATER = 'FLOATER';
const INDIVIDUAL = 'IND';

// Fields GHI's "GX-quickQuote-Marvel V2" spec marks M, or CM with its condition
// met. memberDetails.deductibleOptions / deductiblePerClaim are marked O there,
// but GHI UAT fails the quote without both (25 Nov 2026: both missing →
// statusCode "500" [{"members":[]}], one missing → HTTP 500), so they are
// reported under `required` too.
export const MANDATORY = Object.freeze({
  top: ['productCode', 'applicationNumber', 'basicDetails', 'members'],
  basicDetails: ['proposerPinCode', 'intermediaryName', 'plan', 'planType', 'policyTenure', 'premiumFrequency',
    'sourceCode', 'typeOfBusiness', 'quoteStartDate', 'numberOfMembers', 'policyStartDate', 'quoteExpiryDate'],
  basicDetailsIfFloater: ['applicableSumInsured', 'familySize'],
  memberDetails: ['age', 'gender', 'relationship', 'dateOfBirth', 'whetherAnNRI'],
  memberDetailsIfIndividual: ['applicableSumInsured'],
  memberDetailsGhiUat: ['deductibleOptions', 'deductiblePerClaim'],
});

// Request field → dictionary item holding its codes.
const CODED = Object.freeze({
  basicDetails: {
    planType: 'planType', policyTenure: 'policyTenure', premiumFrequency: 'premiumFrequency',
    typeOfBusiness: 'businessType', familySize: 'familySize', applicableSumInsured: 'applicableSumInsured',
  },
  memberDetails: { gender: 'gender', relationship: 'memberRelationship', applicableSumInsured: 'applicableSumInsured' },
  cover: { coverCode: 'cover' },
});

/**
 * `missing`: mandatory fields that are empty. `notInDictionary`: coded values
 * GHI's dictionary does not list. Both information only.
 */
export function checkQuickQuote(body = {}) {
  const missing = [];
  const notInDictionary = [];
  const need = (obj, fields, prefix) => fields.forEach((f) => {
    if (isEmpty(getPath(obj, f))) missing.push(`${prefix}${f}`);
  });
  const coded = (obj, map, prefix) => Object.entries(map).forEach(([field, item]) => {
    const value = obj ? obj[field] : undefined;
    if (!isEmpty(value) && !isListed(item, String(value))) {
      notInDictionary.push({ field: `${prefix}${field}`, value, dictionaryItem: DATA_ITEMS[item] });
    }
  });

  need(body, MANDATORY.top, '');
  const basic = body.basicDetails || {};
  need(basic, MANDATORY.basicDetails, 'basicDetails.');
  if (basic.planType === FLOATER) need(basic, MANDATORY.basicDetailsIfFloater, 'basicDetails.');
  coded(basic, CODED.basicDetails, 'basicDetails.');

  (Array.isArray(body.members) ? body.members : []).forEach((m, i) => {
    const details = (m && m.memberDetails) || {};
    const prefix = `members[${i}].memberDetails.`;
    need(details, MANDATORY.memberDetails, prefix);
    need(details, MANDATORY.memberDetailsGhiUat, prefix);
    if (basic.planType === INDIVIDUAL) need(details, MANDATORY.memberDetailsIfIndividual, prefix);
    coded(details, CODED.memberDetails, prefix);
    (Array.isArray(m && m.covers) ? m.covers : []).forEach((c, j) => coded(c, CODED.cover, `members[${i}].covers[${j}].`));
  });

  return { missing, notInDictionary };
}
