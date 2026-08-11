import mysql from 'mysql2/promise';
import config from '../config/env.js';

// Single pool for the process. The journey tables live in the host Laravel
// application's database (policy_db — which owns the `users` table journeys
// attach to), so this service is a guest in a schema it does not own: it adds
// its own tables and ALTERs exactly one pre-existing one (see migrations/).
//
// Created lazily so importing this module never opens a socket — the migrate
// and smoke scripts both pull in the config tree without wanting a connection,
// and so does createApp() under test.
let pool = null;
let disabled = false;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: config.db.host,
      port: config.db.port,
      user: config.db.user,
      password: config.db.password,
      database: config.db.database,
      waitForConnections: true,
      connectionLimit: config.db.connectionLimit,
      queueLimit: 0,
      connectTimeout: config.db.connectTimeout,
      charset: 'utf8mb4_unicode_ci',
      // The schema stores NivaBupa's own DD/Mon/YYYY strings verbatim in
      // *_raw columns and real DATEs elsewhere. Returning DATE/DATETIME as
      // JS Date objects would re-serialise them through the local timezone on
      // the way out; strings keep what MySQL holds.
      dateStrings: true,
      // Every save is a plain INSERT/UPDATE against one journey — no
      // multi-statement DDL at runtime, so leave this off.
      multipleStatements: false,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
    });
  }
  return pool;
}

async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length > 0 ? rows[0] : null;
}

async function insert(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result.insertId;
}

// Repositories are called both standalone and from inside transaction(), so
// every one of them takes an optional connection. This returns the same
// {query, queryOne, insert} surface bound to whichever is in play, so a
// repository never branches on `if (connection)`.
function runner(connection = null) {
  if (!connection) return { query, queryOne, insert };

  const run = async (sql, params = []) => {
    const [rows] = await connection.execute(sql, params);
    return rows;
  };

  return {
    query: run,
    queryOne: async (sql, params = []) => {
      const rows = await run(sql, params);
      return rows.length > 0 ? rows[0] : null;
    },
    insert: async (sql, params = []) => {
      const [result] = await connection.execute(sql, params);
      return result.insertId;
    },
  };
}

// Runs fn inside a transaction on a dedicated connection. Used wherever one
// logical journey step writes more than one table (a quote plus its member
// rows, a datapush result plus the policy row it creates) so a crash mid-save
// can never leave a journey pointing at a step whose data is half-written —
// which is exactly the state resume cannot recover from.
async function transaction(fn) {
  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      console.error('⚠️  Rollback failed:', rollbackError.message);
    }
    throw error;
  } finally {
    connection.release();
  }
}

// Verified once at boot so a misconfigured DB surfaces in the startup banner
// rather than as a 500 on the buyer's first quote. Returns false instead of
// throwing: the NivaBupa pass-through endpoints worked before this feature
// existed and must keep working if MySQL is down — persistence degrades, the
// integration does not stop.
async function verifyConnection() {
  try {
    const row = await queryOne('SELECT DATABASE() AS db, VERSION() AS version');
    return { ok: true, ...row };
  } catch (error) {
    disabled = true;
    return { ok: false, error: error.message };
  }
}

function isDisabled() {
  return disabled;
}

async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// JSON columns take a string, bound as a plain `?` parameter — never wrapped in
// CAST(? AS JSON). The target here is MariaDB (10.4 in the current
// environment), where `JSON` in DDL is an alias for LONGTEXT with a
// json_valid() check and CAST(… AS JSON) is a syntax error. Binding the encoded
// string directly is valid on both MariaDB and MySQL 5.7+/8, so the queries stay
// portable across either engine.
//
// null/undefined must stay SQL NULL rather than becoming the literal JSON text
// "null", which would make `response_payload IS NULL` false for a row that never
// got a response.
function toJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    // Circular structures come from axios error objects being passed in by
    // mistake; store a marker rather than failing the save.
    return JSON.stringify({ _unserializable: true });
  }
}

// mysql2 already parses JSON columns into objects, but a column written before
// this ran (or by hand in a SQL client) can come back as a string.
function fromJson(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

const db = {
  getPool,
  query,
  queryOne,
  insert,
  runner,
  transaction,
  verifyConnection,
  isDisabled,
  closePool,
  toJson,
  fromJson,
};

export default db;
export {
  getPool,
  query,
  queryOne,
  insert,
  runner,
  transaction,
  verifyConnection,
  isDisabled,
  closePool,
  toJson,
  fromJson,
};
