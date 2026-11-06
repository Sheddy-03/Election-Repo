'use strict';
const { db } = require('./db');
const { CONTESTS, decorate } = require('./results');

const CLASSES = ['A', 'B', 'C', 'D'];
const GROUPS = ['80Grp', '20grp'];

function loadAll() {
  const out = {};
  for (const key of Object.keys(CONTESTS)) {
    out[key] = db.prepare(`
      SELECT p.code, p.ward, p.name, p.registered, p.reg_class, p.group80, p.agent_id,
             r.pdp, r.apc, r.lp, r.accredited, r.valid, r.rejected, r.notes, r.updated_at
      FROM polling_units p
      LEFT JOIN results r ON r.pu_code = p.code AND r.contest = ?
      ORDER BY p.code`).all(key).map(decorate);
  }
  return out;
}

const sum = (rows, f) => rows.reduce((a, r) => a + (r[f] ?? 0), 0);
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function buildDashboard(ward) {
  const all = loadAll();
  const wards = db.prepare('SELECT DISTINCT ward FROM polling_units ORDER BY rowid').all().map((r) => r.ward);
  const sel = ward && wards.includes(ward) ? ward : null;
  const inSel = (r) => !sel || r.ward === sel;

  const contests = Object.entries(CONTESTS).map(([key, label]) => {
    const rows = all[key].filter(inSel);
    const done = rows.filter((r) => r.status === 'Complete');
    return {
      key, label,
      expected: rows.length,
      complete: done.length,
      incomplete: rows.filter((r) => r.status === 'Incomplete').length,
      check: rows.filter((r) => r.status === 'Check figures').length,
      missing: rows.filter((r) => r.status === 'Missing').length,
      coverage: rows.length ? done.length / rows.length : 0,
      pdp: sum(done, 'pdp'), apc: sum(done, 'apc'), lp: sum(done, 'lp'),
      pdpAvg: done.length ? sum(done, 'pdp') / done.length : null,
      apcAvg: done.length ? sum(done, 'apc') / done.length : null,
      lpAvg: done.length ? sum(done, 'lp') / done.length : null,
      totalVotes: sum(done, 'total'),
      accredited: sum(done, 'accredited'),
      registered: sum(done, 'registered'),
      avgTurnout: avg(done.map((r) => r.turnout)),
    };
  });

  const puRows = all.presidential; // register data is the same in every contest
  const wardTable = wards.map((w) => {
    const rows = puRows.filter((r) => r.ward === w);
    const row = {
      ward: w,
      registered: sum(rows, 'registered'),
      pus: rows.length,
      assigned: rows.filter((r) => r.agent_id).length,
    };
    for (const k of Object.keys(CONTESTS)) row[k] = all[k].filter((r) => r.ward === w && r.status === 'Complete').length;
    return row;
  });

  const profile = {
    classes: CLASSES.map((c) => {
      const rows = puRows.filter((r) => r.reg_class === c && inSel(r));
      return {
        cls: c, pus: rows.length, registered: sum(rows, 'registered'),
        g80: rows.filter((r) => r.group80 === '80Grp').length,
        g20: rows.filter((r) => r.group80 === '20grp').length,
      };
    }),
    groups: GROUPS.map((g) => {
      const rows = puRows.filter((r) => r.group80 === g && inSel(r));
      return { group: g, pus: rows.length, registered: sum(rows, 'registered') };
    }),
  };

  const byGroup = [];
  for (const [key, label] of Object.entries(CONTESTS)) {
    for (const g of GROUPS) {
      const rows = all[key].filter((r) => r.group80 === g && inSel(r));
      const done = rows.filter((r) => r.status === 'Complete');
      const registered = sum(done, 'registered');
      byGroup.push({
        contest: label, group: g, expected: rows.length, complete: done.length,
        coverage: rows.length ? done.length / rows.length : 0,
        pdp: sum(done, 'pdp'), apc: sum(done, 'apc'), lp: sum(done, 'lp'),
        totalVotes: sum(done, 'total'), registered,
        turnout: registered ? sum(done, 'total') / registered : null,
      });
    }
  }

  // Agent progress (always whole-LGA)
  const agents = db.prepare(`
    SELECT u.id, u.username, u.full_name, u.active,
           (SELECT COUNT(*) FROM polling_units p WHERE p.agent_id = u.id) AS assigned,
           (SELECT MAX(at) FROM audit_log a WHERE a.user_id = u.id AND a.action = 'result.save') AS last_entry
    FROM users u WHERE u.role = 'agent' ORDER BY u.full_name`).all().map((a) => {
    const mine = puRows.filter((r) => r.agent_id === a.id).map((r) => r.code);
    const set = new Set(mine);
    const prog = {};
    for (const k of Object.keys(CONTESTS)) prog[k] = all[k].filter((r) => set.has(r.code) && r.status === 'Complete').length;
    const flagged = Object.keys(CONTESTS).reduce((n, k) => n + all[k].filter((r) => set.has(r.code) && r.status === 'Check figures').length, 0);
    return { ...a, progress: prog, flagged };
  });

  const flagged = [];
  for (const [key, label] of Object.entries(CONTESTS)) {
    for (const r of all[key]) {
      if (r.status === 'Check figures' && inSel(r)) {
        flagged.push({ contest: key, contestLabel: label, code: r.code, name: r.name, ward: r.ward, agent_id: r.agent_id });
      }
    }
  }

  const totals = {
    registered: sum(puRows.filter(inSel), 'registered'),
    pus: puRows.filter(inSel).length,
    assigned: puRows.filter((r) => inSel(r) && r.agent_id).length,
    unassigned: puRows.filter((r) => inSel(r) && !r.agent_id).length,
    agents: agents.filter((a) => a.active).length,
  };

  return { ward: sel, wards, totals, contests, wardTable, profile, byGroup, agents, flagged: flagged.slice(0, 200), flaggedCount: flagged.length };
}

module.exports = { buildDashboard, loadAll };
