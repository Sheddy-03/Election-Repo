'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { query, tx, ready, NOW } = require('./db');
const A = require('./auth');
const { CONTESTS, FIELDS, QUALITY, parseInput, decorate } = require('./results');
const { buildDashboard, loadAll } = require('./dashboard');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_MS = 12 * 60 * 60 * 1000;
const FAIL_WINDOW = 15 * 60 * 1000, FAIL_MAX = 8;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

// ---------- helpers ----------
const first = (rows) => rows[0];
const audit = (q, user, action, { contest = null, pu = null, detail = null } = {}) =>
  q('INSERT INTO audit_log (user_id,username,action,contest,pu_code,detail) VALUES ($1,$2,$3,$4,$5,$6)', [user?.id ?? null, user?.username ?? null, action, contest, pu, detail]);

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) { // already read by the serverless runtime (Vercel)
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!raw.trim()) return {};
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON.'); }
  }
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 100_000) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON.')); }
    });
    req.on('error', reject);
  });
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  const data = isJson ? JSON.stringify(body) : body;
  res.writeHead(status, { 'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(data);
}

const clientIp = (req) => String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim();

async function currentUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const s = first(await query('SELECT user_id, expires_at FROM sessions WHERE token_hash = $1', [A.sha(tok)]));
  if (!s) return null;
  if (s.expires_at < Date.now()) { await query('DELETE FROM sessions WHERE token_hash = $1', [A.sha(tok)]); return null; }
  const u = first(await query('SELECT id, username, full_name, role, active, must_change_password FROM users WHERE id = $1', [s.user_id]));
  return u && u.active ? u : null;
}

const needAuth = (u) => { if (!u) throw new HttpError(401, 'Please sign in.'); };
const needChanged = (u) => { if (u.must_change_password) throw new HttpError(403, 'Change your temporary password first.'); };
const needAdmin = (u) => { needAuth(u); needChanged(u); if (u.role !== 'admin') throw new HttpError(403, 'Administrator access required.'); };
const needAgent = (u) => { needAuth(u); needChanged(u); if (u.role !== 'agent') throw new HttpError(403, 'Data entry account required.'); };
const publicUser = (u) => ({ id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change_password: !!u.must_change_password });

function contestOr404(key) { if (!CONTESTS[key]) throw new HttpError(404, 'Unknown contest.'); return key; }
function cleanUsername(v) {
  const s = String(v ?? '').trim();
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(s)) throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
  return s;
}
const cleanName = (v) => {
  const s = String(v ?? '').trim();
  if (s.length < 2 || s.length > 80) throw new HttpError(400, 'Full name must be 2-80 characters.');
  return s;
};
function csvCell(v) { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

/** Assign codes to an agent inside a transaction `q`. All-or-nothing; refuses PUs owned by a different agent. */
async function assignUnits(q, agentId, codes) {
  const uniq = [...new Set(codes.map(String))];
  if (!uniq.length) return { assigned: 0 };
  const found = await q(`SELECT p.code, p.name, p.agent_id, u.full_name AS owner FROM polling_units p LEFT JOIN users u ON u.id = p.agent_id WHERE p.code = ANY($1::text[])`, [uniq]);
  const known = new Set(found.map((r) => r.code));
  const unknown = uniq.filter((c) => !known.has(c));
  if (unknown.length) throw new HttpError(400, `Unknown polling unit(s): ${unknown.slice(0, 5).join(', ')}`);
  const conflicts = found.filter((r) => r.agent_id && r.agent_id !== agentId).map((r) => ({ code: r.code, name: r.name, owner: r.owner || 'another agent' }));
  if (conflicts.length) throw new HttpError(409, `${conflicts.length} polling unit(s) already belong to another agent. Unassign them first.`, { conflicts: conflicts.slice(0, 50) });
  // conditional update guards against a concurrent assignment slipping in between the check and the write
  const done = await q('UPDATE polling_units SET agent_id = $1 WHERE code = ANY($2::text[]) AND (agent_id IS NULL OR agent_id = $1) RETURNING code', [agentId, uniq]);
  if (done.length !== uniq.length) throw new HttpError(409, 'Some polling units were assigned to someone else while you were saving. Reload and try again.');
  return { assigned: uniq.length };
}

async function puWithResults(code) {
  const pu = first(await query('SELECT * FROM polling_units WHERE code = $1', [code]));
  if (!pu) return null;
  const rows = await query('SELECT * FROM results WHERE pu_code = $1', [code]);
  const contests = {};
  for (const key of Object.keys(CONTESTS)) {
    const r = rows.find((x) => x.contest === key) || {};
    contests[key] = decorate({
      registered: pu.registered,
      pdp: r.pdp ?? null, apc: r.apc ?? null, lp: r.lp ?? null,
      accredited: r.accredited ?? null, valid: r.valid ?? null, rejected: r.rejected ?? null,
      notes: r.notes ?? '', quality: r.quality ?? null, updated_at: r.updated_at ?? null,
    });
  }
  return { pu, contests };
}

const upsertResult = (q, contest, code, v, notes, quality, userId) => q(
  `INSERT INTO results (contest,pu_code,pdp,apc,lp,accredited,valid,rejected,notes,quality,entered_by,updated_at)
   VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,${NOW})
   ON CONFLICT (contest,pu_code) DO UPDATE SET pdp=EXCLUDED.pdp, apc=EXCLUDED.apc, lp=EXCLUDED.lp,
     accredited=EXCLUDED.accredited, valid=EXCLUDED.valid, rejected=EXCLUDED.rejected, notes=EXCLUDED.notes,
     quality=EXCLUDED.quality, entered_by=EXCLUDED.entered_by, updated_at=EXCLUDED.updated_at`,
  [contest, code, v.pdp, v.apc, v.lp, v.accredited, v.valid, v.rejected, notes, quality, userId]);

// ---------- workbook import ----------
const WORKBOOK_FILE = path.join(__dirname, '..', 'data', 'workbook_results.json');
const loadWorkbook = () => JSON.parse(fs.readFileSync(WORKBOOK_FILE, 'utf8'));

async function workbookPlan() {
  const wb = loadWorkbook();
  const existing = await query(`SELECT contest, pu_code FROM results
    WHERE pdp IS NOT NULL OR apc IS NOT NULL OR lp IS NOT NULL OR accredited IS NOT NULL OR valid IS NOT NULL OR rejected IS NOT NULL OR notes <> ''`);
  const has = new Set(existing.map((r) => `${r.contest}|${r.pu_code}`));
  const codes = new Set((await query('SELECT code FROM polling_units')).map((r) => r.code));
  const plan = {};
  for (const [contest, rows] of Object.entries(wb.contests)) {
    const valid = rows.filter((r) => codes.has(r.code));
    plan[contest] = {
      rows: valid,
      unknown: rows.length - valid.length,
      fill: valid.filter((r) => !has.has(`${contest}|${r.code}`)).length,
      overlap: valid.filter((r) => has.has(`${contest}|${r.code}`)).length,
    };
  }
  return { source: wb.source, generated: wb.generated, plan };
}

async function saveResult(user, contest, code, body, { asAdmin }) {
  const pu = first(await query('SELECT * FROM polling_units WHERE code = $1', [code]));
  if (!pu) throw new HttpError(404, 'Polling unit not found.');
  if (!asAdmin && pu.agent_id !== user.id) throw new HttpError(403, 'This polling unit is not assigned to you.');
  const { values, notes, quality, error } = parseInput(body);
  if (error) throw new HttpError(400, error);
  const row = decorate({ registered: pu.registered, ...values, notes });
  await tx(async (q) => {
    await upsertResult(q, contest, code, values, notes, quality, user.id);
    await audit(q, user, 'result.save', { contest, pu: code, detail: `${row.status}: PDP ${values.pdp ?? '-'} APC ${values.apc ?? '-'} LP ${values.lp ?? '-'} | acc ${values.accredited ?? '-'} valid ${values.valid ?? '-'} rej ${values.rejected ?? '-'}${asAdmin ? ' (admin)' : ''}` });
  });
  return { status: row.status, total: row.total, turnout: row.turnout };
}

// ---------- API ----------
async function api(req, res, url) {
  const user = await currentUser(req);
  const m = req.method;
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean).slice(1); // drop 'api'
  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    // CSRF defence: JSON content type (not sendable by cross-site forms) + same-origin check
    if (!(req.headers['content-type'] || '').startsWith('application/json') && m !== 'DELETE') throw new HttpError(415, 'JSON required.');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    // DELETE takes its parameters from the query string; never wait on a body that may not exist
    // (on serverless runtimes the request stream can already be consumed).
    if (m !== 'DELETE') body = await readBody(req);
  }

  // ----- public / session -----
  if (p === '/api/login' && m === 'POST') {
    const username = String(body.username || '').trim();
    const key = `${username.toLowerCase()}|${clientIp(req)}`;
    const f = first(await query('SELECT n, first_ms FROM login_fails WHERE key = $1', [key]));
    if (f && Date.now() - f.first_ms < FAIL_WINDOW && f.n >= FAIL_MAX) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = first(await query('SELECT * FROM users WHERE lower(username) = lower($1)', [username]));
    const ok = u && u.active && A.verifyPassword(String(body.password || ''), u.password_hash);
    if (!ok) {
      await query(`INSERT INTO login_fails (key,n,first_ms) VALUES ($1,1,$2::float8)
        ON CONFLICT (key) DO UPDATE SET
          n = CASE WHEN $2::float8 - login_fails.first_ms > $3::float8 THEN 1 ELSE login_fails.n + 1 END,
          first_ms = CASE WHEN $2::float8 - login_fails.first_ms > $3::float8 THEN $2::float8 ELSE login_fails.first_ms END`, [key, Date.now(), FAIL_WINDOW]);
      await audit(query, null, 'login.fail', { detail: username.slice(0, 40) });
      throw new HttpError(401, 'Invalid username or password.');
    }
    await query('DELETE FROM login_fails WHERE key = $1', [key]);
    const tok = A.newToken();
    await query('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES ($1,$2,$3)', [A.sha(tok), u.id, Date.now() + SESSION_MS]);
    await query('DELETE FROM sessions WHERE expires_at < $1', [Date.now()]);
    await audit(query, u, 'login');
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    return send(res, 200, publicUser(u), { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}` });
  }
  if (p === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req.headers.cookie).sid;
    if (tok) await query('DELETE FROM sessions WHERE token_hash = $1', [A.sha(tok)]);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/api/me' && m === 'GET') { needAuth(user); return send(res, 200, publicUser(user)); }
  if (p === '/api/meta' && m === 'GET') { needAuth(user); return send(res, 200, { qualities: QUALITY, contests: CONTESTS }); }
  if (p === '/api/me/password' && m === 'POST') {
    needAuth(user);
    const row = first(await query('SELECT password_hash FROM users WHERE id = $1', [user.id]));
    if (!A.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    const err = A.validatePassword(body.next); if (err) throw new HttpError(400, err);
    await query('UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2', [A.hashPassword(body.next), user.id]);
    await audit(query, user, 'password.change');
    return send(res, 200, { ok: true });
  }

  // ----- data entry agent -----
  if (parts[0] === 'my') {
    needAgent(user);
    if (parts[1] === 'units' && parts.length === 2 && m === 'GET') {
      const all = await loadAll();
      const mine = {};
      for (const k of Object.keys(CONTESTS)) for (const r of all[k]) if (r.agent_id === user.id) {
        (mine[r.code] ||= { code: r.code, ward: r.ward, name: r.name, registered: r.registered, status: {} }).status[k] = r.status;
      }
      return send(res, 200, { units: Object.values(mine) });
    }
    if (parts[1] === 'units' && parts.length === 3 && m === 'GET') {
      const d = await puWithResults(parts[2]);
      if (!d || d.pu.agent_id !== user.id) throw new HttpError(403, 'This polling unit is not assigned to you.');
      return send(res, 200, { unit: { code: d.pu.code, ward: d.pu.ward, name: d.pu.name, registered: d.pu.registered }, contests: d.contests });
    }
    if (parts[1] === 'units' && parts.length === 4 && m === 'PUT') {
      return send(res, 200, await saveResult(user, contestOr404(parts[3]), parts[2], body, { asAdmin: false }));
    }
  }

  // ----- admin -----
  if (parts[0] === 'admin') {
    needAdmin(user);

    if (parts[1] === 'dashboard' && m === 'GET') return send(res, 200, await buildDashboard(url.searchParams.get('ward')));

    if (parts[1] === 'activity' && m === 'GET') {
      const rows = await query('SELECT id, at, username, action, contest, pu_code, detail FROM audit_log ORDER BY id DESC LIMIT $1', [Math.min(Number(url.searchParams.get('limit')) || 50, 300)]);
      return send(res, 200, { activity: rows });
    }

    if (parts[1] === 'users') {
      if (parts.length === 2 && m === 'GET') {
        const users = await query(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at,
          (SELECT COUNT(*)::int FROM polling_units p WHERE p.agent_id = u.id) AS assigned
          FROM users u ORDER BY u.role, u.full_name`);
        return send(res, 200, { users });
      }
      if (parts.length === 2 && m === 'POST') {
        const username = cleanUsername(body.username), full_name = cleanName(body.full_name);
        const role = body.role === 'admin' ? 'admin' : 'agent';
        const err = A.validatePassword(body.password); if (err) throw new HttpError(400, err);
        const codes = role === 'agent' && Array.isArray(body.pu_codes) ? body.pu_codes : [];
        const hash = A.hashPassword(body.password);
        let id;
        try {
          id = await tx(async (q) => {
            const [row] = await q('INSERT INTO users (username,full_name,password_hash,role,must_change_password) VALUES ($1,$2,$3,$4,TRUE) RETURNING id', [username, full_name, hash, role]);
            await assignUnits(q, row.id, codes);
            await audit(q, user, 'user.create', { detail: `${username} (${role}), ${codes.length} PU(s)` });
            return row.id;
          });
        } catch (e) {
          if (e.code === '23505') throw new HttpError(409, 'That username is already taken.');
          throw e;
        }
        return send(res, 201, { id, username });
      }
      const id = Number(parts[2]);
      const target = id ? first(await query('SELECT * FROM users WHERE id = $1', [id])) : null;
      if (!target) throw new HttpError(404, 'User not found.');
      if (parts.length === 3 && m === 'PATCH') {
        const sets = [], args = [];
        const add = (col, val) => { args.push(val); sets.push(`${col} = $${args.length}`); };
        if (body.full_name !== undefined) add('full_name', cleanName(body.full_name));
        const resetSessions = [];
        if (body.password !== undefined && body.password !== '') {
          const err = A.validatePassword(body.password); if (err) throw new HttpError(400, err);
          add('password_hash', A.hashPassword(body.password)); sets.push('must_change_password = TRUE'); resetSessions.push(id);
        }
        if (body.active !== undefined) {
          if (id === user.id && !body.active) throw new HttpError(400, 'You cannot deactivate your own account.');
          add('active', !!body.active); if (!body.active) resetSessions.push(id);
        }
        if (!sets.length) throw new HttpError(400, 'Nothing to update.');
        args.push(id);
        await tx(async (q) => {
          await q(`UPDATE users SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
          if (resetSessions.length) await q('DELETE FROM sessions WHERE user_id = $1', [id]);
          await audit(q, user, 'user.update', { detail: `${target.username}: ${Object.keys(body).filter((k) => k !== 'password').join(', ')}${body.password ? ', password reset' : ''}` });
        });
        return send(res, 200, { ok: true });
      }
      if (parts[3] === 'units' && target.role === 'agent') {
        if (m === 'GET') return send(res, 200, { codes: (await query('SELECT code FROM polling_units WHERE agent_id = $1 ORDER BY code', [id])).map((r) => r.code) });
        if (m === 'POST') {
          const codes = Array.isArray(body.codes) ? body.codes : [];
          const r = await tx(async (q) => { const out = await assignUnits(q, id, codes); await audit(q, user, 'units.assign', { detail: `${target.username} +${out.assigned}` }); return out; });
          return send(res, 200, r);
        }
        if (m === 'DELETE') {
          const codes = (url.searchParams.get('codes') || '').split(',').filter(Boolean);
          const removed = await tx(async (q) => {
            const rows = await q('UPDATE polling_units SET agent_id = NULL WHERE code = ANY($1::text[]) AND agent_id = $2 RETURNING code', [codes, id]);
            await audit(q, user, 'units.unassign', { detail: `${target.username} -${rows.length}` });
            return rows.length;
          });
          return send(res, 200, { removed });
        }
      }
    }

    if (parts[1] === 'import' && parts[2] === 'workbook') {
      const { source, generated, plan } = await workbookPlan();
      const summary = Object.fromEntries(Object.entries(plan).map(([k, v]) => [k, { rows: v.rows.length, fill: v.fill, overlap: v.overlap, unknown: v.unknown }]));
      if (m === 'GET') return send(res, 200, { source, generated, contests: summary });
      if (m === 'POST') {
        const overwrite = body.overwrite === true;
        const done = await tx(async (q) => {
          const has = new Set((await q(`SELECT contest, pu_code FROM results
            WHERE pdp IS NOT NULL OR apc IS NOT NULL OR lp IS NOT NULL OR accredited IS NOT NULL OR valid IS NOT NULL OR rejected IS NOT NULL OR notes <> ''`)).map((r) => `${r.contest}|${r.pu_code}`));
          const out = {};
          for (const [contest, p] of Object.entries(plan)) {
            let written = 0, skipped = 0;
            for (const r of p.rows) {
              if (!overwrite && has.has(`${contest}|${r.code}`)) { skipped++; continue; }
              const v = Object.fromEntries(FIELDS.map((f) => [f, r[f] ?? null]));
              await upsertResult(q, contest, r.code, v, String(r.notes || '').slice(0, 500), QUALITY.includes(r.quality) ? r.quality : null, user.id);
              written++;
            }
            out[contest] = { written, skipped };
            await audit(q, user, 'import', { contest, detail: `${source}: ${written} written, ${skipped} kept (already entered)${overwrite ? ', overwrite on' : ''}` });
          }
          return out;
        });
        return send(res, 200, { ok: true, result: done });
      }
    }

    if (parts[1] === 'units' && m === 'GET') {
      const ward = url.searchParams.get('ward');
      const rows = await query(`SELECT p.code, p.ward, p.name, p.registered, p.reg_class, p.group80, p.agent_id, u.full_name AS agent_name
        FROM polling_units p LEFT JOIN users u ON u.id = p.agent_id
        ${ward ? 'WHERE p.ward = $1' : ''} ORDER BY p.code`, ward ? [ward] : []);
      return send(res, 200, { units: rows });
    }

    if (parts[1] === 'results' && parts.length === 3 && m === 'GET') return send(res, 200, { results: (await loadAll())[contestOr404(parts[2])] });
    if (parts[1] === 'results' && parts.length === 4 && m === 'PUT') return send(res, 200, await saveResult(user, contestOr404(parts[2]), parts[3], body, { asAdmin: true }));
    if (parts[1] === 'results' && parts.length === 4 && m === 'GET') {
      const d = await puWithResults(parts[3]); if (!d) throw new HttpError(404, 'Polling unit not found.');
      return send(res, 200, { unit: d.pu, result: d.contests[contestOr404(parts[2])] });
    }

    if (parts[1] === 'export' && m === 'GET') {
      const key = contestOr404(String(parts[2] || '').replace(/\.csv$/, ''));
      const head = ['Ward', 'PU code', 'Polling unit', '2023 registered', 'PDP', 'APC', 'LP', 'Accredited', 'Valid', 'Rejected', 'Total Votes', 'Turnout', 'Status', 'Sheet quality', 'Source / notes', 'Reg. Class', '80% Group', 'Assigned agent'];
      const rows = (await loadAll())[key].map((r) => [r.ward, r.code, r.name, r.registered, r.pdp, r.apc, r.lp, r.accredited, r.valid, r.rejected, r.total, r.turnout === null ? '' : r.turnout.toFixed(4), r.status, r.quality || '', r.notes, r.reg_class, r.group80, r.agent_name || ''].map(csvCell).join(','));
      await audit(query, user, 'export', { contest: key });
      return send(res, 200, '﻿' + [head.join(','), ...rows].join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bende-${key}-results.csv"` });
    }
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- static (local/dev only; Vercel serves /public itself) ----------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

async function handler(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) { await ready(); await api(req, res, url); } else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Server error.' });
  }
}

const server = http.createServer(handler);
if (require.main === module) {
  server.listen(PORT, () => console.log(`Election portal running on http://localhost:${PORT}`));
}
module.exports = { server, handler };
