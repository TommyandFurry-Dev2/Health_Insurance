// ─────────────────────────────────────────────────────────────────────────────
// Database setup for a deployed server — the one command to run after
// `git pull` on a new server, or whenever migrations/ has moved on.
//
//   npm run db:check                          read-only: can this server reach
//                                             its database, and what is pending?
//   npm run db:setup                          check → back up `users` → migrate
//                                             → confirm (asks before changing)
//   npm run db:setup -- --yes --restart nivabupa
//                                             same, unattended, then restarts the
//                                             pm2 app and waits for /readyz
//
// Flags:
//   --check          change nothing; report only (what db:check runs)
//   --yes            do not ask before migrating
//   --skip-backup    do not dump `users` before migration 002 alters it — only
//                    when you have taken your own backup
//   --restart <app>  `pm2 restart <app>` afterwards, then wait for /readyz
//
// Why it exists: a server whose .env still carries placeholder credentials
// (UAT had DB_USERNAME=REPLACE_ME) starts anyway — journey persistence just
// degrades — but Niva Bupa KYC refuses to start without a database, so the
// buyer sees "KYC could not be recorded". This stops at the first missing
// piece and names it, instead of that surfacing in the UI.
//
// The migrations are migrations/*.sql, applied by scripts/migrate.js; this only
// wraps them. They are additive and idempotent: nivabupa_* tables, plus one
// change to the host application's `users` table (002: a nullable `mobile`
// column and a unique key) — which is why `users` is dumped to backups/ first.
//
// mysqldump is looked up on PATH; set MYSQLDUMP=/path/to/mysqldump otherwise.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');

// config/env.js reads .env from the working directory, so run from the app
// root whichever directory this was started in.
process.chdir(ROOT);
const { default: config } = await import('../src/config/env.js');

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\nimport ')[0]);
  process.exit(0);
}
const CHECK_ONLY = args.includes('--check');
const ASSUME_YES = args.includes('--yes');
const SKIP_BACKUP = args.includes('--skip-backup');
const restartAt = args.indexOf('--restart');
const PM2_APP = restartAt >= 0 ? args[restartAt + 1] : null;
if (restartAt >= 0 && (!PM2_APP || PM2_APP.startsWith('--'))) {
  fail('--restart needs the pm2 app name, e.g. --restart nivabupa');
}

const { host, port, database, user, password } = config.db;
const USERS_MIGRATION = '002_add_mobile_to_users.sql';
// Values a template or a hand-edited .env leaves behind in place of a real one.
const PLACEHOLDER = /^(replace_?me|change_?me|your[_-].*|<.*>|x{3,}|todo|null|undefined)$/i;

function fail(message) {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((file) => file.endsWith('.sql')).sort();
}

// Migrations run in whatever database DB_DATABASE names — none of them names a
// schema. This guards that: a file that did (`USE \`some_db\``) would create
// its tables where the app never looks unless the two agreed.
function migrationSchemas() {
  const names = new Set();
  for (const file of migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of sql.matchAll(/\bUSE\s+`([^`]+)`/gi)) names.add(match[1]);
  }
  return [...names];
}

function explainConnectError(error) {
  switch (error.code) {
    case 'ER_ACCESS_DENIED_ERROR':
      return `MySQL refused '${user}' — the username or password in .env is wrong.`;
    case 'ECONNREFUSED':
      return `Nothing is listening on ${host}:${port}. Is MySQL running, and are DB_HOST / DB_PORT right?`;
    case 'ENOTFOUND':
      return `DB_HOST '${host}' does not resolve.`;
    case 'ETIMEDOUT':
      return `Timed out connecting to ${host}:${port} — firewall, or the wrong host.`;
    default:
      return `Could not connect to ${host}:${port}: ${error.message}`;
  }
}

// Heuristic, so a warning rather than a stop: MySQL 8 roles can grant what
// SHOW GRANTS does not spell out.
function missingPrivileges(grantLines) {
  const needed = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX'];
  const onThisDb = new RegExp(`\\bON\\s+(\\*|\`?${database.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?)\\.\\*`, 'i');
  const have = new Set();
  for (const raw of grantLines) {
    const line = raw.replace(/\\_/g, '_');
    if (!/^GRANT\s/i.test(line) || !onThisDb.test(line)) continue;
    const privileges = line.replace(/^GRANT\s+/i, '').split(/\s+ON\s+/i)[0];
    if (/ALL PRIVILEGES/i.test(privileges)) return [];
    for (const privilege of privileges.split(',')) have.add(privilege.trim().toUpperCase());
  }
  return needed.filter((privilege) => !have.has(privilege));
}

// Read-only. Returns what is wrong (problems stop the run; warnings do not)
// and which migrations are pending.
async function preflight() {
  const problems = [];
  const warnings = [];
  for (const [name, value] of [['DB_HOST', host], ['DB_DATABASE', database], ['DB_USERNAME', user]]) {
    const text = String(value ?? '').trim();
    if (!text || PLACEHOLDER.test(text)) problems.push(`${name} is "${text}" — not a real value.`);
  }
  if (password && PLACEHOLDER.test(String(password).trim())) problems.push('DB_PASSWORD is a placeholder, not a real value.');
  if (!password) warnings.push('DB_PASSWORD is empty.');

  const schemas = migrationSchemas();
  if (schemas.length && !schemas.includes(database)) {
    problems.push(`DB_DATABASE is "${database}", but migrations/*.sql create their tables in ${schemas.map((s) => `"${s}"`).join(', ')}. `
      + 'Set DB_DATABASE to that, or the app will look for its tables where they are not.');
  }
  if (problems.length) return { problems, warnings };

  let connection;
  try {
    connection = await mysql.createConnection({ host, port, user, password, connectTimeout: config.db.connectTimeout });
  } catch (error) {
    return { problems: [explainConnectError(error)], warnings };
  }

  try {
    const [[schema]] = await connection.query('SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
    const databaseExists = schema.n > 0;
    let applied = new Set();
    let usersExists = false;
    if (databaseExists) {
      const [tables] = await connection.query(
        `SELECT TABLE_NAME AS name FROM information_schema.TABLES
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('users', 'nivabupa_schema_migrations')`,
        [database]
      );
      const names = new Set(tables.map((table) => table.name));
      usersExists = names.has('users');
      if (names.has('nivabupa_schema_migrations')) {
        const [rows] = await connection.query(`SELECT filename FROM ${mysql.escapeId(database)}.nivabupa_schema_migrations`);
        applied = new Set(rows.map((row) => row.filename));
      }
    }

    const pending = migrationFiles().filter((file) => !applied.has(file));
    if (pending.includes(USERS_MIGRATION) && !usersExists) {
      problems.push(`No \`users\` table in "${database}". Migration ${USERS_MIGRATION} alters it — `
        + 'DB_DATABASE must be the main application\'s schema.');
    }

    const [grants] = await connection.query('SHOW GRANTS');
    const missing = missingPrivileges(grants.map((row) => Object.values(row)[0]));
    if (missing.length) warnings.push(`'${user}' may be missing ${missing.join(', ')} on "${database}" — migrations need CREATE, ALTER and INDEX.`);

    return { problems, warnings, databaseExists, usersExists, applied, pending };
  } finally {
    await connection.end();
  }
}

// Dumps only `users` — the one pre-existing table a migration touches. The
// password goes through a 0600 option file, never the command line.
function backupUsers() {
  const dir = path.join(ROOT, 'backups');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..+$/, '');
  const file = path.join(dir, `${database}-users-${stamp}.sql`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nb-db-'));
  const optionFile = path.join(tmp, 'client.cnf');
  const quote = (value) => `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  fs.writeFileSync(optionFile, `[client]\nuser=${quote(user)}\npassword=${quote(password)}\nhost=${quote(host)}\nport=${port}\n`, { mode: 0o600 });

  const out = fs.openSync(file, 'w', 0o600);
  let result;
  try {
    result = spawnSync(
      process.env.MYSQLDUMP || 'mysqldump',
      // --defaults-extra-file must come first; --no-tablespaces avoids needing
      // the PROCESS privilege on MySQL 8.
      [`--defaults-extra-file=${optionFile}`, '--single-transaction', '--no-tablespaces', database, 'users'],
      { stdio: ['ignore', out, 'pipe'] }
    );
  } finally {
    fs.closeSync(out);
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (result.error || result.status !== 0) {
    fs.rmSync(file, { force: true });
    if (result.error?.code === 'ENOENT') {
      fail('mysqldump not found. Install the MySQL client, set MYSQLDUMP=/path/to/mysqldump, '
        + `or back up ${database}.users yourself and re-run with --skip-backup.`);
    }
    fail(`Backup of ${database}.users failed — nothing was migrated.\n   ${String(result.stderr || result.error?.message || '').trim()}`);
  }
  return { file, bytes: fs.statSync(file).size };
}

async function confirm(question) {
  if (ASSUME_YES) return true;
  if (!process.stdin.isTTY) fail('Not running in a terminal — re-run with --yes to apply without asking.');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

// /readyz is the running app's own verdict on its database. It only changes
// after a restart: the app reads .env once, at startup.
async function readiness({ wait }) {
  const url = `http://127.0.0.1:${config.port}/readyz`;
  const deadline = Date.now() + (wait ? 30000 : 0);
  let last = null;
  do {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
      last = await response.json();
      if (last.status === 'READY') return { url, body: last };
    } catch (error) {
      last = { error: error.cause?.code || error.message };
    }
    if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2000));
  } while (Date.now() < deadline);
  return { url, body: last };
}

function reportReadiness({ url, body }) {
  if (body?.status === 'READY') {
    console.log(`✅ ${url} → READY (database connected)`);
    return true;
  }
  if (body?.error) {
    console.log(`⚠️  ${url} did not answer (${body.error}) — is the app running on port ${config.port}?`);
  } else {
    console.log(`⚠️  ${url} → ${body?.status || 'unknown'}: ${body?.database?.error || JSON.stringify(body)}`);
    console.log('    The running app reads .env only at startup — restart it after fixing .env.');
  }
  return false;
}

// ── Run ──────────────────────────────────────────────────────────────────────

console.log(`\nNiva Bupa backend — database ${CHECK_ONLY ? 'check (read-only)' : 'setup'}`);
console.log(`Target from .env: ${user}@${host}:${port} / ${database} (password ${password ? 'set' : 'EMPTY'})\n`);

const before = await preflight();
for (const warning of before.warnings) console.log(`⚠️  ${warning}`);
if (before.problems.length) {
  for (const problem of before.problems) console.error(`❌ ${problem}`);
  console.error('\nFix .env and run this again. Nothing was changed.'
    + '\n(Every DB_* variable can also be set as NIVABUPA_DB_*, which wins when present.)\n');
  process.exit(1);
}

console.log(`✅ Connected to MySQL as '${user}'.`);
console.log(`   Database "${database}": ${before.databaseExists ? 'exists' : 'does not exist yet — migration 001 creates it'}`);
for (const file of migrationFiles()) console.log(`   ${before.applied.has(file) ? '✅ applied' : '⬜ pending'}  ${file}`);
console.log('');

if (CHECK_ONLY) {
  console.log(before.pending.length ? `${before.pending.length} migration(s) pending — run: npm run db:setup` : '✅ Schema up to date.');
  reportReadiness(await readiness({ wait: false }));
  process.exit(0);
}

if (before.pending.length === 0) {
  console.log('✅ Schema up to date — nothing to migrate.');
} else {
  const touchesUsers = before.pending.includes(USERS_MIGRATION);
  console.log(`Will apply ${before.pending.length} migration(s) to "${database}" on ${host}.`);
  if (touchesUsers) {
    console.log(`${USERS_MIGRATION} adds a nullable \`mobile\` column and a unique key to the existing \`users\` table.`);
    console.log(SKIP_BACKUP ? '--skip-backup: `users` will NOT be backed up first.' : '`users` is backed up to backups/ first.');
  }
  if (!(await confirm('\nProceed? [y/N] '))) {
    console.log('Nothing changed.');
    process.exit(0);
  }

  if (touchesUsers && !SKIP_BACKUP) {
    const backup = backupUsers();
    console.log(`\n✅ Backed up ${database}.users → ${path.relative(ROOT, backup.file)} (${backup.bytes} bytes)`);
  }

  console.log('');
  const run = spawnSync(process.execPath, [path.join('scripts', 'migrate.js')], { stdio: 'inherit' });
  if (run.status !== 0) fail('Migration failed — see above. Fix the cause and re-run; the migrations are idempotent.');

  const after = await preflight();
  if (after.problems?.length || after.pending?.length) {
    fail(`Still pending after migrating: ${(after.pending || []).join(', ') || after.problems.join(' ')}`);
  }
  console.log(`✅ All ${after.applied.size} migrations applied.\n`);
}

if (PM2_APP) {
  console.log(`Restarting pm2 app "${PM2_APP}"…`);
  const restart = spawnSync('pm2', ['restart', PM2_APP, '--update-env'], { stdio: 'inherit', shell: process.platform === 'win32' });
  if (restart.error || restart.status !== 0) fail(`pm2 restart ${PM2_APP} failed — restart the app yourself, then run: npm run db:check`);
  console.log('');
} else {
  console.log('Next: restart the app so it picks up .env (e.g. pm2 restart nivabupa), then run: npm run db:check');
}

const ready = reportReadiness(await readiness({ wait: Boolean(PM2_APP) }));
process.exit(PM2_APP && !ready ? 1 : 0);
