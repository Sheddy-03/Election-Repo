'use strict';
const test = require('node:test');
const assert = require('node:assert');

// Default: embedded Postgres (PGlite). Set TEST_DATABASE_URL to run against a real, EMPTY Postgres
// database through the production `pg` driver (same path as Neon on Vercel).
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
else { delete process.env.DATABASE_URL; process.env.PGLITE_DIR = 'memory://'; }
process.env.ADMIN_USERNAME = 'boss';
process.env.ADMIN_PASSWORD = 'AdminPass123';

const { server } = require('../src/server');
const { computeStatus } = require('../src/results');

let base;
test.before(async () => {
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
test.after(() => server.close());

async function call(method, url, body, cookie) {
  const res = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(u, p) { const r = await call('POST', '/api/login', { username: u, password: p }); assert.equal(r.status, 200); return r.cookie; }

test('status rules match the workbook formula', () => {
  const ok = { pdp: 10, apc: 20, lp: 5, accredited: 50, valid: 40, rejected: 5 };
  assert.equal(computeStatus(ok, 100), 'Complete');
  assert.equal(computeStatus({ ...ok, pdp: null, apc: null, lp: null, accredited: null, valid: null, rejected: null }, 100), 'Missing');
  assert.equal(computeStatus({ ...ok, lp: null }, 100), 'Incomplete');
  assert.equal(computeStatus({ ...ok, pdp: 30 }, 100), 'Check figures');        // parties > valid
  assert.equal(computeStatus({ ...ok, accredited: 44 }, 100), 'Check figures');   // total > accredited
  assert.equal(computeStatus({ ...ok, accredited: 200 }, 100), 'Check figures');  // accredited > registered
  assert.equal(computeStatus({ ...ok, pdp: 0, apc: 0, lp: 0 }, 100), 'Complete'); // confirmed zeros
});

test('end to end: roles, assignment exclusivity, isolation', async () => {
  // unauthenticated
  assert.equal((await call('GET', '/api/admin/dashboard')).status, 401);

  const admin = await login('boss', 'AdminPass123');
  const dash = (await call('GET', '/api/admin/dashboard', null, admin)).json;
  assert.equal(dash.totals.pus, 214);
  assert.equal(dash.totals.registered, 112155);
  assert.equal(dash.wards.length, 13);

  // create two agents with PUs
  const a1 = await call('POST', '/api/admin/users', { username: 'agent1', full_name: 'Agent One', password: 'TempPass111', pu_codes: ['01-04-01-001', '01-04-01-002'] }, admin);
  assert.equal(a1.status, 201);
  // second agent trying to take an already-assigned PU is refused and nothing is created partially
  const bad = await call('POST', '/api/admin/users', { username: 'agent2', full_name: 'Agent Two', password: 'TempPass222', pu_codes: ['01-04-01-003', '01-04-01-002'] }, admin);
  assert.equal(bad.status, 409);
  assert.equal(bad.json.conflicts[0].code, '01-04-01-002');
  const users = (await call('GET', '/api/admin/users', null, admin)).json.users;
  assert.ok(!users.find((u) => u.username === 'agent2'), 'failed create must roll back');
  const a2 = await call('POST', '/api/admin/users', { username: 'agent2', full_name: 'Agent Two', password: 'TempPass222', pu_codes: ['01-04-01-003'] }, admin);
  assert.equal(a2.status, 201);
  // adding a PU owned by someone else via the assign endpoint is refused too
  assert.equal((await call('POST', `/api/admin/users/${a2.json.id}/units`, { codes: ['01-04-01-001'] }, admin)).status, 409);

  // temp password must be changed before anything else
  const c1 = await login('agent1', 'TempPass111');
  assert.equal((await call('GET', '/api/my/units', null, c1)).status, 403);
  assert.equal((await call('POST', '/api/me/password', { current: 'TempPass111', next: 'MyNewPass123' }, c1)).status, 200);

  // agent sees only own units
  const mine = (await call('GET', '/api/my/units', null, c1)).json.units;
  assert.deepEqual(mine.map((u) => u.code), ['01-04-01-001', '01-04-01-002']);

  // agent cannot reach admin API or another agent's PU
  assert.equal((await call('GET', '/api/admin/dashboard', null, c1)).status, 403);
  assert.equal((await call('GET', '/api/my/units/01-04-01-003', null, c1)).status, 403);
  const forbidden = await call('PUT', '/api/my/units/01-04-01-003/presidential', { pdp: 1 }, c1);
  assert.equal(forbidden.status, 403);

  // entry + validation
  const put = (body) => call('PUT', '/api/my/units/01-04-01-001/presidential', body, c1);
  assert.equal((await put({ pdp: -1 })).status, 400);
  assert.equal((await put({ pdp: 1.5 })).status, 400);
  const good = await put({ pdp: 30, apc: 100, lp: 50, accredited: 220, valid: 190, rejected: 10, notes: 'ok' });
  assert.equal(good.json.status, 'Complete');
  assert.ok(Math.abs(good.json.turnout - 200 / 380) < 1e-9);
  const bad2 = await put({ pdp: 300, apc: 100, lp: 50, accredited: 220, valid: 190, rejected: 10 });
  assert.equal(bad2.json.status, 'Check figures');
  await put({ pdp: 30, apc: 100, lp: 50, accredited: 220, valid: 190, rejected: 10 });

  // admin dashboard reflects entry
  const d2 = (await call('GET', '/api/admin/dashboard', null, admin)).json;
  const pres = d2.contests.find((c) => c.key === 'presidential');
  assert.equal(pres.complete, 1);
  assert.equal(pres.pdp, 30);
  assert.equal(pres.totalVotes, 200);
  const act = (await call('GET', '/api/admin/activity', null, admin)).json.activity;
  assert.ok(act.some((a) => a.action === 'result.save' && a.username === 'agent1'));

  // deactivating kills access immediately
  await call('PATCH', `/api/admin/users/${a1.json.id}`, { active: false }, admin);
  assert.equal((await call('GET', '/api/my/units', null, c1)).status, 401);

  // unassign then reassign works
  assert.equal((await call('DELETE', `/api/admin/users/${a1.json.id}/units?codes=01-04-01-002`, null, admin)).json.removed, 1);
  assert.equal((await call('POST', `/api/admin/users/${a2.json.id}/units`, { codes: ['01-04-01-002'] }, admin)).status, 200);

  // CSV export
  const csv = await call('GET', '/api/admin/export/presidential.csv', null, admin);
  assert.equal(csv.status, 200);
  assert.ok(String(csv.json).includes('01-04-01-001'));
});

test('cross-origin writes are blocked and logins throttle', async () => {
  const r = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(r.status, 403);
  let last;
  for (let i = 0; i < 9; i++) last = await call('POST', '/api/login', { username: 'nobody', password: 'x' });
  assert.equal(last.status, 429);
});

test('workbook import, sheet quality and analyst dashboard data', async () => {
  const admin = await login('boss', 'AdminPass123');
  // quality must come from the fixed list
  const agent = await call('POST', '/api/admin/users', { username: 'qagent', full_name: 'Q Agent', password: 'TempPass333', pu_codes: ['01-04-13-009'] }, admin);
  assert.equal(agent.status, 201);
  const qa = await login('qagent', 'TempPass333');
  await call('POST', '/api/me/password', { current: 'TempPass333', next: 'QAgentPass1' }, qa);
  assert.equal((await call('PUT', '/api/my/units/01-04-13-009/senate', { quality: 'Looks fine' }, qa)).status, 400);
  assert.equal((await call('PUT', '/api/my/units/01-04-13-009/senate', { pdp: 5, quality: 'Clear & stamped' }, qa)).status, 200);

  // preview, then import without overwrite: existing entries are kept
  const pre = (await call('GET', '/api/admin/import/workbook', null, admin)).json;
  assert.equal(pre.contests.presidential.rows, 211);
  assert.ok(pre.contests.senate.overlap >= 1);
  const imp = await call('POST', '/api/admin/import/workbook', { overwrite: false }, admin);
  assert.equal(imp.status, 200);
  assert.equal(imp.json.result.senate.written + imp.json.result.senate.skipped, pre.contests.senate.rows);
  const kept = (await call('GET', '/api/admin/results/senate/01-04-13-009', null, admin)).json.result;
  assert.equal(kept.pdp, 5, 'agent entry must survive a non-overwrite import');
  assert.equal(kept.quality, 'Clear & stamped');

  // a row that was all zeros in the workbook is imported as blank (Missing), not as a 0-vote result
  const zero = (await call('GET', '/api/admin/results/presidential/01-04-01-004', null, admin)).json.result;
  assert.equal(zero.status, 'Missing');
  assert.ok(zero.notes.includes('imported as blank'));
  // a normal row keeps its figures and gets a mapped sheet quality
  const ok = (await call('GET', '/api/admin/results/presidential/01-04-01-002', null, admin)).json.result;
  assert.deepEqual([ok.pdp, ok.apc, ok.lp, ok.accredited, ok.valid, ok.rejected], [0, 11, 38, 58, 50, 8]);
  assert.equal(ok.quality, 'Clear');

  // analyst dashboard payload
  const d = (await call('GET', '/api/admin/dashboard', null, admin)).json;
  assert.equal(d.units.length, 214);
  assert.deepEqual(d.lgas, ['Bende']);
  const top = [...d.units].sort((a, b) => b.registered - a.registered)[0];
  assert.equal(top.code, '01-04-02-001');
  assert.equal(top.registered, 1290);
  assert.ok(d.units.find((u) => u.code === '01-04-01-002').results.presidential.status);
  assert.ok(d.contests.find((c) => c.key === 'presidential').complete > 100);

  // agents cannot import
  assert.equal((await call('POST', '/api/admin/import/workbook', {}, qa)).status, 403);
});

test('2026 register upload, expected voters, targets and party settings', async () => {
  const admin = await login('boss', 'AdminPass123');
  // preview: unknown codes and bad numbers are reported, nothing is written
  const bad = await call('POST', '/api/admin/register-2026', { rows: [{ code: '01-04-02-001', registered: '1,400' }, { code: '99-99-99-999', registered: 5 }, { code: '01-04-02-002', registered: 'abc' }] }, admin);
  assert.equal(bad.status, 200);
  assert.equal(bad.json.unknownCount, 1);
  assert.equal(bad.json.invalidCount, 1);
  assert.equal((await call('POST', '/api/admin/register-2026', { rows: [{ code: '01-04-02-002', registered: 'abc' }], commit: true }, admin)).status, 400);
  // commit a valid register (comma-formatted numbers are accepted)
  const rows = [{ code: '01-04-02-001', registered: '1,400' }, { code: '01-04-02-002', registered: 1000 }, { code: '01-04-13-009', registered: 50 }];
  const ok = await call('POST', '/api/admin/register-2026', { rows, commit: true, source: 'test.csv' }, admin);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.matched, 3);
  assert.equal(ok.json.missing, 211);

  // settings
  assert.equal((await call('PUT', '/api/admin/settings', { party_2023: 'xyz' }, admin)).status, 400);
  const st = await call('PUT', '/api/admin/settings', { party_name: 'Our Party', party_2023: '' }, admin);
  assert.equal(st.json.party_name, 'Our Party');
  assert.ok(st.json.register_2026_at);

  // agent: own units only, capped at the 2026 register
  const ag = await call('POST', '/api/admin/users', { username: 'oagent', full_name: 'Outlook Agent', password: 'TempPass444', pu_codes: ['01-04-02-001'] }, admin);
  assert.equal(ag.status, 201);
  const oa = await login('oagent', 'TempPass444');
  await call('POST', '/api/me/password', { current: 'TempPass444', next: 'OAgentPass1' }, oa);
  const mine = (await call('GET', '/api/my/outlook', null, oa)).json;
  assert.deepEqual(mine.units.map((u) => u.code), ['01-04-02-001']);
  assert.equal(mine.units[0].reg2023, 1290);
  assert.equal(mine.units[0].reg2026, 1400);
  assert.equal(mine.settings.party_name, 'Our Party');
  assert.equal((await call('PUT', '/api/my/outlook/01-04-02-001', { expected_voters: 1500 }, oa)).status, 400, 'above 2026 register');
  assert.equal((await call('PUT', '/api/my/outlook/01-04-02-002', { expected_voters: 10 }, oa)).status, 403, 'not their unit');
  assert.equal((await call('PUT', '/api/my/outlook/01-04-02-001', { expected_voters: -1 }, oa)).status, 400);
  const saved = await call('PUT', '/api/my/outlook/01-04-02-001', { expected_voters: 700, target_votes: 400 }, oa);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.expected_voters, 700);
  // partial update keeps the other field
  await call('PUT', '/api/my/outlook/01-04-02-001', { expected_voters: 720 }, oa);
  // admin can override a target on any unit
  assert.equal((await call('PUT', '/api/admin/outlook/01-04-02-001', { target_votes: 450 }, admin)).status, 200);
  const all = (await call('GET', '/api/admin/outlook', null, admin)).json;
  const u = all.units.find((x) => x.code === '01-04-02-001');
  assert.deepEqual([u.expected, u.target, u.reg2026], [720, 450, 1400]);
  assert.equal(all.units.length, 214);
  // agents cannot reach admin outlook, settings or upload
  assert.equal((await call('GET', '/api/admin/outlook', null, oa)).status, 403);
  assert.equal((await call('POST', '/api/admin/register-2026', { rows }, oa)).status, 403);
  const act = (await call('GET', '/api/admin/activity?limit=50', null, admin)).json.activity.map((a) => a.action);
  assert.ok(act.includes('register2026.upload') && act.includes('outlook.save') && act.includes('settings.update'));
});
