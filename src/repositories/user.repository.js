import crypto from 'node:crypto';
import db from '../db/index.js';
import { clamp } from '../utils/sanitize.js';

// Buyers live in the host application's EXISTING `users` table (Laravel auth),
// not in a nivabupa-owned copy, so one person is one row across both
// applications. That table's shape constrains this repository:
//
//   id       BIGINT UNSIGNED PK
//   name     VARCHAR(255)  NOT NULL          ← no default; must be supplied
//   email    VARCHAR(255)  NOT NULL, UNIQUE  ← no default; must be supplied
//   password VARCHAR(255)  NOT NULL          ← no default; must be supplied
//   mobile   VARCHAR(15)   NULL, UNIQUE      ← added by migrations/002
//
// There is no uuid column and no deleted_at, so this repository does not expose
// a public uuid or soft-delete users — both belong to whoever owns that table.
// The journey's own uuid is the public handle the SPA uses; nothing here needs
// to identify a user externally.
const SELECT_COLUMNS = 'id, name, email, mobile, created_at, updated_at';

// `password` is NOT NULL on a table the host app authenticates against, so a
// buyer row cannot be created without one. This writes a value that no password
// can ever match: bcrypt/Argon verification against a string that is not a
// valid hash always fails, so a journey buyer who never registered cannot be
// logged in as. The '!' prefix is the conventional marker for exactly this.
function unusablePassword() {
  return `!nivabupa-journey-no-login!${crypto.randomBytes(16).toString('hex')}`;
}

// email is NOT NULL and UNIQUE. A buyer who reaches a quote has given a mobile
// but not necessarily an email yet (it only becomes mandatory at
// payment/initiate), so a deterministic placeholder derived from the mobile
// keeps the insert legal and stays stable across retries — a random one would
// create a second row for the same buyer on every attempt. Replaced with the
// real address as soon as one arrives.
function placeholderEmail(mobile) {
  return `nivabupa+${String(mobile).replace(/\D/g, '')}@journey.invalid`;
}

function isPlaceholderEmail(email) {
  return typeof email === 'string' && email.endsWith('@journey.invalid');
}

async function findById(id, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE id = ? LIMIT 1`,
    [id]
  );
}

async function findByMobile(mobile, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE mobile = ? LIMIT 1`,
    [mobile]
  );
}

async function findByEmail(email, connection = null) {
  return db.runner(connection).queryOne(
    `SELECT ${SELECT_COLUMNS} FROM users WHERE email = ? LIMIT 1`,
    [email]
  );
}

// Mobile is the journey identity key, so this is the only entry point that
// creates or attaches a buyer.
//
// Lookup order matters. Mobile first (the journey's own key), then email —
// because email is UNIQUE on this table and an existing host-app account with
// the same address must be reused rather than collided with. Inserting a second
// row for a known email would fail on the unique index; matching it instead
// links the journey to the account the buyer already has.
async function findOrCreateByMobile(details = {}, connection = null) {
  const run = db.runner(connection);

  const mobile = clamp(details.mobile, 15);
  if (!mobile) throw new Error('mobile is required to identify a journey user');

  const email = clamp(details.email, 255) || null;
  const name = clamp(details.fullName, 255) || null;

  const existing = (await findByMobile(mobile, connection))
    || (email ? await findByEmail(email, connection) : null);

  if (existing) {
    // COALESCE(?, column) keeps the stored value when the incoming one is null,
    // so a later step supplying an email or a full name enriches the row while a
    // step that omits them never blanks it.
    //
    // email is guarded further: a real address may replace a placeholder, but a
    // placeholder must never overwrite a real one, and the host app's own
    // address must not be clobbered by a journey form.
    await run.query(
      `UPDATE users SET
         mobile = COALESCE(mobile, ?),
         name   = COALESCE(NULLIF(name, ''), ?, name),
         email  = IF(? IS NOT NULL AND email LIKE '%@journey.invalid', ?, email)
       WHERE id = ?`,
      [mobile, name, email, email, existing.id]
    );
    return findById(existing.id, connection);
  }

  await run.insert(
    'INSERT INTO users (name, email, mobile, password, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
    [
      name || `Journey ${mobile}`,
      email || placeholderEmail(mobile),
      mobile,
      unusablePassword(),
    ]
  );

  return findByMobile(mobile, connection);
}

export {
  findById,
  findByMobile,
  findByEmail,
  findOrCreateByMobile,
  isPlaceholderEmail,
};
