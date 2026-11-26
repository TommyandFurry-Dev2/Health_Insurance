// ─────────────────────────────────────────────────────────────────────────────
// The common tables of the health purchase store (migration 008):
// health_purchases, health_customers, health_purchase_members, health_payments,
// health_purchase_events, health_policy_documents — plus the one INSERT every
// health_<insurer>_api_logs table shares.
//
// Plain SQL only. Every function takes `run`, the {query, queryOne, insert}
// surface of db.runner(connection), so one purchase step writes all of its rows
// in one transaction (services/healthPurchase.service.js owns those). Values
// arrive here already encrypted, hashed and masked; nothing in this file sees a
// key. Unlike log.repository.js, NOTHING here swallows its own errors: the
// service decides what a failure means.
// ─────────────────────────────────────────────────────────────────────────────

const PURCHASE_COLUMNS = `
  id, purchase_ref, customer_id, insurer_code, insurer_env, product_code, product_name,
  plan_variant, cover_type, sum_insured, tenure_years, payment_frequency, adults, children,
  quoted_premium, final_premium, gst_amount, proposal_number, application_number, policy_number,
  policy_issue_date, policy_start_date, policy_end_date, status, kyc_status, proposal_status,
  payment_status, policy_status, needs_review, review_reason, channel, agent_code, frontend_app,
  source, legacy_ref, version, created_at, updated_at, completed_at`;

const PAYMENT_COLUMNS = `
  id, purchase_id, insurer_code, payment_ref, attempt_no, gateway, amount, currency, paid_amount,
  status, gateway_txn_id, bank_ref_no, payment_method, failure_reason, verified_via, verified_at,
  callback_count, frontend_return_url, refund_ref, refund_amount, refunded_at, initiated_at,
  completed_at, created_at, updated_at`;

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

/** "`a` = ?, `b` = ?" + params, for the given {column: value} map. */
export function setClause(columns, { keepExisting = false } = {}) {
  const sets = [];
  const params = [];
  for (const [column, value] of Object.entries(columns)) {
    if (value === undefined) continue;
    if (!IDENTIFIER.test(column)) throw new Error(`bad column name ${column}`);
    if (keepExisting) {
      // A value given replaces; NULL keeps what is already there.
      sets.push(`\`${column}\` = COALESCE(?, \`${column}\`)`);
    } else {
      sets.push(`\`${column}\` = ?`);
    }
    params.push(value);
  }
  return { sql: sets.join(', '), params };
}

/** INSERT INTO `table` (cols…) VALUES (?…) for the given {column: value} map. */
export function insertSql(table, columns) {
  if (!IDENTIFIER.test(table)) throw new Error(`bad table name ${table}`);
  const names = Object.keys(columns).filter((c) => columns[c] !== undefined);
  for (const name of names) if (!IDENTIFIER.test(name)) throw new Error(`bad column name ${name}`);
  return {
    sql: `INSERT INTO \`${table}\` (${names.map((n) => `\`${n}\``).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    params: names.map((n) => columns[n]),
  };
}

export const isDuplicate = (error) => error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;

// ── health_purchases ────────────────────────────────────────────────────────

export async function insertPurchase(run, columns) {
  const { sql, params } = insertSql('health_purchases', columns);
  return run.insert(sql, params);
}

export async function findPurchaseById(run, id, { forUpdate = false } = {}) {
  return run.queryOne(
    `SELECT ${PURCHASE_COLUMNS} FROM health_purchases WHERE id = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [id]
  );
}

export async function findPurchaseByRef(run, purchaseRef) {
  return run.queryOne(`SELECT ${PURCHASE_COLUMNS} FROM health_purchases WHERE purchase_ref = ?`, [purchaseRef]);
}

/** Plan and unified-view fields: a value given replaces, NULL keeps. */
export async function patchPurchase(run, id, columns) {
  const { sql, params } = setClause(columns, { keepExisting: true });
  if (!sql) return 0;
  const result = await run.query(
    `UPDATE health_purchases SET ${sql}, \`version\` = \`version\` + 1 WHERE id = ?`,
    [...params, id]
  );
  return result.affectedRows;
}

/** Status columns, already checked by the service as forward moves. */
export async function setPurchaseStatuses(run, id, statuses) {
  const allowed = ['status', 'kyc_status', 'proposal_status', 'payment_status', 'policy_status'];
  const columns = {};
  for (const [column, value] of Object.entries(statuses)) {
    if (!allowed.includes(column)) throw new Error(`not a status column: ${column}`);
    columns[column] = value;
  }
  const { sql, params } = setClause(columns);
  if (!sql) return 0;
  const result = await run.query(
    `UPDATE health_purchases SET ${sql}, \`version\` = \`version\` + 1 WHERE id = ?`,
    [...params, id]
  );
  return result.affectedRows;
}

export async function flagPurchaseForReview(run, id, reason) {
  await run.query(
    `UPDATE health_purchases SET needs_review = 1, review_reason = LEFT(?, 255), \`version\` = \`version\` + 1
     WHERE id = ?`,
    [String(reason || 'needs review'), id]
  );
}

// ── health_customers ────────────────────────────────────────────────────────

/**
 * The customer for a purchase: the one with this PAN if there is one, else the
 * purchase's current customer (unless that customer has a DIFFERENT PAN, which
 * means a different person), else a new row. Columns given replace, NULLs keep.
 */
export async function upsertCustomer(run, { existingId = null, customerRef, columns }) {
  let targetId = null;
  if (columns.pan_hash) {
    const byPan = await run.queryOne('SELECT id FROM health_customers WHERE pan_hash = ? FOR UPDATE', [columns.pan_hash]);
    targetId = byPan?.id ?? null;
  }
  if (!targetId && existingId) {
    const current = await run.queryOne('SELECT id, pan_hash FROM health_customers WHERE id = ? FOR UPDATE', [existingId]);
    if (current && (!current.pan_hash || !columns.pan_hash || current.pan_hash === columns.pan_hash)) targetId = current.id;
  }

  if (targetId) {
    const { sql, params } = setClause(columns, { keepExisting: true });
    if (sql) await run.query(`UPDATE health_customers SET ${sql} WHERE id = ?`, [...params, targetId]);
    return targetId;
  }

  const { sql, params } = insertSql('health_customers', { customer_ref: customerRef, ...columns });
  try {
    return await run.insert(sql, params);
  } catch (error) {
    // Two first purchases with one PAN at once: the other insert won.
    if (!isDuplicate(error) || !columns.pan_hash) throw error;
    const winner = await run.queryOne('SELECT id FROM health_customers WHERE pan_hash = ?', [columns.pan_hash]);
    return winner.id;
  }
}

// ── health_purchase_members ─────────────────────────────────────────────────

/**
 * Makes the purchase's members of one role exactly `members` (each a column
 * map with member_seq 1…n). Rows beyond n are removed: they belonged to an
 * earlier version of the same proposal, which the insurer log still holds.
 */
export async function replaceMembers(run, purchaseId, role, members) {
  for (const member of members) {
    const existing = await run.queryOne(
      'SELECT id FROM health_purchase_members WHERE purchase_id = ? AND role = ? AND member_seq = ?',
      [purchaseId, role, member.member_seq]
    );
    if (existing) {
      const { sql, params } = setClause(member);
      await run.query(`UPDATE health_purchase_members SET ${sql} WHERE id = ?`, [...params, existing.id]);
    } else {
      const { sql, params } = insertSql('health_purchase_members', { purchase_id: purchaseId, role, ...member });
      await run.insert(sql, params);
    }
  }
  await run.query(
    'DELETE FROM health_purchase_members WHERE purchase_id = ? AND role = ? AND member_seq > ?',
    [purchaseId, role, members.length]
  );
}

// ── health_purchase_events ──────────────────────────────────────────────────

/** Inserts one event. A repeated idempotency_key is reported, not thrown. */
export async function insertEvent(run, columns) {
  const { sql, params } = insertSql('health_purchase_events', columns);
  try {
    return { inserted: true, id: await run.insert(sql, params) };
  } catch (error) {
    if (isDuplicate(error) && columns.idempotency_key) return { inserted: false, id: null };
    throw error;
  }
}

// ── health_payments ─────────────────────────────────────────────────────────

export async function findPaymentByRef(run, insurerCode, paymentRef, { forUpdate = false } = {}) {
  return run.queryOne(
    `SELECT ${PAYMENT_COLUMNS} FROM health_payments WHERE insurer_code = ? AND payment_ref = ?${forUpdate ? ' FOR UPDATE' : ''}`,
    [insurerCode, paymentRef]
  );
}

export async function nextPaymentAttempt(run, purchaseId) {
  const row = await run.queryOne(
    'SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next FROM health_payments WHERE purchase_id = ?',
    [purchaseId]
  );
  return Number(row?.next ?? 1);
}

export async function insertPayment(run, columns) {
  const { sql, params } = insertSql('health_payments', columns);
  return run.insert(sql, params);
}

export async function updatePayment(run, id, columns) {
  const { sql, params } = setClause(columns);
  if (!sql) return 0;
  const result = await run.query(`UPDATE health_payments SET ${sql} WHERE id = ?`, [...params, id]);
  return result.affectedRows;
}

// ── health_policy_documents ─────────────────────────────────────────────────

/** Stores one document; the same bytes stored twice for a purchase return the first row. */
export async function insertDocument(run, columns) {
  const existing = await run.queryOne(
    'SELECT id FROM health_policy_documents WHERE purchase_id = ? AND document_type = ? AND sha256 = ?',
    [columns.purchase_id, columns.document_type, columns.sha256]
  );
  if (existing) return { id: existing.id, inserted: false };
  const { sql, params } = insertSql('health_policy_documents', columns);
  try {
    return { id: await run.insert(sql, params), inserted: true };
  } catch (error) {
    if (!isDuplicate(error)) throw error;
    const winner = await run.queryOne(
      'SELECT id FROM health_policy_documents WHERE purchase_id = ? AND document_type = ? AND sha256 = ?',
      [columns.purchase_id, columns.document_type, columns.sha256]
    );
    return { id: winner.id, inserted: false };
  }
}

// ── health_<insurer>_api_logs ───────────────────────────────────────────────

const API_LOG_TABLES = new Set([
  'health_niva_api_logs', 'health_iffco_api_logs', 'health_fg_api_logs',
  'health_icici_api_logs', 'health_chola_api_logs', 'health_galaxy_api_logs',
]);

export async function insertApiLog(run, table, columns) {
  if (!API_LOG_TABLES.has(table)) throw new Error(`not an insurer log table: ${table}`);
  const { sql, params } = insertSql(table, columns);
  return run.insert(sql, params);
}

/** The payload hash of the newest row for this call and reference: an unchanged poll is not logged twice. */
export async function lastLoggedPayloadHash(run, table, apiName, correlationId) {
  if (!API_LOG_TABLES.has(table)) throw new Error(`not an insurer log table: ${table}`);
  const row = await run.queryOne(
    `SELECT payload_sha256 FROM \`${table}\` WHERE api_name = ? AND correlation_id = ? ORDER BY id DESC LIMIT 1`,
    [apiName, correlationId]
  );
  return row?.payload_sha256 ?? null;
}
