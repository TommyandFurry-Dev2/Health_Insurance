import {
  FG_OCCUPATION,
  FG_RELATION,
  FG_RELATION_QUOTE_ONLY,
  FG_NOMINEE_RELATION,
  FG_SALUTATION,
  FG_MARITAL_STATUS,
  FG_GENDER,
  FG_POLICY_TYPE,
  METHOD,
} from '../constants/fg.constants.js';
import { validationError } from './fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Local validation of Future Generali's CODED fields.
//
// This file exists because of the specific way FG reject a wrong code, and
// because of WHEN they do it.
//
//   * The QUOTE leg does not check them at all. A proposal-breaking occupation
//     prices perfectly, so the buyer picks a plan, fills in a proposal form, and
//     only then hits the wall.
//   * The PROPOSAL leg answers with a bare sentence naming the field and nothing
//     else — "Occupation is incorrect." No code, no field path, no indication of
//     what the accepted values are, and no way to tell which of several members
//     carried the bad value.
//
// So the same failure is moved forward to the request that caused it, and given
// the one thing FG's own answer lacks: the accepted values.
//
// ── Deliberately advisory-strict ────────────────────────────────────────────
// FG's runtime accepts a SUPERSET of their published masters. Their own FHA and
// FAT samples send <NomineeRelation>BROT</NomineeRelation>, which appears in no
// master sheet, and a live probe on 2026-08-11 found the occupation 'STUD'
// accepted although the master publishes 'STDN' for Student.
//
// Two consequences, both deliberate:
//   * Rejecting a value outside the master is still right — it is a value FG
//     would almost certainly reject too, and this rejection is far more useful
//     than theirs. But the message says the value is not in FG's PUBLISHED list
//     rather than claiming FG will refuse it.
//   * Nothing here is enforced on a quote. Only CRT.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FG's own samples are inconsistent about <NomineeRelation>: every Health
 * Absolute sample sends the code (`FATH`), every Advantage Top Up sample sends
 * `SPOU`, but the Varishta Bima samples and parts of the shared Postman
 * collection send plain mixed case ("Mother", "Brother", "Spouse").
 *
 * For the two products implemented here the evidence is unambiguous — coded,
 * in all ten FHA and FAT samples — so plain English is accepted and NORMALISED
 * to the code rather than refused. That is a correction toward FG's documented
 * form for these products, not a guess: each mapping below is a label FG
 * themselves publish for that exact code in the Nominee Relations master.
 */
const NOMINEE_RELATION_FROM_LABEL = Object.freeze({
  SELF: 'SELF',
  SON: 'SON',
  SPOUSE: 'SPOU',
  WIFE: 'WIFE',
  HUSBAND: 'HUSB',
  CHILD: 'CHLD',
  DAUGHTER: 'DAUG',
  MOTHER: 'MOTH',
  FATHER: 'FATH',
  // Not in the master sheet, but present in FG's own sample payloads — so it is
  // accepted rather than refused, and left exactly as FG write it.
  BROTHER: 'BROT',
});

/** Codes FG's samples use that their master sheets do not list. */
const UNDOCUMENTED_BUT_OBSERVED = Object.freeze({
  nomineeRelation: new Set(['BROT']),
  // 'STUD' passed HealthPreCRTValidate on UAT 2026-08-11 although the master
  // publishes 'STDN'. Accepted so a working integration is not broken by this
  // file; 'STDN' is what should be sent.
  occupation: new Set(['STUD']),
});

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * "Did you mean…" for a rejected code.
 *
 * The occupation master alone has 140 entries, so listing them in an error
 * message is not help — it is a wall. Matching the supplied value against the
 * DESCRIPTIONS instead turns the common mistake (sending the English word) into
 * the answer: 'Service' → SVCM, 'Housewife' → HSWF, 'Retired' → RETR.
 */
function suggest(master, value, limit = 6) {
  const needle = String(value).trim().toLowerCase();
  if (!needle) return [];
  const scored = [];
  for (const [code, description] of Object.entries(master)) {
    const desc = String(description).toLowerCase();
    let score = 0;
    if (code.toLowerCase() === needle) score = 100;
    else if (desc === needle) score = 90;
    else if (desc.startsWith(needle) || needle.startsWith(desc)) score = 70;
    else if (desc.includes(needle) || needle.includes(desc)) score = 50;
    else if (code.toLowerCase().startsWith(needle.slice(0, 3))) score = 20;
    if (score) scored.push({ code, description, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

function formatSuggestions(hits) {
  if (!hits.length) return '';
  return ` Did you mean ${hits.map((h) => `${h.code} (${h.description})`).join(', ')}?`;
}

/**
 * Check one coded value against a master.
 *
 * @param {object} p
 * @param {string} p.value    what the caller supplied
 * @param {object} p.master   code → description
 * @param {string} p.field    the request path, for the error
 * @param {string} p.element  the FG element name, for the error
 * @param {Set}    [p.alsoAccept] codes FG accept but do not publish
 * @param {boolean} [p.listAll] name every valid code (small masters only)
 * @returns {string|null} the value to send, or null when nothing was supplied
 */
function checkCode({ value, master, field, element, alsoAccept, listAll = true }) {
  if (isBlank(value)) return null;
  const raw = String(value).trim();

  if (Object.prototype.hasOwnProperty.call(master, raw)) return raw;
  if (alsoAccept && alsoAccept.has(raw)) return raw;

  // Case-insensitive match on the code itself — a caller sending 'svcm' meant
  // SVCM, and refusing that would be pedantry rather than protection.
  const exact = Object.keys(master).find((code) => code.toLowerCase() === raw.toLowerCase());
  if (exact) return exact;

  const valid = listAll
    ? ` Valid: ${Object.entries(master).map(([c, d]) => `${c} (${d})`).join(', ')}.`
    : ` Future Generali publish ${Object.keys(master).length} codes for this field.`;

  throw validationError(
    `${field} "${raw}" is not one of Future Generali's published <${element}> codes.`
    + `${formatSuggestions(suggest(master, raw))}${valid}`,
    field,
    { got: raw, element, validCodes: Object.keys(master) }
  );
}

/**
 * Normalise and validate <NomineeRelation>, accepting FG's own plain-English
 * spellings and converting them to the code every FHA and FAT sample uses.
 */
function normaliseNomineeRelation(value, field) {
  if (isBlank(value)) return null;
  const raw = String(value).trim();

  if (Object.prototype.hasOwnProperty.call(FG_NOMINEE_RELATION, raw)) return raw;
  if (UNDOCUMENTED_BUT_OBSERVED.nomineeRelation.has(raw)) return raw;

  const mapped = NOMINEE_RELATION_FROM_LABEL[raw.toUpperCase()];
  if (mapped) return mapped;

  throw validationError(
    `${field} "${raw}" is not one of Future Generali's <NomineeRelation> codes.`
    + `${formatSuggestions(suggest(FG_NOMINEE_RELATION, raw))}`
    + ` Valid: ${Object.entries(FG_NOMINEE_RELATION).map(([c, d]) => `${c} (${d})`).join(', ')}.`,
    field,
    { got: raw, element: 'NomineeRelation', validCodes: Object.keys(FG_NOMINEE_RELATION) }
  );
}

/**
 * Validate every coded field in an FG payload, and return the payload with the
 * nominee relations normalised to FG's codes.
 *
 * Runs on CRT ONLY. On a quote FG check none of this and price the risk
 * regardless, so enforcing it there would break quoting to fix proposals — the
 * same reasoning that governs the height/weight checks in fgXml.helper.js.
 *
 * Never mutates the caller's object.
 *
 * @param {object} payload { client, risk, ... }
 * @param {'ENQ'|'CRT'} method
 */
function validateCodedFields(payload = {}, method) {
  if (method !== METHOD.CREATE) return payload;

  const client = payload.client || {};

  checkCode({
    value: client.salutation, master: FG_SALUTATION,
    field: 'client.salutation', element: 'Salutation',
  });
  checkCode({
    value: client.gender, master: FG_GENDER,
    field: 'client.gender', element: 'Gender',
  });
  checkCode({
    value: client.maritalStatus, master: FG_MARITAL_STATUS,
    field: 'client.maritalStatus', element: 'MaritalStatus',
  });
  checkCode({
    value: client.occupation, master: FG_OCCUPATION,
    field: 'client.occupation', element: 'Occupation',
    alsoAccept: UNDOCUMENTED_BUT_OBSERVED.occupation,
    // 140 codes is a wall, not help — the suggestions carry the useful part.
    listAll: false,
  });

  const risk = payload.risk || {};

  if (!isBlank(risk.policyType)) {
    checkCode({
      value: risk.policyType, master: FG_POLICY_TYPE,
      field: 'risk.policyType', element: 'PolicyType',
    });
  }

  const members = Array.isArray(risk.members) ? risk.members : [];
  const normalisedMembers = members.map((member, index) => {
    // FG number members from 1 and report failures that way, so errors here
    // must too — a reply about "Member 2" has to point at risk.members[1].
    const at = `risk.members[${index}]`;

    checkCode({
      value: member.insuredGender, master: FG_GENDER,
      field: `${at}.insuredGender`, element: 'InsuredGender',
    });
    checkCode({
      value: member.insuredOccupation, master: FG_OCCUPATION,
      field: `${at}.insuredOccupation`, element: 'InsuredOccpn',
      alsoAccept: UNDOCUMENTED_BUT_OBSERVED.occupation,
      listAll: false,
    });

    const relation = checkCode({
      value: member.relation, master: FG_RELATION,
      field: `${at}.relation`, element: 'Relation',
    });
    // The master marks Siblings, Grandparent and Grandchild "Only Quote" —
    // offered for quotation on Platinum & Signature, not issuable. FG's own
    // rejection for one of these on a proposal names nothing useful.
    if (relation && FG_RELATION_QUOTE_ONLY.has(relation)) {
      throw validationError(
        `${at}.relation "${relation}" (${FG_RELATION[relation]}) is quotation-only in Future `
        + "Generali's master — it cannot be carried on a proposal or an issued policy.",
        `${at}.relation`,
        { got: relation, quoteOnly: [...FG_RELATION_QUOTE_ONLY] }
      );
    }

    const nomineeRelation = normaliseNomineeRelation(
      member.nomineeRelation, `${at}.nomineeRelation`
    );

    return nomineeRelation && nomineeRelation !== member.nomineeRelation
      ? { ...member, nomineeRelation }
      : member;
  });

  const changed = normalisedMembers.some((m, i) => m !== members[i]);
  if (!changed) return payload;
  return { ...payload, risk: { ...risk, members: normalisedMembers } };
}

export {
  validateCodedFields,
  checkCode,
  normaliseNomineeRelation,
  suggest,
  NOMINEE_RELATION_FROM_LABEL,
  UNDOCUMENTED_BUT_OBSERVED,
};
