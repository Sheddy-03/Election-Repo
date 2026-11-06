'use strict';
/**
 * Postgres access layer.
 *  - Production / Vercel: node-postgres against DATABASE_URL (e.g. Neon).
 *  - Local dev / tests (no DATABASE_URL): PGlite, an in-process Postgres.
 * Both speak the same SQL, so the app has a single code path.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');

const NOW = `to_char(now() at time zone 'utc','YYYY-MM-DD"T"HH24:MI:SS')`;

function makeBackend() {
  if (process.env.DATABASE_URL) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, Number); // bigint -> number
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, idleTimeoutMillis: 10_000 });
    return {
      kind: 'pg',
      query: async (sql, p = []) => (await pool.query(sql, p)).rows,
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const r = await fn(async (sql, p = []) => (await c.query(sql, p)).rows);
          await c.query('COMMIT');
          return r;
        } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
      },
    };
  }
  const { PGlite } = require('@electric-sql/pglite');
  const dir = process.env.PGLITE_DIR || path.join(__dirname, '..', 'storage', 'pgdata');
  if (!dir.startsWith('memory:')) fs.mkdirSync(path.dirname(dir), { recursive: true });
  const lite = new PGlite(dir);
  return {
    kind: 'pglite',
    query: async (sql, p = []) => (await lite.query(sql, p)).rows,
    tx: (fn) => lite.transaction((t) => fn(async (sql, p = []) => (await t.query(sql, p)).rows)),
  };
}

const backend = makeBackend();
const query = (sql, p) => backend.query(sql, p);
const tx = (fn) => backend.tx(fn);

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username TEXT NOT NULL,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('admin','agent')),
    active BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (lower(username))`,
  `CREATE TABLE IF NOT EXISTS polling_units (
    code TEXT PRIMARY KEY,
    ward TEXT NOT NULL,
    name TEXT NOT NULL,
    registered INTEGER NOT NULL,
    reg_class TEXT NOT NULL,
    group80 TEXT NOT NULL,
    agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL
  )`, // a PU row has exactly one agent_id, so it can never belong to two agents
  `CREATE INDEX IF NOT EXISTS idx_pu_ward ON polling_units(ward)`,
  `CREATE INDEX IF NOT EXISTS idx_pu_agent ON polling_units(agent_id)`,
  `CREATE TABLE IF NOT EXISTS results (
    contest TEXT NOT NULL CHECK (contest IN ('presidential','senate','reps')),
    pu_code TEXT NOT NULL REFERENCES polling_units(code),
    pdp INTEGER, apc INTEGER, lp INTEGER,
    accredited INTEGER, valid INTEGER, rejected INTEGER,
    notes TEXT NOT NULL DEFAULT '',
    entered_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL DEFAULT ${NOW},
    PRIMARY KEY (contest, pu_code)
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS login_fails (
    key TEXT PRIMARY KEY,
    n INTEGER NOT NULL,
    first_ms DOUBLE PRECISION NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at TEXT NOT NULL DEFAULT ${NOW},
    user_id INTEGER,
    username TEXT,
    action TEXT NOT NULL,
    contest TEXT,
    pu_code TEXT,
    detail TEXT
  )`,
];

async function init() {
  await tx(async (q) => {
    await q('SELECT pg_advisory_xact_lock(727001)'); // serialise concurrent cold starts
    for (const s of SCHEMA) await q(s);

    const [{ c }] = await q('SELECT COUNT(*)::int AS c FROM polling_units');
    if (c === 0) {
      const pus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'polling_units.json'), 'utf8'));
      await q(
        `INSERT INTO polling_units (code,ward,name,registered,reg_class,group80)
         SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::int[],$5::text[],$6::text[])`,
        [pus.map((p) => p.code), pus.map((p) => p.ward), pus.map((p) => p.name), pus.map((p) => p.registered), pus.map((p) => p.regClass), pus.map((p) => p.group80)],
      );
      console.log(`Seeded ${pus.length} polling units.`);
    }

    const [{ a }] = await q("SELECT COUNT(*)::int AS a FROM users WHERE role='admin'");
    if (a === 0) {
      const username = process.env.ADMIN_USERNAME || 'admin';
      let password = process.env.ADMIN_PASSWORD;
      const generated = !password;
      if (generated) password = crypto.randomBytes(9).toString('base64url');
      await q("INSERT INTO users (username,full_name,password_hash,role,must_change_password) VALUES ($1,'Administrator',$2,'admin',$3)",
        [username, hashPassword(password), generated]);
      console.log('==================================================');
      console.log(' First admin account created');
      console.log(`   username: ${username}`);
      console.log(generated ? `   password: ${password}   (change it after first login)` : '   password: (from ADMIN_PASSWORD)');
      console.log('==================================================');
    }
  });
}

let readyP;
const ready = () => (readyP ||= init().catch((e) => { readyP = null; throw e; }));

module.exports = { query, tx, ready, NOW };
