'use strict';
/**
 * 2023 vs 2026/27 comparison ("outlook"):
 *  - 2026 register: uploaded by admin (registered_2026 per polling unit)
 *  - expected voters: people expected to vote in the upcoming election, entered per PU
 *  - target votes: votes the party needs at the PU (agent enters for own units; admin can set any)
 *  - settings: party name (not yet announced) and which 2023 column, if any, is that party
 */
const { query, tx, NOW } = require('./db');

const MAX_COUNT = 100000;
const PARTY_COLUMNS = ['', 'pdp', 'apc', 'lp'];
const DEFAULT_SETTINGS = { party_name: '', party_2023: '', election_year: '2027', register_2026_at: '', register_2026_source: '' };

class OutlookError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

async function getSettings() {
  const rows = await query('SELECT key, value FROM settings');
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
}

async function saveSettings(q, patch) {
  for (const [k, v] of Object.entries(patch)) {
    await q('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value', [k, String(v)]);
  }
}

function cleanSettings(body) {
  const out = {};
  if (body.party_name !== undefined) {
    const n = String(body.party_name).trim();
    if (n.length > 40) throw new OutlookError(400, 'Party name must be 40 characters or fewer.');
    out.party_name = n;
  }
  if (body.party_2023 !== undefined) {
    const c = String(body.party_2023).toLowerCase();
    if (!PARTY_COLUMNS.includes(c)) throw new OutlookError(400, 'The 2023 party must be PDP, APC, LP or none.');
    out.party_2023 = c;
  }
  if (!Object.keys(out).length) throw new OutlookError(400, 'Nothing to update.');
  return out;
}

/** Validate an uploaded register: rows [{code, registered}] -> preview of what would change. */
async function planRegister(rows) {
  if (!Array.isArray(rows) || !rows.length) throw new OutlookError(400, 'The file has no rows with a polling-unit code and a registered-voters number.');
  if (rows.length > 5000) throw new OutlookError(400, 'Too many rows (limit 5,000).');
  const pus = await query('SELECT code, name, ward, registered, registered_2026 FROM polling_units');
  const byCode = new Map(pus.map((p) => [p.code, p]));
  const seen = new Map(); const unknown = []; const invalid = []; const duplicates = [];
  rows.forEach((r, i) => {
    const code = String(r.code ?? '').trim();
    const n = Number(String(r.registered ?? '').replace(/[,\s]/g, ''));
    if (!byCode.has(code)) { unknown.push(code || `(row ${i + 1})`); return; }
    if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) { invalid.push({ code, value: r.registered }); return; }
    if (seen.has(code)) duplicates.push(code);
    seen.set(code, n);
  });
  const updates = [...seen.entries()].map(([code, n]) => { const p = byCode.get(code); return { code, name: p.name, ward: p.ward, reg2023: p.registered, before: p.registered_2026, after: n }; });
  const missing = pus.filter((p) => !seen.has(p.code)).map((p) => ({ code: p.code, name: p.name, ward: p.ward }));
  const total2023 = pus.reduce((a, p) => a + p.registered, 0);
  const totalNew = pus.reduce((a, p) => a + (seen.has(p.code) ? seen.get(p.code) : (p.registered_2026 ?? 0)), 0);
  const big = updates.filter((u) => u.reg2023 && Math.abs(u.after - u.reg2023) / u.reg2023 >= 0.5).slice(0, 20);
  return { updates, missing, unknown: unknown.slice(0, 50), unknownCount: unknown.length, invalid: invalid.slice(0, 50), invalidCount: invalid.length, duplicates, total2023, totalNew, bigChanges: big };
}

async function commitRegister(user, plan, source, audit) {
  if (plan.invalidCount) throw new OutlookError(400, `${plan.invalidCount} row(s) have an invalid registered-voters number. Fix the file and upload again.`, { invalid: plan.invalid });
  await tx(async (q) => {
    await q(`UPDATE polling_units AS p SET registered_2026 = v.n FROM unnest($1::text[], $2::int[]) AS v(code, n) WHERE p.code = v.code`,
      [plan.updates.map((u) => u.code), plan.updates.map((u) => u.after)]);
    await saveSettings(q, { register_2026_at: new Date().toISOString().slice(0, 16).replace('T', ' '), register_2026_source: String(source || 'upload').slice(0, 120) });
    await audit(q, user, 'register2026.upload', { detail: `${source || 'upload'}: ${plan.updates.length} polling units updated, ${plan.missing.length} not in file` });
  });
}

function parseCount(v, label) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s]/g, ''));
  if (!Number.isInteger(n) || n < 0 || n > MAX_COUNT) throw new OutlookError(400, `${label} must be a whole number of 0 or more.`);
  return n;
}

/** Save expected voters and/or target for one PU. Only fields present in body are changed. */
async function saveOutlook(user, code, body, { asAdmin }, audit) {
  const pu = (await query('SELECT code, agent_id, registered, registered_2026 FROM polling_units WHERE code = $1', [code]))[0];
  if (!pu) throw new OutlookError(404, 'Polling unit not found.');
  if (!asAdmin && pu.agent_id !== user.id) throw new OutlookError(403, 'This polling unit is not assigned to you.');
  const hasExp = Object.prototype.hasOwnProperty.call(body, 'expected_voters');
  const hasTgt = Object.prototype.hasOwnProperty.call(body, 'target_votes');
  if (!hasExp && !hasTgt) throw new OutlookError(400, 'Nothing to save.');
  const exp = hasExp ? parseCount(body.expected_voters, 'Expected voters') : undefined;
  const tgt = hasTgt ? parseCount(body.target_votes, 'Target votes') : undefined;
  const cap = pu.registered_2026;
  if (cap !== null && cap !== undefined) {
    if (exp !== undefined && exp !== null && exp > cap) throw new OutlookError(400, `Expected voters (${exp}) can't be more than the 2026 register for this unit (${cap}).`);
    if (tgt !== undefined && tgt !== null && tgt > cap) throw new OutlookError(400, `Target votes (${tgt}) can't be more than the 2026 register for this unit (${cap}).`);
  }
  await tx(async (q) => {
    await q('INSERT INTO outlook (pu_code) VALUES ($1) ON CONFLICT (pu_code) DO NOTHING', [code]);
    if (hasExp) await q(`UPDATE outlook SET expected_voters = $2, expected_by = $3, expected_at = ${NOW} WHERE pu_code = $1`, [code, exp, user.id]);
    if (hasTgt) await q(`UPDATE outlook SET target_votes = $2, target_by = $3, target_at = ${NOW} WHERE pu_code = $1`, [code, tgt, user.id]);
    await audit(q, user, 'outlook.save', { pu: code, detail: [hasExp && `expected ${exp ?? 'cleared'}`, hasTgt && `target ${tgt ?? 'cleared'}`].filter(Boolean).join(', ') + (asAdmin ? ' (admin)' : '') });
  });
  return (await query('SELECT expected_voters, target_votes, expected_at, target_at FROM outlook WHERE pu_code = $1', [code]))[0];
}

/** Per-unit comparison rows. `units` come from loadAll(); filter by agent when given. */
async function outlookRows(all, { agentId } = {}) {
  const extra = await query(`SELECT p.code, p.registered_2026, o.expected_voters, o.target_votes, o.expected_at, o.target_at
    FROM polling_units p LEFT JOIN outlook o ON o.pu_code = p.code`);
  const byCode = new Map(extra.map((r) => [r.code, r]));
  const v23 = (r) => ({ total: r.status === 'Complete' ? r.total : null, status: r.status, pdp: r.status === 'Complete' ? r.pdp : null, apc: r.status === 'Complete' ? r.apc : null, lp: r.status === 'Complete' ? r.lp : null });
  return all.presidential
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => agentId === undefined || r.agent_id === agentId)
    .map(({ r, i }) => {
      const x = byCode.get(r.code) || {};
      return {
        code: r.code, name: r.name, ward: r.ward, lga: r.lga || 'Bende', agent: r.agent_name || null,
        reg2023: r.registered, reg2026: x.registered_2026 ?? null,
        votes2023: { presidential: v23(all.presidential[i]), senate: v23(all.senate[i]), reps: v23(all.reps[i]) },
        expected: x.expected_voters ?? null, target: x.target_votes ?? null,
        expected_at: x.expected_at ?? null, target_at: x.target_at ?? null,
      };
    });
}

module.exports = { OutlookError, getSettings, saveSettings, cleanSettings, planRegister, commitRegister, saveOutlook, outlookRows };
