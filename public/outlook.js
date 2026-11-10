'use strict';
/* 2023 vs 2026/27 comparison: admin "2023 vs 2026" dashboard, agents' "My targets" view,
   2026 register upload and party settings. Uses helpers from app.js (h, api, fmt, pct, toast, modal,
   timers, CONTESTS, CLABEL) and dashboard.js (s, tip, sumBy, share, card, section, statTile, tableView). */

const STATUS_T = [
  ['met', 'Target met', 'var(--st-good)', '✓'],
  ['track', 'On track (75%+)', 'var(--st-ontrack)', '↗'],
  ['behind', 'Behind (<75%)', 'var(--st-critical)', '!'],
  ['notstarted', 'Target set, no expected voters yet', 'var(--st-warning)', '…'],
  ['notarget', 'No target set', 'var(--st-none)', '–'],
];
const STATUS_INFO = Object.fromEntries(STATUS_T.map(([k, l, c, i]) => [k, { label: l, color: c, icon: i }]));
function targetStatus(u) {
  if (u.target === null || u.target === undefined) return 'notarget';
  if (u.expected === null || u.expected === undefined) return 'notstarted';
  const r = u.target === 0 ? 1 : u.expected / u.target;
  return r >= 1 ? 'met' : r >= 0.75 ? 'track' : 'behind';
}
const statusChip = (k) => h('span', { class: 'chip tchip', style: `--c:${STATUS_INFO[k].color}` }, `${STATUS_INFO[k].icon} ${STATUS_INFO[k].label}`);
const signed = (n) => (n === null || n === undefined ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '±') + fmt(Math.abs(n)));
const signedPct = (n) => (n === null || n === undefined || !isFinite(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '±') + (Math.abs(n) * 100).toFixed(1) + '%');
const changeText = (a, b) => (a === null || b === null || a === undefined || b === undefined ? '—' : `${signed(b - a)} (${signedPct(a ? (b - a) / a : null)})`);
const partyLabel = (st) => st.party_name || 'the party';
const yearLabel = (st) => st.election_year || '2027';

// ---------- chart forms ----------
/** Small multiples of paired columns: one panel per measure, each with its own scale (registered voters
    and votes differ in size, so they never share an axis). cats: [{label, sub, a, b, target?, targetLabel?}] */
function columnPairs(cats, { aLabel, bLabel }) {
  return h('div', { class: 'colmulti' }, cats.map((c) => {
    const wrap = h('div', { class: 'colchart' });
    const draw = () => {
      const W = Math.max(150, wrap.clientWidth || 260), H = 220, m = { l: 40, r: 8, t: 22, b: 8 };
      const iw = W - m.l - m.r, ih = H - m.t - m.b;
      const max = Math.max(1, c.a || 0, c.b || 0, c.target || 0);
      const step = Math.pow(10, Math.floor(Math.log10(max))); const top = Math.ceil((max * 1.08) / step) * step;
      const y = (v) => m.t + ih - (v / top) * ih;
      const bw = Math.min(24, iw / 5);
      const xs = [m.l + iw * 0.3 - bw / 2, m.l + iw * 0.7 - bw / 2];
      const tickTxt = (v) => (v >= 10000 ? (v / 1000).toFixed(v % 1000 ? 1 : 0) + 'K' : fmt(v));
      const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${c.label}: ${aLabel} ${fmt(c.a)}, ${bLabel} ${fmt(c.b)}${c.target != null ? `, target ${fmt(c.target)}` : ''}` },
        [0, 0.5, 1].map((f) => [s('line', { x1: m.l, x2: W - m.r, y1: y(f * top), y2: y(f * top), class: f ? 'grid' : 'axis' }), s('text', { x: m.l - 6, y: y(f * top) + 4, 'text-anchor': 'end', class: 'tick' }, tickTxt(f * top))]));
      [[c.a, 'var(--y2023)', aLabel, xs[0]], [c.b, 'var(--y2026)', bLabel, xs[1]]].forEach(([v, color, lab, x]) => {
        if (v === null || v === undefined) { svg.append(s('text', { x: x + bw / 2, y: y(0) - 6, 'text-anchor': 'middle', class: 'tick' }, 'n/a')); return; }
        const hgt = Math.max(1, y(0) - y(v)), r = Math.min(4, hgt / 2);
        const d = `M${x},${y(0)} V${y(v) + r} Q${x},${y(v)} ${x + r},${y(v)} H${x + bw - r} Q${x + bw},${y(v)} ${x + bw},${y(v) + r} V${y(0)} Z`;
        svg.append(tip(s('path', { d, fill: color, tabindex: '0', class: 'colbar' }), () => [c.label, `${lab}: ${fmt(v)}`]),
          s('text', { x: x + bw / 2, y: y(v) - 6, 'text-anchor': 'middle', class: 'vlabel' }, fmt(v)));
      });
      if (c.target !== null && c.target !== undefined) {
        svg.append(tip(s('line', { x1: xs[1] - 6, x2: xs[1] + bw + 6, y1: y(c.target), y2: y(c.target), class: 'tgt', tabindex: '0' }), () => [c.label, `${c.targetLabel || 'Target'}: ${fmt(c.target)}`]));
      }
      wrap.replaceChildren(svg);
    };
    requestAnimationFrame(draw);
    let t; const onResize = () => { clearTimeout(t); t = setTimeout(() => (wrap.isConnected ? draw() : window.removeEventListener('resize', onResize)), 150); };
    window.addEventListener('resize', onResize);
    return h('div', { class: 'colpanel' }, h('div', { class: 'colhead' }, c.label), c.sub && h('div', { class: 'muted small' }, c.sub), wrap,
      h('div', { class: 'legend small' }, h('span', h('i', { style: 'background:var(--y2023)' }), `${aLabel}: ${fmt(c.a)}`), h('span', h('i', { style: 'background:var(--y2026)' }), `${bLabel}: ${fmt(c.b)}`),
        c.target != null && h('span', h('i', { class: 'tgtkey' }), `${c.targetLabel || 'Target'}: ${fmt(c.target)}`)));
  }));
}

/** Donut (pie) for part-to-whole with <= 5 parts. parts: {label, value, color, icon?} */
function donut(parts, { centerValue, centerLabel } = {}) {
  const total = sumBy(parts, (p) => p.value);
  const R = 70, r = 46, C = 2 * Math.PI * ((R + r) / 2), sw = R - r, size = 170;
  const svg = s('svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': parts.map((p) => `${p.label} ${fmt(p.value)} (${pct(share(p.value, total))})`).join(', ') });
  const g = s('g', { transform: `rotate(-90 ${size / 2} ${size / 2})` });
  svg.append(s('circle', { cx: size / 2, cy: size / 2, r: (R + r) / 2, fill: 'none', stroke: 'var(--idle-soft)', 'stroke-width': sw }), g);
  let off = 0;
  const visible = parts.filter((p) => p.value > 0);
  for (const p of visible) {
    const len = (p.value / total) * C, gap = visible.length > 1 ? Math.min(2, len / 2) : 0;
    const arc = s('circle', { cx: size / 2, cy: size / 2, r: (R + r) / 2, fill: 'none', stroke: p.color, 'stroke-width': sw, 'stroke-dasharray': `${Math.max(0, len - gap)} ${C}`, 'stroke-dashoffset': -off, tabindex: '0', class: 'arc' });
    g.append(tip(arc, () => [p.label, `${fmt(p.value)} · ${pct(share(p.value, total))}`]));
    off += len;
  }
  svg.append(s('text', { x: size / 2, y: size / 2 + 2, 'text-anchor': 'middle', class: 'dvalue' }, centerValue ?? fmt(total)),
    s('text', { x: size / 2, y: size / 2 + 20, 'text-anchor': 'middle', class: 'dlabel' }, centerLabel ?? 'total'));
  const legend = h('div', { class: 'dlegend' }, parts.map((p) => h('div', h('i', { style: `background:${p.color}` }), h('span', p.icon ? `${p.icon} ${p.label}` : p.label), h('b', fmt(p.value)), h('span', { class: 'muted' }, ((x) => (x > 0 && x < 0.01 ? '<1%' : pct(x, 0)))(share(p.value, total))))));
  return h('div', { class: 'donut' }, svg, legend);
}

/** Paired horizontal bars per row (2023 light, 2026/27 dark) with optional orange target tick. */
function yearBars(rows, { aLabel, bLabel, showTarget }) {
  const max = Math.max(1, ...rows.flatMap((r) => [r.a || 0, r.b || 0, showTarget ? r.target || 0 : 0]));
  const bar = (v, cls) => (v === null || v === undefined ? h('div', { class: 'yb-track' }, h('span', { class: 'muted small' }, 'no data')) : h('div', { class: 'yb-track' }, h('i', { class: cls, style: `width:${Math.max(0.5, (v / max) * 100)}%` })));
  return h('div', { class: 'ybars' },
    h('div', { class: 'legend' }, h('span', h('i', { style: 'background:var(--y2023)' }), aLabel), h('span', h('i', { style: 'background:var(--y2026)' }), bLabel), showTarget && h('span', h('i', { class: 'tgtkey' }), 'Party target')),
    rows.map((r) => tip(h('div', { class: 'yb', tabindex: '0' },
      h('div', { class: 'hb-label' }, h('div', { class: 'hb-name' }, r.label), r.sub && h('div', { class: 'hb-sub' }, r.sub)),
      h('div', { class: 'yb-bars' }, bar(r.a, 'ya'), h('div', { class: 'yb-b' }, bar(r.b, 'yb2'), showTarget && r.target !== null && r.target !== undefined ? h('em', { class: 'tick-t', style: `left:${(r.target / max) * 100}%` }) : null)),
      h('div', { class: 'hb-val' }, h('div', `${fmt(r.a)} → ${fmt(r.b)}`), h('div', { class: 'muted small' }, changeText(r.a, r.b)))),
    () => [r.label, `${aLabel}: ${fmt(r.a)}`, `${bLabel}: ${fmt(r.b)}`, `Change: ${changeText(r.a, r.b)}`, ...(showTarget && r.target != null ? [`Party target: ${fmt(r.target)}`] : [])])));
}

/** Bullet: expected voters bar against target tick. */
function bullet(expected, target, max) {
  const top = Math.max(1, max ?? Math.max(expected || 0, target || 0) * 1.1);
  return h('div', { class: 'bullet' }, expected != null ? h('i', { style: `width:${Math.min(100, (expected / top) * 100)}%` }) : null,
    target != null ? h('em', { class: 'tick-t', style: `left:${Math.min(100, (target / top) * 100)}%` }) : null);
}

// ---------- shared aggregation ----------
function aggregate(units, contest, st) {
  const both = units.filter((u) => u.reg2026 !== null);
  const v = (u) => u.votes2023[contest];
  const complete = units.filter((u) => v(u).total !== null);
  const withExp = units.filter((u) => u.expected !== null);
  const expAnd23 = withExp.filter((u) => v(u).total !== null);
  const withTgt = units.filter((u) => u.target !== null);
  const party = st.party_2023;
  return {
    reg23All: sumBy(units, (u) => u.reg2023), reg26: sumBy(both, (u) => u.reg2026), reg23Both: sumBy(both, (u) => u.reg2023), regUnits: both.length,
    votes23: sumBy(complete, (u) => v(u).total), reg23Complete: sumBy(complete, (u) => u.reg2023), completeUnits: complete.length,
    expected: sumBy(withExp, (u) => u.expected), expUnits: withExp.length,
    expVs23: { exp: sumBy(expAnd23, (u) => u.expected), v23: sumBy(expAnd23, (u) => v(u).total), n: expAnd23.length },
    reg26ForExp: sumBy(withExp.filter((u) => u.reg2026 !== null), (u) => u.reg2026), expWithReg: sumBy(withExp.filter((u) => u.reg2026 !== null), (u) => u.expected),
    target: sumBy(withTgt, (u) => u.target), tgtUnits: withTgt.length,
    expForTgt: sumBy(withTgt, (u) => u.expected || 0),
    party23: party ? sumBy(complete, (u) => v(u)[party]) : null,
    status: Object.fromEntries(STATUS_T.map(([k]) => [k, units.filter((u) => targetStatus(u) === k).length])),
  };
}

// ---------- admin: 2023 vs 2026 dashboard ----------
function outlookView(root) {
  const st = { contest: 'presidential', ward: '', q: '', sort: 'code', dir: 1, data: null, showAll: false };
  const filters = h('div', { class: 'filterbar' });
  const body = h('div', { class: 'dash' });
  root.append(filters, body);

  async function load() { st.data = await api('GET', '/api/admin/outlook'); paint(); }

  function paintFilters() {
    const wards = [...new Set(st.data.units.map((u) => u.ward))];
    const ws = h('select', { 'aria-label': 'Ward', onchange: (e) => { st.ward = e.target.value; paint(); } }, h('option', { value: '' }, 'All wards (Bende LGA)'), wards.map((w) => h('option', { value: w }, w)));
    ws.value = st.ward;
    filters.replaceChildren(
      h('div', { class: 'seg', role: 'tablist', 'aria-label': '2023 contest for comparison' }, CONTESTS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(st.contest === k), onclick: () => { st.contest = k; paint(); } }, `2023 ${l.replace('House of Reps', 'Reps')}`))),
      h('div', { class: 'field sm' }, ws), h('div', { class: 'spacer' }),
      h('button', { class: 'btn small', onclick: () => registerDialog(load) }, 'Upload 2026 register'),
      h('button', { class: 'btn ghost small', onclick: () => settingsDialog(st.data.settings, load) }, 'Party settings'),
      h('button', { class: 'btn ghost small', onclick: exportCsv }, 'Export comparison (CSV)'));
  }

  const scoped = () => st.data.units.filter((u) => !st.ward || u.ward === st.ward);

  function exportCsv() {
    const S = st.data.settings, C = st.contest;
    const head = ['PU code', 'Polling unit', 'Ward', 'LGA', 'Registered 2023', 'Registered 2026', 'Register change', `Votes cast 2023 (${CLABEL[C]})`, `Expected voters ${yearLabel(S)}`, `${partyLabel(S)} target votes`, 'Expected ÷ target', 'Target status', 'Agent'];
    const esc = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const lines = [head, ...scoped().map((u) => [u.code, u.name, u.ward, u.lga, u.reg2023, u.reg2026 ?? '', u.reg2026 === null ? '' : u.reg2026 - u.reg2023, u.votes2023[C].total ?? '', u.expected ?? '', u.target ?? '', u.target ? (u.expected ?? 0) / u.target : '', STATUS_INFO[targetStatus(u)].label, u.agent || ''])].map((r) => r.map(esc).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    const a = h('a', { href: url, download: 'bende-2023-vs-2026-comparison.csv' }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function paint() {
    paintFilters();
    const S = st.data.settings, C = st.contest, units = scoped(), A = aggregate(units, C, S);
    const scopeName = st.ward ? `${st.ward} ward` : 'Bende LGA';
    const notices = [
      !A.regUnits && h('div', { class: 'notice warn' }, 'The 2026 register has not been uploaded yet. Click “Upload 2026 register” to load it from the INEC spreadsheet.'),
      A.regUnits && A.regUnits < units.length && h('div', { class: 'notice warn' }, `The 2026 register covers ${A.regUnits} of ${units.length} polling units in scope. Register comparisons use only units that have both years.`),
      !S.party_name && h('div', { class: 'notice' }, 'The party has not been named yet. Targets are shown as “party target”; set the name later in “Party settings”.'),
    ].filter(Boolean);
    const turnout23 = share(A.votes23, A.reg23Complete), turnout27 = share(A.expWithReg, A.reg26ForExp);

    body.replaceChildren(...[
      h('div', { class: 'dash-title' }, h('h1', `${scopeName} · 2023 against ${yearLabel(S)}`),
        h('p', { class: 'muted' }, `Registered voters 2023 vs 2026 register · 2023 ${CLABEL[C]} votes cast vs expected voters for the ${yearLabel(S)} election · ${S.party_name ? S.party_name + ' targets' : 'party targets'}`)),
      ...notices,
      h('div', { class: 'grid tiles kpis' },
        statTile('Registered voters · 2026 register', A.regUnits ? fmt(A.reg26) : '—', A.regUnits ? `2023: ${fmt(A.reg23Both)} · change ${changeText(A.reg23Both, A.reg26)}${A.regUnits < units.length ? ` · ${A.regUnits} of ${units.length} units` : ''}` : `2023 register: ${fmt(A.reg23All)}`, true),
        statTile(`Expected voters ${yearLabel(S)}`, A.expUnits ? fmt(A.expected) : '—', A.expUnits ? `${A.expUnits} of ${units.length} units entered · vs 2023 votes in the same units: ${changeText(A.expVs23.v23, A.expVs23.exp)}` : 'Agents have not entered expected voters yet'),
        statTile(`2023 votes cast · ${CLABEL[C]}`, fmt(A.votes23), `${A.completeUnits} units with complete results · turnout ${pct(turnout23)}`),
        statTile('Projected turnout', pct(turnout27), A.expUnits ? `Expected ÷ 2026 register · 2023 turnout ${pct(turnout23)}` : 'Needs expected voters and the 2026 register'),
        statTile(`${S.party_name || 'Party'} target votes`, A.tgtUnits ? fmt(A.target) : '—', A.tgtUnits ? `${A.tgtUnits} units · expected voters cover ${pct(share(A.expForTgt, A.target), 0)} of target${A.party23 !== null ? ` · 2023 ${S.party_name}: ${fmt(A.party23)}` : ''}` : 'No targets set yet'),
        statTile('Units on target', `${A.status.met} / ${units.length}`, `${A.status.track} on track · ${A.status.behind} behind · ${A.status.notstarted + A.status.notarget} not started`)),

      section('At a glance', `${scopeName}. 2023 bars are light, 2026/${yearLabel(S)} bars are dark; the orange line is the party target.`,
        h('div', { class: 'two' },
          card('2023 compared with now', 'Registered voters use units with both registers; voters use units with a complete 2023 result and an expected figure.',
            columnPairs([
              { label: 'Registered voters', sub: '2023 vs 2026 register', a: A.regUnits ? A.reg23Both : A.reg23All, b: A.regUnits ? A.reg26 : null },
              { label: 'Voters', sub: `2023 votes cast vs ${yearLabel(S)} expected`, a: A.expVs23.n ? A.expVs23.v23 : A.votes23, b: A.expVs23.n ? A.expVs23.exp : null, target: A.tgtUnits ? A.target : null, targetLabel: `${partyLabel(S)} target` },
            ], { aLabel: '2023', bLabel: `2026/${yearLabel(S)}` }),
            tableView(['Measure', '2023', `2026/${yearLabel(S)}`, 'Change'], [
              ['Registered voters', fmt(A.regUnits ? A.reg23Both : A.reg23All), A.regUnits ? fmt(A.reg26) : '—', A.regUnits ? changeText(A.reg23Both, A.reg26) : '—'],
              ['Voters', fmt(A.expVs23.n ? A.expVs23.v23 : A.votes23), A.expVs23.n ? fmt(A.expVs23.exp) : '—', A.expVs23.n ? changeText(A.expVs23.v23, A.expVs23.exp) : '—'],
              ['Party target', '', A.tgtUnits ? fmt(A.target) : '—', ''],
            ], 1)),
          h('div',
            card('Target progress by polling unit', `Expected voters compared with the ${partyLabel(S)} target at each unit.`,
              donut(STATUS_T.map(([k, l, c, i]) => ({ label: l, value: A.status[k], color: c, icon: i })), { centerValue: `${A.status.met}`, centerLabel: 'units met' })),
            card(A.regUnits ? '2026 register by polling-unit size' : '2023 register by polling-unit size', 'Size class of each unit (A largest … D smallest).',
              (() => { const val = (u) => (A.regUnits ? u.reg2026 || 0 : u.reg2023); const cls = (u) => { const r = A.regUnits ? u.reg2026 : u.reg2023; return r == null ? null : r >= 769 ? 'A' : r >= 525 ? 'B' : r >= 280 ? 'C' : 'D'; };
                return donut(['A', 'B', 'C', 'D'].map((c) => ({ label: `Class ${c}`, value: sumBy(units.filter((u) => cls(u) === c), val), color: `var(--cls-${c.toLowerCase()})` })), { centerLabel: 'voters' }); })())))),

      wardSection(units, S, C),
      changesSection(units),
      agentSection(units, S),
      tableSection(units, S, C),
    ].filter(Boolean));
  }

  function wardSection(units, S, C) {
    const wards = [...new Set(units.map((u) => u.ward))];
    const agg = wards.map((w) => { const us = units.filter((u) => u.ward === w); const both = us.filter((u) => u.reg2026 !== null); const c = us.filter((u) => u.votes2023[C].total !== null); const e = us.filter((u) => u.expected !== null); const t = us.filter((u) => u.target !== null);
      return { w, n: us.length, reg23: sumBy(both.length ? both : us, (u) => u.reg2023), reg26: both.length ? sumBy(both, (u) => u.reg2026) : null, v23: c.length ? sumBy(c, (u) => u.votes2023[C].total) : null, exp: e.length ? sumBy(e, (u) => u.expected) : null, tgt: t.length ? sumBy(t, (u) => u.target) : null }; })
      .sort((a, b) => b.reg23 - a.reg23);
    return section('By ward', 'How each ward compares. Hover a row for exact figures.',
      h('div', { class: 'two' },
        card('Registered voters: 2023 vs 2026', null, yearBars(agg.map((x) => ({ label: x.w, sub: `${x.n} polling units`, a: x.reg23, b: x.reg26 })), { aLabel: '2023 register', bLabel: '2026 register' }),
          tableView(['Ward', '2023', '2026', 'Change'], agg.map((x) => [x.w, fmt(x.reg23), fmt(x.reg26), changeText(x.reg23, x.reg26)]), 1)),
        card(`Voters: 2023 ${CLABEL[C]} votes cast vs ${yearLabel(S)} expected`, `Orange line = ${partyLabel(S)} target.`, yearBars(agg.map((x) => ({ label: x.w, sub: `${x.n} polling units`, a: x.v23, b: x.exp, target: x.tgt })), { aLabel: '2023 votes cast', bLabel: `Expected ${yearLabel(S)}`, showTarget: true }),
          tableView(['Ward', '2023 votes', 'Expected', 'Change', 'Target'], agg.map((x) => [x.w, fmt(x.v23), fmt(x.exp), changeText(x.v23, x.exp), fmt(x.tgt)]), 1))));
  }

  function changesSection(units) {
    const ch = units.filter((u) => u.reg2026 !== null).map((u) => ({ ...u, d: u.reg2026 - u.reg2023, p: u.reg2023 ? (u.reg2026 - u.reg2023) / u.reg2023 : null }));
    if (!ch.length) return null;
    const up = [...ch].sort((a, b) => b.d - a.d).slice(0, 10), down = [...ch].sort((a, b) => a.d - b.d).slice(0, 10).filter((u) => u.d < 0);
    const tbl = (rows) => h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Polling unit', 'Ward', '2023', '2026', 'Change'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
      h('tbody', rows.map((u) => h('tr', h('td', u.name), h('td', { class: 'small' }, u.ward), h('td', { class: 'num' }, fmt(u.reg2023)), h('td', { class: 'num' }, fmt(u.reg2026)), h('td', { class: 'num ' + (u.d > 0 ? 'up' : u.d < 0 ? 'down' : '') }, `${u.d > 0 ? '▲' : u.d < 0 ? '▼' : ''} ${changeText(u.reg2023, u.reg2026)}`))))));
    return section('Biggest register changes', 'Polling units whose registered voters changed most between 2023 and 2026.',
      h('div', { class: 'two' }, card('Largest increases', null, tbl(up)), card('Largest decreases', null, down.length ? tbl(down) : h('p', { class: 'muted' }, 'No unit lost registered voters.'))));
  }

  function agentSection(units, S) {
    const by = new Map();
    for (const u of units) { const k = u.agent || 'Unassigned'; const a = by.get(k) || { name: k, n: 0, exp: 0, tgt: 0, expN: 0, tgtN: 0, met: 0 }; a.n++; if (u.expected !== null) { a.exp += u.expected; a.expN++; } if (u.target !== null) { a.tgt += u.target; a.tgtN++; } if (targetStatus(u) === 'met') a.met++; by.set(k, a); }
    const rows = [...by.values()].sort((a, b) => (b.tgt ? b.exp / b.tgt : 0) - (a.tgt ? a.exp / a.tgt : 0));
    const max = Math.max(1, ...rows.flatMap((r) => [r.exp, r.tgt]));
    return section('Agent targets', `Expected voters (bar) against ${partyLabel(S)} target (orange line), per agent.`,
      h('div', { class: 'card' }, h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Agent', 'Units', 'Expected voters', 'Target', 'Progress', '', 'Units met'].map((x, i) => h('th', { class: [1, 2, 3, 6].includes(i) ? 'num' : '' }, x)))),
        h('tbody', rows.map((r) => h('tr', h('td', r.name), h('td', { class: 'num' }, r.n), h('td', { class: 'num' }, r.expN ? fmt(r.exp) : '—'), h('td', { class: 'num' }, r.tgtN ? fmt(r.tgt) : '—'),
          h('td', { style: 'min-width:160px' }, bullet(r.expN ? r.exp : null, r.tgtN ? r.tgt : null, max)), h('td', { class: 'num small' }, r.tgt ? pct(r.exp / r.tgt, 0) : '—'), h('td', { class: 'num' }, `${r.met}/${r.n}`))))))));
  }

  function tableSection(units, S, C) {
    const cols = [['code', 'PU code'], ['name', 'Polling unit'], ['ward', 'Ward'], ['reg2023', 'Reg. 2023', 1], ['reg2026', 'Reg. 2026', 1], ['regchg', 'Change', 1], ['v23', `Votes 2023`, 1], ['expected', `Expected ${yearLabel(S)}`, 1], ['target', 'Target', 1], ['prog', 'Progress', 1], ['status', 'Status'], ['agent', 'Agent']];
    const val = (u, k) => ({ regchg: u.reg2026 === null ? -1e9 : u.reg2026 - u.reg2023, v23: u.votes2023[C].total ?? -1, prog: u.target ? (u.expected ?? 0) / u.target : -1, status: targetStatus(u) }[k] ?? u[k] ?? (typeof u.reg2023 === 'number' && ['reg2026', 'expected', 'target'].includes(k) ? -1 : ''));
    const q = st.q.trim().toLowerCase();
    let rows = units.filter((u) => !q || `${u.code} ${u.name} ${u.ward} ${u.agent || ''}`.toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => { const x = val(a, st.sort), y = val(b, st.sort); return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir; });
    const shown = st.showAll ? rows : rows.slice(0, 30);
    const search = h('input', { type: 'search', class: 'ol-search', placeholder: 'Search polling unit, code, ward or agent…', value: st.q, oninput: (e) => { st.q = e.target.value; const c = e.target.selectionStart; paint(); const n = document.querySelector('.ol-search'); if (n) { n.focus(); n.setSelectionRange(c, c); } } });
    const th = ([k, l, num]) => h('th', { class: (num ? 'num ' : '') + 'sortable', tabindex: '0', 'aria-sort': st.sort === k ? (st.dir > 0 ? 'ascending' : 'descending') : 'none',
      onclick: () => { if (st.sort === k) st.dir *= -1; else { st.sort = k; st.dir = num ? -1 : 1; } paint(); }, onkeydown: (e) => { if (e.key === 'Enter') e.target.click(); } }, l, st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : '');
    return section('Every polling unit', 'Click a row to set or correct expected voters and the target (admin override).',
      h('div', { class: 'card' }, h('div', { class: 'row', style: 'align-items:center;margin-bottom:10px' }, h('div', { class: 'field' }, search), h('span', { class: 'muted small' }, `${rows.length} units`)),
        h('div', { class: 'tablewrap' }, h('table', { class: 'oltable' }, h('thead', h('tr', cols.map(th))),
          h('tbody', shown.map((u) => { const d = u.reg2026 === null ? null : u.reg2026 - u.reg2023; const k = targetStatus(u);
            return h('tr', { class: 'click', onclick: () => editOutlook(u, S, true, load) },
              h('td', { class: 'nowrap small' }, u.code), h('td', u.name), h('td', { class: 'small' }, u.ward), h('td', { class: 'num' }, fmt(u.reg2023)), h('td', { class: 'num' }, fmt(u.reg2026)),
              h('td', { class: 'num small ' + (d > 0 ? 'up' : d < 0 ? 'down' : '') }, d === null ? '—' : signedPct(u.reg2023 ? d / u.reg2023 : null)),
              h('td', { class: 'num' }, fmt(u.votes2023[C].total)), h('td', { class: 'num' }, fmt(u.expected)), h('td', { class: 'num' }, fmt(u.target)),
              h('td', { class: 'num small' }, u.target ? pct((u.expected ?? 0) / u.target, 0) : '—'), h('td', statusChip(k)), h('td', { class: 'small' }, u.agent || '—')); })))),
        rows.length > 30 && h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', onclick: () => { st.showAll = !st.showAll; paint(); } }, st.showAll ? 'Show first 30' : `Show all ${rows.length}`))));
  }

  load().catch((e) => toast(e.message, true));
  timers.push(setInterval(() => { if (document.querySelector('.overlay') || (root.contains(document.activeElement) && document.activeElement.matches('input,select'))) return; load().catch(() => {}); }, 30000));
}

// ---------- edit expected / target (agent for own units, admin for any) ----------
function editOutlook(u, S, asAdmin, reload) {
  const err = h('div', { class: 'notice bad', hidden: true });
  const cap = u.reg2026;
  const exp = h('input', { id: 'o-exp', inputmode: 'numeric', pattern: '[0-9]*', value: u.expected ?? '', autocomplete: 'off' });
  const tgt = h('input', { id: 'o-tgt', inputmode: 'numeric', pattern: '[0-9]*', value: u.target ?? '', autocomplete: 'off' });
  const live = h('div', { class: 'calc' });
  const num = (el) => (el.value.trim() === '' ? null : Number(el.value.replace(/[,\s]/g, '')));
  const refresh = () => {
    const e = num(exp), t = num(tgt);
    const bad = [e, t].some((x) => x !== null && (!Number.isInteger(x) || x < 0)) ? 'Use whole numbers of 0 or more.' : cap != null && e !== null && e > cap ? `Expected voters can't be more than the 2026 register (${fmt(cap)}).` : cap != null && t !== null && t > cap ? `Target can't be more than the 2026 register (${fmt(cap)}).` : '';
    err.textContent = bad; err.hidden = !bad; save.disabled = !!bad;
    live.replaceChildren(h('div', h('div', { class: 'muted small' }, 'Progress to target'), h('b', t ? pct((e ?? 0) / t, 0) : '—')), h('div', h('div', { class: 'muted small' }, 'Status'), statusChip(targetStatus({ expected: e, target: t }))), h('div', { style: 'flex:1;min-width:160px' }, bullet(e, t)));
  };
  exp.oninput = tgt.oninput = refresh;
  const save = h('button', { class: 'btn', type: 'button', onclick: async () => {
    save.disabled = true;
    try { await api('PUT', `/api/${asAdmin ? 'admin' : 'my'}/outlook/${u.code}`, { expected_voters: num(exp), target_votes: num(tgt) }); toast('Saved.'); box.close(); reload && reload(); }
    catch (e) { err.textContent = e.message; err.hidden = false; save.disabled = false; }
  } }, 'Save');
  const v = u.votes2023;
  const box = modal(u.name, h('div',
    h('p', { class: 'muted small' }, `${u.code} · ${u.ward} · Bende LGA`),
    asAdmin && h('p', { class: 'notice warn' }, 'Administrator override — recorded in the activity log.'),
    h('div', { class: 'grid facts' },
      h('div', h('span', 'Registered 2023'), h('b', fmt(u.reg2023))), h('div', h('span', 'Registered 2026'), h('b', fmt(u.reg2026))),
      ...CONTESTS.map(([k, l]) => h('div', h('span', `2023 votes · ${l.replace('House of Reps', 'Reps')}`), h('b', fmt(v[k].total)))),
      S.party_2023 && h('div', h('span', `2023 ${S.party_name || S.party_2023.toUpperCase()} votes (Pres.)`), h('b', fmt(v.presidential[S.party_2023])))),
    h('div', { class: 'row', style: 'margin-top:14px' },
      h('div', { class: 'field' }, h('label', { for: 'o-exp' }, `Expected voters (${yearLabel(S)})`), exp, h('div', { class: 'muted small' }, 'People expected to vote at this unit')),
      h('div', { class: 'field' }, h('label', { for: 'o-tgt' }, `${S.party_name || 'Party'} target votes`), tgt, h('div', { class: 'muted small' }, 'Votes the party needs at this unit'))),
    live, err, h('div', { class: 'row' }, save)));
  refresh();
}

// ---------- agent: My targets ----------
function agentOutlook(root) {
  root.append(h('p', { class: 'muted' }, 'Loading your targets…'));
  async function load() {
    const { settings: S, units } = await api('GET', '/api/my/outlook');
    const A = aggregate(units, 'presidential', S);
    const max = Math.max(1, ...units.flatMap((u) => [u.expected || 0, u.target || 0]));
    fill(root,
      h('div', { class: 'head' }, h('h2', `My targets · ${yearLabel(S)} election`), h('span', { class: 'muted' }, S.party_name ? `Party: ${S.party_name}` : 'Party to be announced')),
      !units.length ? h('div', { class: 'card' }, 'No polling units have been assigned to your account yet. Please contact the administrator.') : null,
      units.length ? h('div', { class: 'grid tiles kpis' },
        statTile('My target votes', A.tgtUnits ? fmt(A.target) : '—', A.tgtUnits ? `${A.tgtUnits} of ${units.length} units have a target` : 'Set a target for each unit below', true),
        statTile('My expected voters', A.expUnits ? fmt(A.expected) : '—', A.tgtUnits ? `${pct(share(A.expForTgt, A.target), 0)} of target` : `${A.expUnits} of ${units.length} units entered`),
        statTile('Registered voters', A.regUnits ? fmt(A.reg26) : fmt(A.reg23All), A.regUnits ? `2026 register · 2023: ${fmt(A.reg23Both)} · change ${changeText(A.reg23Both, A.reg26)}` : '2023 register (2026 not uploaded yet)'),
        statTile('Units on target', `${A.status.met} / ${units.length}`, `${A.status.track} on track · ${A.status.behind} behind`)) : null,
      units.length ? h('div', { class: 'two' },
        card('My progress', 'Expected voters against target, per unit.', donut(STATUS_T.map(([k, l, c, i]) => ({ label: l, value: A.status[k], color: c, icon: i })), { centerValue: A.tgtUnits ? pct(share(A.expForTgt, A.target), 0) : '—', centerLabel: 'of target' })),
        card('My units: 2023 compared with now', null, columnPairs([
          { label: 'Registered', sub: '2023 vs 2026', a: A.regUnits ? A.reg23Both : A.reg23All, b: A.regUnits ? A.reg26 : null },
          { label: 'Voters', sub: `2023 Presidential votes vs ${yearLabel(S)} expected`, a: A.expVs23.n ? A.expVs23.v23 : A.votes23, b: A.expVs23.n ? A.expVs23.exp : null, target: A.tgtUnits ? A.target : null },
        ], { aLabel: '2023', bLabel: `2026/${yearLabel(S)}` }))) : null,
      units.length ? h('div', { class: 'grid unitgrid' }, units.map((u) => { const k = targetStatus(u);
        return h('div', { class: 'card tcard' },
          h('div', { class: 'code' }, `${u.code} · ${u.ward}`), h('div', { class: 'nm' }, u.name),
          h('div', { class: 'grid facts' },
            h('div', h('span', 'Registered 2023 → 2026'), h('b', `${fmt(u.reg2023)} → ${fmt(u.reg2026)}`)),
            h('div', h('span', '2023 votes (Pres · Sen · Reps)'), h('b', CONTESTS.map(([c]) => fmt(u.votes2023[c].total)).join(' · '))),
            h('div', h('span', `Expected voters ${yearLabel(S)}`), h('b', fmt(u.expected))),
            h('div', h('span', 'Target votes'), h('b', fmt(u.target)))),
          bullet(u.expected, u.target, max),
          h('div', { class: 'row', style: 'align-items:center;justify-content:space-between;margin-top:10px' }, statusChip(k), h('button', { class: 'btn small', onclick: () => editOutlook(u, S, false, load) }, 'Update')));
      })) : null);
  }
  load().catch((e) => root.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
}

// ---------- admin: 2026 register upload ----------
function registerDialog(reload) {
  const file = h('input', { type: 'file', accept: '.xlsx,.csv,.txt', style: 'min-height:0' });
  const area = h('div');
  let rows = [], det = null, fname = '';
  file.onchange = async () => {
    const f = file.files[0]; if (!f) return;
    area.replaceChildren(h('p', { class: 'muted' }, 'Reading file…'));
    try {
      rows = await readSpreadsheet(f); fname = f.name; det = detectRegisterColumns(rows);
      if (det.codeCol < 0) throw new Error('No polling-unit codes (format 01-04-01-001) were found in this file.');
      mapping();
    } catch (e) { area.replaceChildren(h('div', { class: 'notice bad' }, e.message)); }
  };
  function mapping() {
    const colName = (c) => `Column ${String.fromCharCode(65 + (c % 26))}${det.header[c] ? ' – ' + det.header[c] : ''}`;
    const opts = (sel) => Array.from({ length: det.width }, (_, c) => h('option', { value: c, selected: c === sel }, colName(c)));
    const codeSel = h('select', opts(det.codeCol)), regSel = h('select', opts(det.regCol));
    const preview = h('div');
    const extract = () => rows.filter((r) => /^\d{2}-\d{2}-\d{2}-\d{3}$/.test(r[+codeSel.value] || '')).map((r) => ({ code: r[+codeSel.value], registered: r[+regSel.value] }));
    const showSample = () => preview.replaceChildren(h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', h('th', 'PU code'), h('th', { class: 'num' }, 'Registered (2026)'))), h('tbody', extract().slice(0, 5).map((r) => h('tr', h('td', r.code), h('td', { class: 'num' }, r.registered)))))));
    codeSel.onchange = regSel.onchange = showSample;
    const check = h('button', { class: 'btn', onclick: async () => {
      check.disabled = true;
      try { const plan = await api('POST', '/api/admin/register-2026', { rows: extract(), commit: false, source: fname }); summary(plan, extract()); }
      catch (e) { toast(e.message, true); check.disabled = false; }
    } }, 'Check file');
    fill(area, h('p', { class: 'small muted' }, `${rows.length} rows read from ${fname}. Confirm the two columns below.`),
      h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', 'Polling-unit code column'), codeSel), h('div', { class: 'field' }, h('label', 'Registered voters (2026) column'), regSel)),
      h('div', { style: 'margin:10px 0' }, preview), check);
    showSample();
  }
  function summary(p, data) {
    const save = h('button', { class: 'btn', disabled: p.invalidCount > 0, onclick: async () => {
      save.disabled = true;
      try { await api('POST', '/api/admin/register-2026', { rows: data, commit: true, source: fname }); toast(`2026 register saved for ${p.matched} polling units.`); box.close(); reload && reload(); }
      catch (e) { toast(e.message, true); save.disabled = false; }
    } }, `Save 2026 register (${p.matched} units)`);
    fill(area, 
      h('div', { class: 'grid facts' },
        h('div', h('span', 'Polling units matched'), h('b', `${p.matched} of 214`)), h('div', h('span', 'Bende units not in file'), h('b', p.missing)),
        h('div', h('span', 'Codes not in Bende (ignored)'), h('b', p.unknownCount)), h('div', h('span', 'Invalid numbers'), h('b', p.invalidCount)),
        h('div', h('span', 'Registered 2023 (all units)'), h('b', fmt(p.total2023))), h('div', h('span', 'Registered 2026 after saving'), h('b', fmt(p.totalNew)))),
      p.invalidCount ? h('div', { class: 'notice bad' }, `Fix these rows and upload again: ${p.invalid.slice(0, 8).map((x) => `${x.code} (“${x.value}”)`).join(', ')}`) : null,
      p.unknownCount ? h('p', { class: 'small muted' }, `Ignored codes (other LGAs or typos): ${p.unknown.slice(0, 10).join(', ')}${p.unknownCount > 10 ? '…' : ''}`) : null,
      p.duplicates.length ? h('div', { class: 'notice warn' }, `Codes listed more than once (the last value is used): ${p.duplicates.slice(0, 8).join(', ')}`) : null,
      p.missing ? h('div', { class: 'notice warn' }, `${p.missing} Bende polling unit(s) are not in the file and keep their current 2026 value (or none): ${p.missingSample.slice(0, 6).map((m) => m.code).join(', ')}${p.missing > 6 ? '…' : ''}`) : null,
      p.bigChanges.length ? h('div', h('p', { class: 'small' }, h('b', 'Large changes to double-check (50% or more):')), h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['PU code', 'Polling unit', '2023', '2026'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
        h('tbody', p.bigChanges.map((b) => h('tr', h('td', { class: 'small' }, b.code), h('td', b.name), h('td', { class: 'num' }, fmt(b.reg2023)), h('td', { class: 'num' }, fmt(b.after)))))))) : null,
      h('div', { class: 'row', style: 'margin-top:12px' }, save, h('button', { class: 'btn ghost', onclick: mapping }, 'Back')));
  }
  const box = modal('Upload 2026 register', h('div',
    h('p', { class: 'muted small' }, 'Choose the INEC register spreadsheet (.xlsx or .csv). It needs a polling-unit code column (e.g. 01-04-01-001) and a registered-voters column. You will see a check before anything is saved.'),
    h('div', { class: 'field' }, file), h('div', { style: 'margin-top:12px' }, area)));
}

// ---------- admin: party settings ----------
function settingsDialog(S, reload) {
  const name = h('input', { value: S.party_name || '', maxlength: 40, placeholder: 'e.g. leave blank until announced' });
  const col = h('select', [['', 'None / not in the 2023 results'], ['pdp', 'PDP'], ['apc', 'APC'], ['lp', 'LP']].map(([v, l]) => h('option', { value: v, selected: (S.party_2023 || '') === v }, l)));
  const save = h('button', { class: 'btn', onclick: async () => {
    save.disabled = true;
    try { await api('PUT', '/api/admin/settings', { party_name: name.value, party_2023: col.value }); toast('Party settings saved.'); box.close(); reload && reload(); }
    catch (e) { toast(e.message, true); save.disabled = false; }
  } }, 'Save');
  const box = modal('Party settings', h('div',
    h('div', { class: 'field' }, h('label', 'Party name'), name, h('div', { class: 'muted small' }, 'Shown on every target label for admins and agents.')),
    h('div', { class: 'field', style: 'margin-top:12px' }, h('label', 'This party in the 2023 results (optional)'), col, h('div', { class: 'muted small' }, 'If the party contested in 2023 as PDP, APC or LP, its 2023 votes are shown next to the targets.')),
    h('div', { class: 'row', style: 'margin-top:14px' }, save)));
}
