'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword } = require('./auth');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'storage', 'portal.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','agent')),
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS polling_units (
  code TEXT PRIMARY KEY,
  ward TEXT NOT NULL,
  name TEXT NOT NULL,
  registered INTEGER NOT NULL,
  reg_class TEXT NOT NULL,
  group80 TEXT NOT NULL,
  -- a PU row has exactly one agent_id, so it can never belong to two agents
  agent_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_pu_ward ON polling_units(ward);
CREATE INDEX IF NOT EXISTS idx_pu_agent ON polling_units(agent_id);
CREATE TABLE IF NOT EXISTS results (
  contest TEXT NOT NULL CHECK (contest IN ('presidential','senate','reps')),
  pu_code TEXT NOT NULL REFERENCES polling_units(code),
  pdp INTEGER, apc INTEGER, lp INTEGER,
  accredited INTEGER, valid INTEGER, rejected INTEGER,
  notes TEXT NOT NULL DEFAULT '',
  entered_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (contest, pu_code)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  contest TEXT,
  pu_code TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(id DESC);
`);

function seed() {
  const count = db.prepare('SELECT COUNT(*) c FROM polling_units').get().c;
  if (count === 0) {
    const pus = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'polling_units.json'), 'utf8'));
    const ins = db.prepare('INSERT INTO polling_units (code,ward,name,registered,reg_class,group80) VALUES (?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (const p of pus) ins.run(p.code, p.ward, p.name, p.registered, p.regClass, p.group80);
    db.exec('COMMIT');
    console.log(`Seeded ${pus.length} polling units.`);
  }
  const admins = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin'").get().c;
  if (admins === 0) {
    const username = process.env.ADMIN_USERNAME || 'admin';
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
    db.prepare("INSERT INTO users (username,full_name,password_hash,role,must_change_password) VALUES (?,?,?,'admin',?)")
      .run(username, 'Administrator', hashPassword(password), generated ? 1 : 0);
    console.log('==================================================');
    console.log(' First admin account created');
    console.log(`   username: ${username}`);
    if (generated) console.log(`   password: ${password}   (change it after first login)`);
    else console.log('   password: (from ADMIN_PASSWORD)');
    console.log('==================================================');
  }
}

module.exports = { db, seed };
