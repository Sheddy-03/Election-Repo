'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, seed } = require('./db');
const A = require('./auth');
const { CONTESTS, FIELDS, parseInput, decorate } = require('./results');
const { buildDashboard, loadAll } = require('./dashboard');

seed();

const PORT = Number(process.env.PORT || 3000);
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_MS = 12 * 60 * 60 * 1000;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

// ---------- helpers ----------
const audit = (user, action, { contest = null, pu = null, detail = null } = {}) =>
  db.prepare('INSERT INTO audit_log (user_id,username,action,contest,pu_code,detail) VALUES (?,?,?,?,?,?)')
    .run(user?.id ?? null, user?.username ?? null, action, contest, pu, detail);

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}

function readBody(req) {
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

function currentUser(req) {
  const tok = parseCookies(req.headers.cookie).sid;
  if (!tok) return null;
  const s = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?').get(A.sha(tok));
  if (!s) return null;
  if (s.expires_at < Date.now()) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(A.sha(tok)); return null; }
  const u = db.prepare('SELECT id, username, full_name, role, active, must_change_password FROM users WHERE id = ?').get(s.user_id);
  return u && u.active ? u : null;
}

const needAuth = (u) => { if (!u) throw new HttpError(401, 'Please sign in.'); };
const needChanged = (u) => { if (u.must_change_password) throw new HttpError(403, 'Change your temporary password first.'); };
const needAdmin = (u) => { needAuth(u); needChanged(u); if (u.role !== 'admin') throw new HttpError(403, 'Administrator access required.'); };
const needAgent = (u) => { needAuth(u); needChanged(u); if (u.role !== 'agent') throw new HttpError(403, 'Data entry account required.'); };

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

/** Assign codes to an agent. All-or-nothing; refuses any PU owned by a different agent. */
function assignUnits(agentId, codes, { inTx = false } = {}) {
  const uniq = [...new Set(codes.map(String))];
  if (!uniq.length) return { assigned: 0 };
  const get = db.prepare('SELECT code, name, agent_id FROM polling_units WHERE code = ?');
  const conflicts = []; const unknown = [];
  for (const c of uniq) {
    const p = get.get(c);
    if (!p) unknown.push(c);
    else if (p.agent_id && p.agent_id !== agentId) {
      const owner = db.prepare('SELECT full_name FROM users WHERE id = ?').get(p.agent_id);
      conflicts.push({ code: c, name: p.name, owner: owner?.full_name || 'another agent' });
    }
  }
  if (unknown.length) throw new HttpError(400, `Unknown polling unit(s): ${unknown.slice(0, 5).join(', ')}`);
  if (conflicts.length) throw new HttpError(409, `${conflicts.length} polling unit(s) already belong to another agent. Unassign them first.`, { conflicts: conflicts.slice(0, 50) });
  if (!inTx) db.exec('BEGIN');
  try {
    const upd = db.prepare('UPDATE polling_units SET agent_id = ? WHERE code = ? AND (agent_id IS NULL OR agent_id = ?)');
    for (const c of uniq) upd.run(agentId, c, agentId);
    if (!inTx) db.exec('COMMIT');
  } catch (e) { if (!inTx) db.exec('ROLLBACK'); throw e; }
  return { assigned: uniq.length };
}

function puWithResults(code) {
  const pu = db.prepare('SELECT * FROM polling_units WHERE code = ?').get(code);
  if (!pu) return null;
  const contests = {};
  for (const key of Object.keys(CONTESTS)) {
    const r = db.prepare('SELECT * FROM results WHERE contest = ? AND pu_code = ?').get(key, code) || {};
    contests[key] = decorate({
      registered: pu.registered,
      pdp: r.pdp ?? null, apc: r.apc ?? null, lp: r.lp ?? null,
      accredited: r.accredited ?? null, valid: r.valid ?? null, rejected: r.rejected ?? null,
      notes: r.notes ?? '', updated_at: r.updated_at ?? null,
    });
  }
  return { pu, contests };
}

function saveResult(user, contest, code, body, { asAdmin }) {
  const pu = db.prepare('SELECT * FROM polling_units WHERE code = ?').get(code);
  if (!pu) throw new HttpError(404, 'Polling unit not found.');
  if (!asAdmin && pu.agent_id !== user.id) throw new HttpError(403, 'This polling unit is not assigned to you.');
  const { values, notes, error } = parseInput(body);
  if (error) throw new HttpError(400, error);
  const row = decorate({ registered: pu.registered, ...values, notes });
  db.prepare(`INSERT INTO results (contest,pu_code,pdp,apc,lp,accredited,valid,rejected,notes,entered_by,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,datetime('now'))
              ON CONFLICT(contest,pu_code) DO UPDATE SET pdp=excluded.pdp, apc=excluded.apc, lp=excluded.lp,
                accredited=excluded.accredited, valid=excluded.valid, rejected=excluded.rejected, notes=excluded.notes,
                entered_by=excluded.entered_by, updated_at=excluded.updated_at`)
    .run(contest, code, values.pdp, values.apc, values.lp, values.accredited, values.valid, values.rejected, notes, user.id);
  audit(user, 'result.save', { contest, pu: code, detail: `${row.status}: PDP ${values.pdp ?? '-'} APC ${values.apc ?? '-'} LP ${values.lp ?? '-'} | acc ${values.accredited ?? '-'} valid ${values.valid ?? '-'} rej ${values.rejected ?? '-'}${asAdmin ? ' (admin)' : ''}` });
  return { status: row.status, total: row.total, turnout: row.turnout };
}

// ---------- API ----------
async function api(req, res, url) {
  const user = currentUser(req);
  const m = req.method;
  const p = url.pathname;
  const parts = p.split('/').filter(Boolean).slice(1); // drop 'api'
  let body = {};
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) {
    // CSRF defence: JSON content type (not sendable by cross-site forms) + same-origin check
    if (!(req.headers['content-type'] || '').startsWith('application/json') && m !== 'DELETE') throw new HttpError(415, 'JSON required.');
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request blocked.');
    body = await readBody(req);
  }

  // ----- public / session -----
  if (p === '/api/login' && m === 'POST') {
    const username = String(body.username || '').trim();
    const key = `${username.toLowerCase()}|${req.socket.remoteAddress}`;
    if (A.throttled(key)) throw new HttpError(429, 'Too many failed attempts. Try again in 15 minutes.');
    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const ok = u && u.active && A.verifyPassword(String(body.password || ''), u.password_hash);
    if (!ok) { A.recordFail(key); audit(null, 'login.fail', { detail: username.slice(0, 40) }); throw new HttpError(401, 'Invalid username or password.'); }
    A.clearFails(key);
    const tok = A.newToken();
    db.prepare('INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?,?,?)').run(A.sha(tok), u.id, Date.now() + SESSION_MS);
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
    audit(u, 'login');
    const secure = process.env.COOKIE_SECURE === '1' || req.headers['x-forwarded-proto'] === 'https';
    return send(res, 200, { id: u.id, username: u.username, full_name: u.full_name, role: u.role, must_change_password: !!u.must_change_password },
      { 'Set-Cookie': `sid=${tok}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}` });
  }
  if (p === '/api/logout' && m === 'POST') {
    const tok = parseCookies(req.headers.cookie).sid;
    if (tok) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(A.sha(tok));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (p === '/api/me' && m === 'GET') {
    needAuth(user);
    return send(res, 200, { id: user.id, username: user.username, full_name: user.full_name, role: user.role, must_change_password: !!user.must_change_password });
  }
  if (p === '/api/me/password' && m === 'POST') {
    needAuth(user);
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
    if (!A.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect.');
    const err = A.validatePassword(body.next); if (err) throw new HttpError(400, err);
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(A.hashPassword(body.next), user.id);
    audit(user, 'password.change');
    return send(res, 200, { ok: true });
  }

  // ----- data entry agent -----
  if (parts[0] === 'my') {
    needAgent(user);
    if (parts[1] === 'units' && parts.length === 2 && m === 'GET') {
      const all = loadAll();
      const mine = {};
      for (const k of Object.keys(CONTESTS)) for (const r of all[k]) if (r.agent_id === user.id) {
        (mine[r.code] ||= { code: r.code, ward: r.ward, name: r.name, registered: r.registered, status: {} }).status[k] = r.status;
      }
      return send(res, 200, { units: Object.values(mine) });
    }
    if (parts[1] === 'units' && parts.length === 3 && m === 'GET') {
      const d = puWithResults(parts[2]);
      if (!d || d.pu.agent_id !== user.id) throw new HttpError(403, 'This polling unit is not assigned to you.');
      return send(res, 200, { unit: { code: d.pu.code, ward: d.pu.ward, name: d.pu.name, registered: d.pu.registered }, contests: d.contests });
    }
    if (parts[1] === 'units' && parts.length === 4 && m === 'PUT') {
      const r = saveResult(user, contestOr404(parts[3]), parts[2], body, { asAdmin: false });
      return send(res, 200, r);
    }
  }

  // ----- admin -----
  if (parts[0] === 'admin') {
    needAdmin(user);

    if (parts[1] === 'dashboard' && m === 'GET') return send(res, 200, buildDashboard(url.searchParams.get('ward')));

    if (parts[1] === 'activity' && m === 'GET') {
      const rows = db.prepare('SELECT id, at, username, action, contest, pu_code, detail FROM audit_log ORDER BY id DESC LIMIT ?').all(Math.min(Number(url.searchParams.get('limit')) || 50, 300));
      return send(res, 200, { activity: rows });
    }

    if (parts[1] === 'users') {
      if (parts.length === 2 && m === 'GET') {
        const users = db.prepare(`SELECT u.id, u.username, u.full_name, u.role, u.active, u.created_at,
          (SELECT COUNT(*) FROM polling_units p WHERE p.agent_id = u.id) AS assigned
          FROM users u ORDER BY u.role, u.full_name`).all();
        return send(res, 200, { users });
      }
      if (parts.length === 2 && m === 'POST') {
        const username = cleanUsername(body.username), full_name = cleanName(body.full_name);
        const role = body.role === 'admin' ? 'admin' : 'agent';
        const err = A.validatePassword(body.password); if (err) throw new HttpError(400, err);
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new HttpError(409, 'That username is already taken.');
        const codes = role === 'agent' && Array.isArray(body.pu_codes) ? body.pu_codes : [];
        let id;
        db.exec('BEGIN');
        try {
          // validate assignment first (throws before anything is written)
          id = Number(db.prepare('INSERT INTO users (username,full_name,password_hash,role,must_change_password) VALUES (?,?,?,?,1)')
            .run(username, full_name, A.hashPassword(body.password), role).lastInsertRowid);
          assignUnits(id, codes, { inTx: true });
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        audit(user, 'user.create', { detail: `${username} (${role}), ${codes.length} PU(s)` });
        return send(res, 201, { id, username });
      }
      const id = Number(parts[2]);
      const target = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
      if (!target) throw new HttpError(404, 'User not found.');
      if (parts.length === 3 && m === 'PATCH') {
        const sets = [], args = [];
        if (body.full_name !== undefined) { sets.push('full_name = ?'); args.push(cleanName(body.full_name)); }
        if (body.password !== undefined && body.password !== '') {
          const err = A.validatePassword(body.password); if (err) throw new HttpError(400, err);
          sets.push('password_hash = ?', 'must_change_password = 1'); args.push(A.hashPassword(body.password));
          db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        }
        if (body.active !== undefined) {
          if (id === user.id && !body.active) throw new HttpError(400, 'You cannot deactivate your own account.');
          sets.push('active = ?'); args.push(body.active ? 1 : 0);
          if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        }
        if (!sets.length) throw new HttpError(400, 'Nothing to update.');
        db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args, id);
        audit(user, 'user.update', { detail: `${target.username}: ${Object.keys(body).filter((k) => k !== 'password').join(', ')}${body.password ? ', password reset' : ''}` });
        return send(res, 200, { ok: true });
      }
      if (parts[3] === 'units' && target.role === 'agent') {
        if (m === 'GET') return send(res, 200, { codes: db.prepare('SELECT code FROM polling_units WHERE agent_id = ?').all(id).map((r) => r.code) });
        if (m === 'POST') { // add units
          const codes = Array.isArray(body.codes) ? body.codes : [];
          const r = assignUnits(id, codes);
          audit(user, 'units.assign', { detail: `${target.username} +${r.assigned}` });
          return send(res, 200, r);
        }
        if (m === 'DELETE') { // remove units: body.codes via query ?codes=a,b or all
          const codes = (url.searchParams.get('codes') || '').split(',').filter(Boolean);
          let n = 0;
          const upd = db.prepare('UPDATE polling_units SET agent_id = NULL WHERE code = ? AND agent_id = ?');
          for (const c of codes) n += Number(upd.run(c, id).changes);
          audit(user, 'units.unassign', { detail: `${target.username} -${n}` });
          return send(res, 200, { removed: n });
        }
      }
    }

    if (parts[1] === 'units' && m === 'GET') {
      const ward = url.searchParams.get('ward');
      const rows = db.prepare(`SELECT p.code, p.ward, p.name, p.registered, p.reg_class, p.group80, p.agent_id, u.full_name AS agent_name
        FROM polling_units p LEFT JOIN users u ON u.id = p.agent_id
        ${ward ? 'WHERE p.ward = ?' : ''} ORDER BY p.code`).all(...(ward ? [ward] : []));
      return send(res, 200, { units: rows });
    }

    if (parts[1] === 'results' && parts.length === 3 && m === 'GET') {
      const key = contestOr404(parts[2]);
      const rows = loadAll()[key].map((r) => ({ ...r, agent_name: r.agent_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(r.agent_id)?.full_name : null }));
      return send(res, 200, { results: rows });
    }
    if (parts[1] === 'results' && parts.length === 4 && m === 'PUT') {
      return send(res, 200, saveResult(user, contestOr404(parts[2]), parts[3], body, { asAdmin: true }));
    }
    if (parts[1] === 'results' && parts.length === 4 && m === 'GET') {
      const d = puWithResults(parts[3]); if (!d) throw new HttpError(404, 'Polling unit not found.');
      return send(res, 200, { unit: d.pu, result: d.contests[contestOr404(parts[2])] });
    }

    if (parts[1] === 'export' && m === 'GET') {
      const key = contestOr404(String(parts[2] || '').replace(/\.csv$/, ''));
      const head = ['Ward', 'PU code', 'Polling unit', '2023 registered', 'PDP', 'APC', 'LP', 'Accredited', 'Valid', 'Rejected', 'Total Votes', 'Turnout', 'Status', 'Source / notes', 'Reg. Class', '80% Group', 'Entered by'];
      const rows = loadAll()[key].map((r) => {
        const ag = r.agent_id ? db.prepare('SELECT full_name FROM users WHERE id = ?').get(r.agent_id)?.full_name : '';
        return [r.ward, r.code, r.name, r.registered, r.pdp, r.apc, r.lp, r.accredited, r.valid, r.rejected, r.total, r.turnout === null ? '' : r.turnout.toFixed(4), r.status, r.notes, r.reg_class, r.group80, ag].map(csvCell).join(',');
      });
      audit(user, 'export', { contest: key });
      return send(res, 200, '﻿' + [head.join(','), ...rows].join('\r\n'), { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="bende-${key}-results.csv"` });
    }
  }

  throw new HttpError(404, 'Not found.');
}

// ---------- static ----------
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

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'");
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) await api(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, ...(e.extra || {}) });
    console.error(e);
    send(res, 500, { error: 'Server error.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Election portal running on http://localhost:${PORT}`));
}
module.exports = { server };
