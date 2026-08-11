import db from '../db/index.js';
import { newUuid, toMysqlDate, toDecimal, toInt, clamp } from '../utils/sanitize.js';

const SELECT_COLUMNS = `
  id, uuid, journey_id, status, product_code, product_variant, policy_term,
  coverage_type, sum_insured, payment_frequency, premium_calculation,
  premium_calculation_date, adult_covered, child_covered, city, state, zone,
  is_port, flexi_payment, policy_number_if_renewal,
  base_premium, gst_amount, discount_amount, total_premium,
  request_payload, response_payload, error_message, api_transaction_id,
  created_at, updated_at, deleted_at
`;

// ── Premium extraction ──────────────────────────────────────────────────────
//
// Confirmed against a live UAT response (2026-07-30), whose actual shape is:
//
//   premiumResponse.premiumPaymentFrequencies[]        ← Single / Half Yearly / …
//     .premiumDetails[]                                ← one entry per tenureYear
//       .premiumDetail
//         .netPremium / .grossPremium / .taxAmount
//         .basePremium.totalBasePremium
//         .adjustmentDetails[]   { adjustmentCode, adjustmentPremium }
//
// Two things this must get right, and a naive key search gets wrong:
//
//   1. The response prices EVERY payment frequency, not just the one asked for
//      (Single 6865, Half Yearly 3481, Quarterly 1750, Monthly 590 for the same
//      cover). Grabbing the first premium found would store a quarter of the
//      annual premium as the annual premium. So the frequency is matched against
//      the request's own paymentFrequency code, and the tenure against its
//      policyTerm.
//   2. basePremium is larger than grossPremium here (7342 vs 6865) because
//      adjustments net out negative: 7342 + 734 zonal loading − 1211 vintage
//      discount = 6865. Storing basePremium as the payable amount would overstate
//      the price by 7%, so total_premium comes from grossPremium and
//      discount_amount is derived from the negative adjustments.
//
// The full response is retained verbatim in response_payload regardless, so a
// shape change costs a display value, never data.

// Request paymentFrequency code → response paymentFrequency label. 'A' (Annual)
// maps to 'Single' because for an annual-payment policy the premium is taken
// once per term, which is how NivaBupa labels that row.
const FREQUENCY_LABELS = {
  A: 'single',
  S: 'single',
  Y: 'single',
  H: 'half yearly',
  Q: 'quarterly',
  M: 'monthly',
};

function normalizeLabel(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Sums the negative entries of adjustmentDetails[]. Positive adjustments are
// loadings (zonal, UW) and are already inside grossPremium — only the discounts
// are surfaced as a discount figure.
function sumDiscounts(adjustmentDetails) {
  if (!Array.isArray(adjustmentDetails)) return null;
  const total = adjustmentDetails.reduce((sum, adjustment) => {
    const value = toDecimal(adjustment?.adjustmentPremium);
    return value !== null && value < 0 ? sum + Math.abs(value) : sum;
  }, 0);
  return total > 0 ? total : null;
}

// Generic deep search, used only if the documented path is absent. Depth 8
// because the real premium sits six levels down — the previous limit of 3 never
// reached it.
function deepFindNumber(node, candidates, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return null;

  for (const key of candidates) {
    if (node[key] !== undefined && node[key] !== null && node[key] !== '') {
      const value = toDecimal(node[key]);
      if (value !== null) return value;
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = deepFindNumber(value, candidates, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
}

function extractPremium(response, request = {}) {
  const empty = { basePremium: null, gstAmount: null, discountAmount: null, totalPremium: null };
  if (!response || typeof response !== 'object') return empty;

  const root = response.premiumResponse || response.PremiumResponse || response;
  const frequencies = root.premiumPaymentFrequencies || root.PremiumPaymentFrequencies;

  if (Array.isArray(frequencies) && frequencies.length > 0) {
    const wantedLabel = FREQUENCY_LABELS[String(request.paymentFrequency || '').trim().toUpperCase()];
    const wantedTenure = String(request.policyTerm || '').trim();

    // Fall back to the first priced frequency rather than nothing: a stored
    // premium for an unmatched frequency is still better than a blank quote
    // card, and the verbatim response is there for reconciliation.
    const frequency = frequencies.find((entry) => normalizeLabel(entry?.paymentFrequency) === wantedLabel)
      || frequencies[0];

    const details = frequency?.premiumDetails || frequency?.PremiumDetails || [];
    const detail = (Array.isArray(details)
      ? details.find((entry) => String(entry?.tenureYear || '').trim() === wantedTenure) || details[0]
      : null);

    const premium = detail?.premiumDetail || detail?.PremiumDetail;
    if (premium) {
      return {
        basePremium: toDecimal(premium.basePremium?.totalBasePremium ?? premium.basePremium),
        gstAmount: toDecimal(premium.taxAmount),
        discountAmount: sumDiscounts(premium.adjustmentDetails),
        // grossPremium is the payable amount; netPremium is the same value when
        // tax is zero, so it is the fallback rather than a separate concept.
        totalPremium: toDecimal(premium.grossPremium) ?? toDecimal(premium.netPremium),
      };
    }
  }

  return {
    basePremium: deepFindNumber(root, ['totalBasePremium', 'basePremium', 'base_premium']),
    gstAmount: deepFindNumber(root, ['taxAmount', 'gstAmount', 'gst_amount', 'gst']),
    discountAmount: deepFindNumber(root, ['discountAmount', 'discount_amount', 'totalDiscount']),
    totalPremium: deepFindNumber(root, ['grossPremium', 'totalPremium', 'total_premium', 'finalPremium', 'netPremium']),
  };
}

// Inserts the quote row and its member rows together. Always called inside a
// transaction by the caller: a quote whose member[] failed to write would
// restore a screen showing the wrong number of insured people at the right
// premium, which is worse than not restoring at all.
async function createFromPremiumCall(
  { journeyId, requestPayload, responsePayload, status, errorMessage, apiTransactionId },
  connection = null
) {
  const run = db.runner(connection);
  const uuid = newUuid();
  const payload = requestPayload || {};
  // Needs the request as well as the response: the response prices every
  // payment frequency, and only the request says which one was asked for.
  const premium = extractPremium(responsePayload, payload);

  const quoteId = await run.insert(
    `INSERT INTO nivabupa_journey_quotes (
       uuid, journey_id, status, product_code, product_variant, policy_term,
       coverage_type, sum_insured, payment_frequency, premium_calculation,
       premium_calculation_date, adult_covered, child_covered, city, state, zone,
       is_port, flexi_payment, policy_number_if_renewal,
       base_premium, gst_amount, discount_amount, total_premium,
       request_payload, response_payload, error_message, api_transaction_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      uuid,
      journeyId,
      status,
      clamp(payload.productCode, 50) || null,
      clamp(payload.productVariant, 50) || null,
      clamp(payload.policyTerm, 10) || null,
      clamp(payload.coverageType, 10) || null,
      toDecimal(payload.sumInsured),
      clamp(payload.paymentFrequency, 10) || null,
      clamp(payload.premiumCalculation, 20) || null,
      clamp(payload.premiumCalculationDate, 20) || null,
      toInt(payload.adultCovered),
      toInt(payload.childCovered),
      clamp(payload.city, 100) || null,
      clamp(payload.state, 100) || null,
      clamp(payload.zone, 20) || null,
      clamp(payload.isPort, 1) || null,
      clamp(payload.flexiPayment, 1) || null,
      clamp(payload.policyNumberIfRenewal, 80) || null,
      premium.basePremium,
      premium.gstAmount,
      premium.discountAmount,
      premium.totalPremium,
      db.toJson(payload),
      db.toJson(responsePayload),
      errorMessage ? String(errorMessage).slice(0, 65535) : null,
      apiTransactionId || null,
    ]
  );

  if (Array.isArray(payload.member) && payload.member.length > 0) {
    await replaceMembers(quoteId, payload.member, connection);
  }

  return run.queryOne(`SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_quotes WHERE id = ?`, [quoteId]);
}

// Delete-then-insert rather than an upsert: mbrShpNo is the natural key but a
// buyer removing a child shifts the remaining sequence numbers, so a merge
// would leave an orphaned highest-numbered row. The quote's member set is
// replaced as a unit.
async function replaceMembers(quoteId, members, connection = null) {
  const run = db.runner(connection);
  await run.query('DELETE FROM nivabupa_journey_quote_members WHERE quote_id = ?', [quoteId]);

  for (let index = 0; index < members.length; index += 1) {
    const member = members[index] || {};
    await run.insert(
      `INSERT INTO nivabupa_journey_quote_members (
         quote_id, member_seq_no, insured_type, date_of_birth_raw, date_of_birth,
         gender, dia_ped_tenure, htn_ped_tenure, port_coverage_years, uw_loading
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        quoteId,
        toInt(member.mbrShpNo) ?? index + 1,
        clamp(member.insuredType, 1) || null,
        clamp(member.dateOfBirth, 20) || null,
        toMysqlDate(member.dateOfBirth),
        clamp(member.gender, 1) || null,
        toInt(member.diaPedTenure),
        toInt(member.htnPedTenure),
        toInt(member.portCoverageYears),
        db.toJson(member.uwLoading),
      ]
    );
  }
}

async function findById(quoteId, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_quotes WHERE id = ? AND deleted_at IS NULL`,
    [quoteId]
  );
}

async function findByUuid(uuid, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_quotes WHERE uuid = ? AND deleted_at IS NULL`,
    [uuid]
  );
}

async function findMembers(quoteId, connection = null) {
  return db.runner(connection).query(
    `SELECT id, member_seq_no, insured_type, date_of_birth_raw, date_of_birth, gender,
            dia_ped_tenure, htn_ped_tenure, port_coverage_years, uw_loading
     FROM nivabupa_journey_quote_members WHERE quote_id = ? ORDER BY member_seq_no ASC`,
    [quoteId]
  );
}

// Successful quotes first, newest first — the comparison screen only shows
// quotes that actually priced, and FAILED rows are kept for diagnostics.
async function listByJourney(journeyId, { successOnly = false, connection = null } = {}) {
  return db.runner(connection).query(
    `SELECT ${SELECT_COLUMNS} FROM nivabupa_journey_quotes
     WHERE journey_id = ? AND deleted_at IS NULL
     ${successOnly ? "AND status = 'SUCCESS'" : ''}
     ORDER BY created_at DESC`,
    [journeyId]
  );
}

async function softDelete(quoteId, connection = null) {
  await db.runner(connection).query(
    'UPDATE nivabupa_journey_quotes SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL',
    [quoteId]
  );
}

export {
  createFromPremiumCall,
  replaceMembers,
  findById,
  findByUuid,
  findMembers,
  listByJourney,
  softDelete,
  extractPremium,
  sumDiscounts,
  FREQUENCY_LABELS,
};
