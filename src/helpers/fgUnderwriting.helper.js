import { PRODUCTS, FG_SI_FLOORS_BY_LOCATION } from '../constants/fg.constants.js';
import { validationError } from './fg.helper.js';

// ─────────────────────────────────────────────────────────────────────────────
// Future Generali's Health Absolute underwriting rules that their service does
// NOT enforce, held here instead.
//
// Source: the "UW Validation Secnarios" sheet of "Field Masters for Health
// Absolute.xlsx" (also shipped as "Health Absolute - UW Validation Test
// Secnarios File.xlsx"). FG test a partner portal against that sheet — their
// observations of 2026-10-26 quote it row for row — so wherever their service
// prices or accepts what the sheet forbids, the refusal has to happen here.
//
//   Rows 10/11  Smoking / Tobacco "Yes" → automatic 5% loading. FG's rating
//               engine applies it from <Smoking> and <Tobacco> on the QUOTE
//               (UAT 2026-10-26, one member at 500000: 11,043 with both N,
//               11,595.15 with either Y, 12,147.30 with both). Nothing is
//               computed here; the flags only have to be Y or N.
//   Rows 15-20  The health declarations. Each stops the journey on the answer
//               the sheet names. Two have elements on the wire (<IsGoodHealth>,
//               <IsExistingAbsolutePolicy>); the other four have none, so a
//               caller passes them as `member.declarations` and they are
//               checked here and never sent.
//   Row 22      Surat — see FG_SI_FLOORS_BY_LOCATION.
//
// Health Absolute only: the sheet is that product's, and the other products
// carry none of these elements.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The six declarations, in the sheet's order and in its words. `stopsOn` is the
 * answer the sheet says must not proceed. `field` is where the answer is read
 * from on a member; `element` is the <Member> tag it travels in, when it has one.
 */
const FHA_DECLARATIONS = Object.freeze([
  {
    row: 15, field: 'isExistingAbsolutePolicy', element: 'IsExistingAbsolutePolicy', stopsOn: 'Y',
    question: 'Is the person already have Future Health Absolute policy of Future Generali?',
  },
  {
    row: 16, field: 'isGoodHealth', element: 'IsGoodHealth', stopsOn: 'N',
    question: 'Is the person in good health and free from physical and mental disease or '
      + 'infirmity or medical complaints or deformity?',
  },
  {
    row: 17, field: 'declarations.illness', element: null, stopsOn: 'Y',
    question: 'Is the person have at present or in the past had any health complaints, signs or '
      + 'symptoms, or were taking treatment or were hospitalized for any illness?',
  },
  {
    row: 18, field: 'declarations.accident', element: null, stopsOn: 'Y',
    question: 'Is the person at present or in the past met with any accident / injury or were '
      + 'hospitalized or taking treatment for any accident injury?',
  },
  {
    row: 19, field: 'declarations.surgery', element: null, stopsOn: 'Y',
    question: 'Is the person undergone any surgery in the past or going for any planned surgery '
      + 'at present / recent future?',
  },
  {
    row: 20, field: 'declarations.declinedPolicy', element: null, stopsOn: 'Y',
    question: 'Whether any Health Insurance Policy has been declined?',
  },
]);

/** Member fields that must be FG's Y/N, before any rule reads them. */
const YES_NO_FIELDS = ['smoking', 'tobacco', 'isGoodHealth', 'isExistingAbsolutePolicy'];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

/**
 * FG's flags are Y or N. "Yes"/"No" and booleans are accepted and converted —
 * the meaning is not in doubt. Anything else is refused: <Smoking> moves the
 * premium, and a value FG do not recognise is a premium nobody can predict.
 *
 * @returns {'Y'|'N'|null} null when nothing was supplied
 */
function toYesNo(value, field) {
  if (isBlank(value)) return null;
  if (value === true) return 'Y';
  if (value === false) return 'N';
  const raw = String(value).trim().toUpperCase();
  if (raw === 'Y' || raw === 'YES') return 'Y';
  if (raw === 'N' || raw === 'NO') return 'N';
  throw validationError(`${field} must be Y or N — got ${JSON.stringify(value)}.`, field,
    { got: value, expects: ['Y', 'N'] });
}

function readPath(obj, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), obj);
}

function formatRupees(amount) {
  return `₹${Number(amount).toLocaleString('en-IN')}`;
}

/**
 * Row 22. The floor follows the proposer's pincode, and the policy type decides
 * which of the two minimums applies.
 */
function checkLocationFloor(payload, productDef) {
  const pincode = String(payload.client?.address1?.pincode ?? '').trim();
  if (!pincode) return;

  const floor = FG_SI_FLOORS_BY_LOCATION.find((f) => f.pincodes.has(pincode));
  if (!floor) return;

  const policyType = payload.risk?.policyType || productDef.defaultPolicyType;
  const floater = policyType === 'HAF';
  const minimum = floater ? floor.floater : floor.individual;
  const members = Array.isArray(payload.risk?.members) ? payload.risk.members : [];

  members.forEach((member, index) => {
    const sumInsured = Number(member.sumInsured);
    if (Number.isFinite(sumInsured) && sumInsured < minimum) {
      throw validationError(
        `Future Generali's minimum sum insured in ${floor.location} (pincode ${pincode}) is `
        + `${formatRupees(minimum)} on ${floater ? 'a family floater' : 'an individual'} policy — `
        + `risk.members[${index}] asks for ${formatRupees(sumInsured)}.`,
        `risk.members[${index}].sumInsured`,
        { location: floor.location, pincode, policyType, minimum, got: sumInsured }
      );
    }
  });
}

/**
 * Apply Health Absolute's underwriting rules, and return the payload with its
 * Y/N flags normalised. Runs on the quote AND the proposal: a refused answer is
 * refused wherever it appears, and a Surat floater under the floor must not be
 * priced at all ("FGI Quote should not generated").
 *
 * Nothing is required here — an absent flag keeps the builder's default (N for
 * the lifestyle flags, Y/N for the two declarations FG sample) — so a caller
 * that does not ask these questions yet keeps working. Only an answer the sheet
 * stops on is refused.
 *
 * Never mutates the caller's object.
 *
 * @param {object} payload { client, risk, ... }
 * @param {object} productDef one of constants.PRODUCTS.*
 */
function validateUnderwriting(payload = {}, productDef) {
  if (productDef?.key !== PRODUCTS.HEALTH_ABSOLUTE.key) return payload;

  checkLocationFloor(payload, productDef);

  const members = Array.isArray(payload.risk?.members) ? payload.risk.members : [];
  const normalised = members.map((member, index) => {
    const at = `risk.members[${index}]`;
    const next = { ...member };
    let changed = false;

    YES_NO_FIELDS.forEach((field) => {
      const value = toYesNo(member[field], `${at}.${field}`);
      if (value !== null && value !== member[field]) {
        next[field] = value;
        changed = true;
      }
    });

    FHA_DECLARATIONS.forEach((declaration) => {
      const answer = toYesNo(readPath(next, declaration.field), `${at}.${declaration.field}`);
      if (answer === declaration.stopsOn) {
        throw validationError(
          `${at} (FG "Member ${index + 1}") answered ${answer === 'Y' ? 'Yes' : 'No'} to "${declaration.question}" `
          + "Future Generali's Health Absolute underwriting does not allow the proposal to "
          + `continue on that answer (UW Validation Scenarios, row ${declaration.row}).`,
          `${at}.${declaration.field}`,
          { row: declaration.row, element: declaration.element, answer, stopsOn: declaration.stopsOn }
        );
      }
    });

    return changed ? next : member;
  });

  if (normalised.every((m, i) => m === members[i])) return payload;
  return { ...payload, risk: { ...payload.risk, members: normalised } };
}

export { validateUnderwriting, toYesNo, FHA_DECLARATIONS };
