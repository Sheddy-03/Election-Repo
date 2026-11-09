'use strict';
/* Analyst dashboard (admin only). Loaded before app.js; uses its helpers (h, api, fmt, pct, chip, toast,
   timers, adminEdit, activityTable, CONTESTS, CLABEL) at call time. All figures are computed client-side from
   the /api/admin/dashboard `units` payload so ranks and shares stay consistent across every section. */

const PARTIES = [['pdp', 'PDP'], ['apc', 'APC'], ['lp', 'LP']];
const CLASS_INFO = { A: '769 or more', B: '525–768', C: '280–524', D: '0–279' };
const SMALL_REGISTER = 100; // units below this many registered voters are flagged for a register check

// ---------- tiny helpers ----------
const svgNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(svgNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v !== null && v !== undefined) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
const sumBy = (rows, f) => rows.reduce((a, r) => a + (f(r) || 0), 0);
const share = (n, d) => (d ? n / d : null);

// Shared tooltip: enhancement only; every value is also in a visible label or table view.
let tipEl;
function tip(target, lines) {
  const show = (x, y) => {
    tipEl ||= document.body.appendChild(h('div', { class: 'viztip', role: 'tooltip' }));
    tipEl.replaceChildren(...lines().map((l, i) => h('div', { class: i ? '' : 'tt-title' }, l)));
    tipEl.style.display = 'block';
    const r = tipEl.getBoundingClientRect();
    tipEl.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 8, x + 14)) + 'px';
    tipEl.style.top = Math.max(8, y - r.height - 12) + 'px';
  };
  const hide = () => { if (tipEl) tipEl.style.display = 'none'; };
  target.addEventListener('mousemove', (e) => show(e.clientX, e.clientY));
  target.addEventListener('mouseleave', hide);
  target.addEventListener('focus', () => { const b = target.getBoundingClientRect(); show(b.left + b.width / 2, b.top); });
  target.addEventListener('blur', hide);
  return target;
}

function tableView(head, rows, numFrom = 1) {
  return h('details', { class: 'tableview' }, h('summary', 'View as table'),
    h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', head.map((x, i) => h('th', { class: i >= numFrom ? 'num' : '' }, x)))),
      h('tbody', rows.map((r) => h('tr', r.map((c, i) => h('td', { class: i >= numFrom ? 'num' : '' }, c))))))));
}

const section = (title, sub, ...kids) => h('section', { class: 'dsec' }, h('div', { class: 'dsec-head' }, h('h2', title), sub && h('p', { class: 'muted small' }, sub)), ...kids);
const card = (title, sub, ...kids) => h('div', { class: 'card vcard' }, title && h('h3', title), sub && h('p', { class: 'muted small vsub' }, sub), ...kids);

// ---------- chart forms ----------
/** Ranked horizontal bars, one series. rows: {label, sub, value, valueText, tipLines} */
function hbars(rows, { max } = {}) {
  const top = max ?? Math.max(1, ...rows.map((r) => r.value));
  return h('div', { class: 'hbars' }, rows.map((r) => tip(h('div', { class: 'hbar', tabindex: '0', 'aria-label': `${r.label}: ${r.valueText}` },
    h('div', { class: 'hb-label' }, h('div', { class: 'hb-name' }, r.label), r.sub && h('div', { class: 'hb-sub' }, r.sub)),
    h('div', { class: 'hb-track' }, h('i', { style: `width:${Math.max(0.5, (r.value / top) * 100)}%` })),
    h('div', { class: 'hb-val' }, r.valueText)), () => r.tipLines)));
}

/** Tall segmented bar (part-to-whole). parts: {key, label, value, color} */
function segbar(parts, { unit = '' } = {}) {
  const total = sumBy(parts, (p) => p.value);
  const bar = h('div', { class: 'segbar', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${pct(share(p.value, total))}`).join(', ') },
    parts.filter((p) => p.value > 0).map((p) => {
      const w = share(p.value, total);
      const seg = h('div', { class: 'seg', tabindex: '0', style: `flex:${p.value} 1 0;background:${p.color};color:${p.ink || '#fff'}` },
        w >= 0.09 ? h('span', `${p.short || p.label} ${pct(w, 0)}`) : null);
      return tip(seg, () => [p.label, `${fmt(p.value)}${unit} · ${pct(w)}`]);
    }));
  const legend = h('div', { class: 'legend' }, parts.map((p) => h('span', h('i', { style: `background:${p.color}` }), p.label)));
  return h('div', bar, legend);
}

/** Cumulative share of voters as units are added largest-first (Pareto / concentration curve). */
function concentrationChart(ranked, total) {
  const wrap = h('div', { class: 'conc' });
  const draw = () => {
    const W = Math.max(300, wrap.clientWidth || 600), H = 262, m = { l: 44, r: 16, t: 14, b: 46 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b, n = ranked.length;
    const x = (i) => m.l + (i / n) * iw, y = (v) => m.t + ih - v * ih;
    const pts = [[0, 0]]; let c = 0;
    ranked.forEach((u, i) => { c += u.registered; pts.push([i + 1, c / total]); });
    const line = pts.map(([i, v], k) => `${k ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join('');
    const marks = [0.5, 0.8].map((t) => { const i = pts.findIndex(([, v]) => v >= t); return { t, i }; });
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Cumulative share of registered voters across ${n} polling units, largest first` },
      [0, 0.25, 0.5, 0.75, 1].map((v) => [s('line', { x1: m.l, x2: W - m.r, y1: y(v), y2: y(v), class: v ? 'grid' : 'axis' }),
        s('text', { x: m.l - 8, y: y(v) + 4, 'text-anchor': 'end', class: 'tick' }, `${v * 100}%`)]),
      [0, 50, 100, 150, 200, n].filter((v, i, a) => a.indexOf(v) === i && v <= n).map((v) => s('text', { x: x(v), y: m.t + ih + 18, 'text-anchor': 'middle', class: 'tick' }, v)),
      s('text', { x: m.l + iw / 2, y: H - 6, 'text-anchor': 'middle', class: 'tick' }, 'Polling units, largest first'),
      s('path', { d: `${line}L${x(n)},${y(0)}L${x(0)},${y(0)}Z`, class: 'area' }),
      s('path', { d: line, class: 'line' }),
      marks.map(({ t, i }) => [
        s('line', { x1: x(i), x2: x(i), y1: y(t), y2: y(0), class: 'ref' }),
        s('circle', { cx: x(i), cy: y(t), r: 5, class: 'dot' }),
        s('text', { x: x(i) + 9, y: y(t) + 4, class: 'anno' }, `${i} units hold ${t * 100}%`)]),
    );
    const hair = s('line', { y1: m.t, y2: m.t + ih, class: 'hair', visibility: 'hidden' });
    const hdot = s('circle', { r: 5, class: 'dot', visibility: 'hidden' });
    svg.append(hair, hdot);
    const hit = s('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent', tabindex: '0' });
    svg.append(hit);
    let cur = marks[0].i; // keyboard focus starts at the 50% point
    hit.addEventListener('mousemove', (e) => {
      const b = svg.getBoundingClientRect();
      cur = Math.max(1, Math.min(n, Math.round(((e.clientX - b.left - m.l) / iw) * n)));
      for (const el of [hair, hdot]) el.setAttribute('visibility', 'visible');
      hair.setAttribute('x1', x(cur)); hair.setAttribute('x2', x(cur));
      hdot.setAttribute('cx', x(cur)); hdot.setAttribute('cy', y(pts[cur][1]));
    });
    hit.addEventListener('mouseleave', () => { for (const el of [hair, hdot]) el.setAttribute('visibility', 'hidden'); });
    // registered after the position update so the tooltip reads the current point
    tip(hit, () => {
      const u = ranked[cur - 1];
      return [`Top ${cur} polling units`, `${pct(pts[cur][1])} of all registered voters`, `#${cur}: ${u.name} (${fmt(u.registered)} · ${u.ward})`];
    });
    wrap.replaceChildren(svg);
  };
  requestAnimationFrame(draw);
  let t; const onResize = () => { clearTimeout(t); t = setTimeout(() => wrap.isConnected ? draw() : window.removeEventListener('resize', onResize), 150); };
  window.addEventListener('resize', onResize);
  return wrap;
}

function statTile(label, value, sub, hero) {
  return h('div', { class: 'tile' + (hero ? ' hero' : '') }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub && h('div', { class: 's' }, sub));
}

// ---------- the view ----------
function dashboardView(root) {
  const st = { contest: 'presidential', ward: '', q: '', sort: 'rank', dir: 1, showAll: false, data: null, act: [] };
  const filters = h('div', { class: 'filterbar' });
  const body = h('div', { class: 'dash' });
  const live = h('span', { class: 'muted small' });
  root.append(filters, body);

  async function load() {
    const [d, act] = await Promise.all([api('GET', '/api/admin/dashboard'), api('GET', '/api/admin/activity?limit=12')]);
    st.data = d; st.act = act.activity;
    live.textContent = 'Live · updated ' + new Date().toLocaleTimeString();
    paint();
  }

  function paintFilters() {
    const d = st.data;
    const wardSel = h('select', { 'aria-label': 'Ward', onchange: (e) => { st.ward = e.target.value; paint(); } },
      h('option', { value: '' }, `All wards (${d.lgas.join(', ')} LGA)`), d.wards.map((w) => h('option', { value: w }, w)));
    wardSel.value = st.ward;
    filters.replaceChildren(
      h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Contest' }, CONTESTS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(st.contest === k), onclick: () => { st.contest = k; paint(); } }, l))),
      h('div', { class: 'field sm' }, wardSel),
      h('div', { class: 'spacer' }), live,
      h('button', { class: 'btn ghost small', onclick: () => exportRanking() }, 'Export ranking (CSV)'),
      h('button', { class: 'btn ghost small', onclick: () => window.print() }, 'Print / PDF'),
      h('button', { class: 'btn small', onclick: () => document.body.classList.toggle('present') }, document.body.classList.contains('present') ? 'Exit presentation' : 'Present'));
  }

  function model() {
    const d = st.data;
    const allUnits = d.units;
    const lgaTotal = sumBy(allUnits, (u) => u.registered);
    // Rank across the whole LGA so a unit's rank and share never change with the ward filter.
    const ranked = [...allUnits].sort((a, b) => b.registered - a.registered || a.code.localeCompare(b.code));
    let cum = 0;
    ranked.forEach((u, i) => { u.rank = i + 1; u.share = u.registered / lgaTotal; cum += u.registered; u.cum = cum / lgaTotal; });
    const units = st.ward ? allUnits.filter((u) => u.ward === st.ward) : allUnits;
    const scopeTotal = sumBy(units, (u) => u.registered);
    return { d, allUnits, ranked, units, lgaTotal, scopeTotal, scopeRanked: ranked.filter((u) => !st.ward || u.ward === st.ward) };
  }

  function exportRanking() {
    const { scopeRanked } = model();
    const head = ['Rank', 'PU code', 'Polling unit', 'Ward', 'LGA', 'Registered voters', '% of LGA voters', 'Cumulative % (LGA)', 'Size class', '80/20 group'];
    const esc = (v) => { const x = String(v ?? ''); return /[",\n]/.test(x) ? `"${x.replace(/"/g, '""')}"` : x; };
    const lines = [head, ...scopeRanked.map((u) => [u.rank, u.code, u.name, u.ward, u.lga, u.registered, (u.share * 100).toFixed(2), (u.cum * 100).toFixed(2), u.reg_class, u.group80])].map((r) => r.map(esc).join(','));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }));
    const a = h('a', { href: url, download: `bende-polling-units-ranked${st.ward ? '-' + st.ward.replace(/\W+/g, '_') : ''}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  function paint() {
    paintFilters();
    const M = model();
    const { d, ranked, units, lgaTotal, scopeTotal, scopeRanked } = M;
    const scopeName = st.ward ? `${st.ward} ward` : `${d.lgas.join(', ')} LGA`;
    const largest = scopeRanked[0];
    const sizes = units.map((u) => u.registered).sort((a, b) => a - b);
    const median = sizes.length ? (sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : (sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2) : 0;
    const R = (u) => u.results[st.contest];
    const complete = units.filter((u) => R(u).status === 'Complete');
    const flagged = units.filter((u) => R(u).status === 'Check figures');

    const els = [
      h('div', { class: 'dash-title' }, h('h1', `${scopeName} · 2023 General Election`),
        h('p', { class: 'muted' }, `Abia State · ${d.lgas.join(', ')} LGA · ${d.wards.length} wards · ${d.units.length} polling units · showing ${CLABEL[st.contest]} results`)),

      // KPIs
      h('div', { class: 'grid tiles kpis' },
        statTile(`Registered voters · ${scopeName}`, fmt(scopeTotal), st.ward ? `${pct(share(scopeTotal, lgaTotal))} of the LGA's ${fmt(lgaTotal)}` : `${fmt(units.length)} polling units`, true),
        statTile('Polling units', fmt(units.length), st.ward ? `${pct(share(units.length, d.units.length))} of the LGA's ${d.units.length}` : `${d.wards.length} wards`),
        statTile('Average per polling unit', fmt(scopeTotal / Math.max(1, units.length)), `Median ${fmt(median)}`),
        largest && statTile('Largest polling unit', fmt(largest.registered), `${largest.name} · ${largest.ward} · ${pct(largest.share, 2)} of LGA voters`),
        statTile(`${CLABEL[st.contest]} results in`, `${complete.length} / ${units.length}`, `${pct(share(complete.length, units.length))} of units · ${pct(share(sumBy(complete, (u) => u.registered), scopeTotal))} of voters covered`),
        statTile('Flagged for review', fmt(flagged.length), 'Figures fail a consistency check')),

      registerSection(M),
      rankingSection(M),
      resultsSection(M),
      qualitySection(M),
      opsSection(),
    ];
    body.replaceChildren(...els.filter(Boolean));
  }

  // ----- 1. Where the voters are -----
  function registerSection({ d, ranked, units, lgaTotal, scopeTotal, scopeRanked }) {
    const top = scopeRanked.slice(0, 15);
    const topCard = card(`Top ${top.length} polling units by registered voters`, `Rank and share are of all ${fmt(lgaTotal)} voters in the LGA. Hover or tab through for detail.`,
      hbars(top.map((u) => ({
        label: `${u.rank}. ${u.name}`, sub: `${u.code} · ${u.ward} · ${u.lga} LGA`, value: u.registered,
        valueText: `${fmt(u.registered)} · ${pct(u.share, 2)}`,
        tipLines: [u.name, `${u.code} · ${u.ward} ward · ${u.lga} LGA`, `${fmt(u.registered)} registered · ${pct(u.share, 2)} of LGA voters`, `Rank ${u.rank} of ${ranked.length} · running total ${pct(u.cum)}`, `Size class ${u.reg_class} · ${u.group80}`],
      })), { max: ranked[0].registered }),
      tableView(['Rank', 'Polling unit', 'Ward', 'Registered', '% of LGA'], top.map((u) => [u.rank, u.name, u.ward, fmt(u.registered), pct(u.share, 2)]), 3));

    const half = ranked.findIndex((u) => u.cum >= 0.5) + 1, eighty = ranked.findIndex((u) => u.cum >= 0.8) + 1;
    const concCard = card('How concentrated are the voters?', `The ${half} largest polling units (${pct(half / ranked.length, 0)} of all units) hold half of the LGA's voters; ${eighty} units hold 80%.`,
      concentrationChart(ranked, lgaTotal),
      tableView(['Share of voters', 'Polling units needed', '% of all units'], [0.25, 0.5, 0.75, 0.8, 0.9, 1].map((t) => { const n = ranked.findIndex((u) => u.cum >= t - 1e-9) + 1; return [pct(t, 0), n, pct(n / ranked.length, 0)]; }), 1));

    const classColor = (c) => `var(--cls-${c.toLowerCase()})`;
    const classes = ['A', 'B', 'C', 'D'].map((c) => { const rows = units.filter((u) => u.reg_class === c); return { c, n: rows.length, v: sumBy(rows, (u) => u.registered) }; });
    const classCard = card('Polling units by size class', `Share of ${st.ward ? st.ward + ' ward' : 'LGA'} voters by unit size (registered voters per unit).`,
      segbar(classes.map((x) => ({ key: x.c, label: `Class ${x.c} (${CLASS_INFO[x.c]}): ${x.n} units`, short: x.c, value: x.v, color: classColor(x.c), ink: x.c === 'D' || x.c === 'C' ? 'var(--cls-ink-light)' : 'var(--cls-ink-dark)' })), { unit: ' voters' }),
      tableView(['Class', 'Registered per unit', 'Units', 'Voters', 'Share of voters'], classes.map((x) => [x.c, CLASS_INFO[x.c], x.n, fmt(x.v), pct(share(x.v, scopeTotal))]), 2));

    const wardRows = d.wards.map((w) => { const rows = d.units.filter((u) => u.ward === w); return { w, n: rows.length, v: sumBy(rows, (u) => u.registered) }; }).sort((a, b) => b.v - a.v);
    const wardCard = card('Voters by ward', 'Location context: each ward\'s share of LGA voters (tooltip adds its share of polling units).',
      hbars(wardRows.map((x) => ({
        label: x.w, sub: `${x.n} polling units`, value: x.v, valueText: `${fmt(x.v)} · ${pct(x.v / lgaTotal)}`,
        tipLines: [x.w, `${fmt(x.v)} voters · ${pct(x.v / lgaTotal)} of LGA`, `${x.n} polling units · ${pct(x.n / d.units.length)} of units`, `Average ${fmt(x.v / x.n)} voters per unit`],
      }))),
      tableView(['Ward', 'Units', '% of units', 'Voters', '% of voters'], wardRows.map((x) => [x.w, x.n, pct(x.n / d.units.length), fmt(x.v), pct(x.v / lgaTotal)]), 1));

    return section('Where the voters are', 'Registered voters by polling unit, using the 2023 register.',
      h('div', { class: 'two' }, topCard, h('div', concCard, classCard)), wardCard);
  }

  // ----- 2. Full ranking -----
  function rankingSection({ scopeRanked, ranked }) {
    const cols = [
      ['rank', 'Rank', true], ['code', 'PU code'], ['name', 'Polling unit'], ['ward', 'Ward'], ['lga', 'LGA'],
      ['registered', 'Registered', true], ['share', '% of LGA voters', true], ['cum', 'Cumulative %', true], ['reg_class', 'Class'],
      ['status', `${CLABEL[st.contest]} status`], ['turnout', 'Turnout', true],
    ];
    const val = (u, k) => (k === 'status' ? u.results[st.contest].status : k === 'turnout' ? u.results[st.contest].turnout ?? -1 : u[k]);
    const q = st.q.trim().toLowerCase();
    let rows = scopeRanked.filter((u) => !q || `${u.code} ${u.name} ${u.ward}`.toLowerCase().includes(q));
    rows = [...rows].sort((a, b) => { const x = val(a, st.sort), y = val(b, st.sort); return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y))) * st.dir; });
    const shown = st.showAll ? rows : rows.slice(0, 25);
    const search = h('input', { type: 'search', placeholder: 'Search polling unit, code or ward…', value: st.q, oninput: (e) => { st.q = e.target.value; const c = e.target.selectionStart; paint(); const n = document.querySelector('.rank-search'); if (n) { n.focus(); n.setSelectionRange(c, c); } }, class: 'rank-search' });
    const th = ([k, l, num]) => h('th', { class: (num ? 'num ' : '') + 'sortable', 'aria-sort': st.sort === k ? (st.dir > 0 ? 'ascending' : 'descending') : 'none', tabindex: '0',
      onclick: () => { if (st.sort === k) st.dir *= -1; else { st.sort = k; st.dir = ['registered', 'share', 'turnout'].includes(k) ? -1 : 1; } paint(); },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.click(); } }, l, st.sort === k ? (st.dir > 0 ? ' ▲' : ' ▼') : '');
    return section('All polling units, ranked', `Ranked by registered voters across the whole LGA (${ranked.length} units). Click a column to sort.`,
      h('div', { class: 'card' },
        h('div', { class: 'row', style: 'align-items:center;margin-bottom:10px' }, h('div', { class: 'field' }, search), h('span', { class: 'muted small' }, `${rows.length} units`)),
        h('div', { class: 'tablewrap' }, h('table', { class: 'ranktable' }, h('thead', h('tr', cols.map(th))),
          h('tbody', shown.map((u) => { const r = u.results[st.contest]; return h('tr', { class: 'click', onclick: () => adminEdit(st.contest, u.code, load) },
            h('td', { class: 'num' }, u.rank), h('td', { class: 'nowrap small' }, u.code), h('td', u.name), h('td', u.ward), h('td', u.lga),
            h('td', { class: 'num' }, fmt(u.registered)),
            h('td', { class: 'num' }, h('span', { class: 'sharecell' }, h('i', { style: `width:${Math.min(100, (u.share / ranked[0].share) * 100)}%` })), pct(u.share, 2)),
            h('td', { class: 'num' }, pct(u.cum)), h('td', u.reg_class), h('td', chip(r.status)), h('td', { class: 'num' }, pct(r.turnout))); })))),
        rows.length > 25 && h('div', { style: 'margin-top:10px' }, h('button', { class: 'btn ghost small', onclick: () => { st.showAll = !st.showAll; paint(); } }, st.showAll ? 'Show top 25' : `Show all ${rows.length}`))));
  }

  // ----- 3. Results -----
  function resultsSection({ d, units, scopeTotal }) {
    const C = st.contest, R = (u) => u.results[C];
    const done = units.filter((u) => R(u).status === 'Complete');
    const party = PARTIES.map(([k, l], i) => ({ key: k, label: l, value: sumBy(done, (u) => R(u)[k]), color: `var(--series-${i + 1})` }));
    const partyTotal = sumBy(party, (p) => p.value);
    const votes = sumBy(done, (u) => R(u).total);
    const regCovered = sumBy(done, (u) => u.registered);
    const lead = [...party].sort((a, b) => b.value - a.value);

    const shareCard = card(`${CLABEL[C]} · party share`, done.length ? `From ${done.length} complete polling-unit results (${pct(share(regCovered, scopeTotal))} of voters in scope). Incomplete or flagged results are excluded.` : 'No complete results yet.',
      done.length ? segbar(party.map((p) => ({ ...p, label: `${p.label} · ${fmt(p.value)} votes` , short: p.label })), { unit: ' votes' }) : null,
      h('div', { class: 'grid tiles mini' },
        party.map((p) => statTile(p.label, done.length ? fmt(p.value) : '—', done.length ? `${pct(share(p.value, partyTotal))} of party votes` : '')),
        statTile('Votes cast', done.length ? fmt(votes) : '—', done.length ? `Turnout ${pct(share(votes, regCovered))} in reporting units` : ''),
        statTile('Leading', done.length ? lead[0].label : '—', done.length ? `by ${fmt(lead[0].value - lead[1].value)} votes` : '')));

    const wardRows = d.wards.filter((w) => !st.ward || w === st.ward).map((w) => {
      const all = units.filter((u) => u.ward === w), dn = all.filter((u) => R(u).status === 'Complete');
      const v = Object.fromEntries(PARTIES.map(([k]) => [k, sumBy(dn, (u) => R(u)[k])]));
      const tv = sumBy(dn, (u) => R(u).total), reg = sumBy(dn, (u) => u.registered);
      const leadP = PARTIES.map(([k, l]) => [l, v[k]]).sort((a, b) => b[1] - a[1]);
      return { w, n: all.length, dn: dn.length, v, tv, turnout: share(tv, reg), lead: dn.length ? leadP[0][0] : '—', margin: dn.length ? leadP[0][1] - leadP[1][1] : null };
    });
    const thin = (v) => { const t = sumBy(PARTIES, ([k]) => v[k]); return t ? h('div', { class: 'thinbar' }, PARTIES.map(([k, l], i) => v[k] ? tip(h('span', { style: `flex:${v[k]} 1 0;background:var(--series-${i + 1})`, tabindex: '0' }), () => [l, `${fmt(v[k])} · ${pct(v[k] / t)}`]) : null)) : h('span', { class: 'muted small' }, 'no complete results'); };
    const wardCard = card('Results by ward', 'Complete results only. The bar shows each ward\'s PDP / APC / LP split.',
      h('div', { class: 'legend' }, PARTIES.map(([, l], i) => h('span', h('i', { style: `background:var(--series-${i + 1})` }), l))),
      h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Ward', 'Reporting', 'PDP', 'APC', 'LP', 'Split', 'Leading', 'Margin', 'Turnout'].map((x, i) => h('th', { class: [1, 2, 3, 4, 7, 8].includes(i) ? 'num' : '' }, x)))),
        h('tbody', wardRows.map((r) => h('tr', h('td', r.w), h('td', { class: 'num' }, `${r.dn}/${r.n}`), PARTIES.map(([k]) => h('td', { class: 'num' }, r.dn ? fmt(r.v[k]) : '—')),
          h('td', { style: 'min-width:120px' }, thin(r.v)), h('td', r.lead), h('td', { class: 'num' }, r.margin === null ? '—' : fmt(r.margin)), h('td', { class: 'num' }, pct(r.turnout))))))));

    const byVotes = [...done].sort((a, b) => R(b).total - R(a).total).slice(0, 10);
    const byTurnout = [...done].sort((a, b) => R(b).turnout - R(a).turnout).slice(0, 10);
    const leader = (u) => PARTIES.map(([k, l]) => [l, R(u)[k]]).sort((a, b) => b[1] - a[1])[0][0];
    const topTable = (rows, valHead, val) => h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['#', 'Polling unit', 'Ward', valHead, 'Leading'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
      h('tbody', rows.length ? rows.map((u, i) => h('tr', { class: 'click', onclick: () => adminEdit(C, u.code, load) }, h('td', i + 1), h('td', u.name), h('td', { class: 'small' }, u.ward), h('td', { class: 'num' }, val(u)), h('td', leader(u)))) : h('tr', h('td', { colspan: 5, class: 'muted' }, 'No complete results yet.')))));

    const glance = card('All contests at a glance', st.ward ? `${st.ward} ward` : 'Whole LGA',
      h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Contest', 'Complete', 'Coverage', 'PDP', 'APC', 'LP', 'Votes cast', 'Turnout', 'Flagged'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
        h('tbody', CONTESTS.map(([k, l]) => { const dn = units.filter((u) => u.results[k].status === 'Complete'); const reg = sumBy(dn, (u) => u.registered); const tv = sumBy(dn, (u) => u.results[k].total);
          return h('tr', { class: k === C ? 'current' : '' }, h('td', h('b', l)), h('td', { class: 'num' }, `${dn.length}/${units.length}`), h('td', { class: 'num' }, pct(share(dn.length, units.length))),
            PARTIES.map(([p]) => h('td', { class: 'num' }, dn.length ? fmt(sumBy(dn, (u) => u.results[k][p])) : '—')), h('td', { class: 'num' }, dn.length ? fmt(tv) : '—'), h('td', { class: 'num' }, pct(share(tv, reg))),
            h('td', { class: 'num' }, units.filter((u) => u.results[k].status === 'Check figures').length)); })))));

    return section(`Results · ${CLABEL[C]}`, 'Totals, shares and turnout use complete results only (all six figures present and passing the checks).',
      shareCard, wardCard,
      h('div', { class: 'two' }, card('Top 10 polling units by votes cast', null, topTable(byVotes, 'Votes cast', (u) => fmt(R(u).total))),
        card('Top 10 polling units by turnout', 'Turnout = votes cast ÷ registered voters.', topTable(byTurnout, 'Turnout', (u) => pct(R(u).turnout)))),
      glance);
  }

  // ----- 4. Data quality -----
  function qualitySection({ units, ranked }) {
    const C = st.contest, R = (u) => u.results[C];
    const STAT = [['Complete', 'var(--st-good)', '✓'], ['Check figures', 'var(--st-critical)', '!'], ['Incomplete', 'var(--st-warning)', '…'], ['Missing', 'var(--st-none)', '–']];
    const counts = STAT.map(([s0, c, icon]) => ({ s0, c, icon, n: units.filter((u) => R(u).status === s0).length }));
    const statusCard = card(`${CLABEL[C]} · result status`, `${units.length} polling units in scope.`,
      h('div', { class: 'thinbar tall' }, counts.map((x) => x.n ? tip(h('span', { style: `flex:${x.n} 1 0;background:${x.c}`, tabindex: '0' }), () => [x.s0, `${x.n} units · ${pct(x.n / units.length)}`]) : null)),
      h('div', { class: 'statuslist' }, counts.map((x) => h('div', h('span', { class: 'chip ' + statusClass(x.s0) }, `${x.icon} ${x.s0}`), h('b', x.n), h('span', { class: 'muted small' }, pct(x.n / units.length))))));

    const qmap = {};
    for (const u of units) { const q0 = R(u).quality || 'Not recorded'; qmap[q0] = (qmap[q0] || 0) + 1; }
    const qrows = Object.entries(qmap).sort((a, b) => b[1] - a[1]);
    const qualCard = card(`${CLABEL[C]} · result-sheet quality`, 'As recorded by agents (or imported from the workbook notes).',
      hbars(qrows.map(([k, n]) => ({ label: k, value: n, valueText: `${n} · ${pct(n / units.length, 0)}`, tipLines: [k, `${n} polling units`] }))),
      tableView(['Sheet quality', 'Units', 'Share'], qrows.map(([k, n]) => [k, n, pct(n / units.length)]), 1));

    const small = ranked.filter((u) => u.registered < SMALL_REGISTER && (!st.ward || u.ward === st.ward)).sort((a, b) => a.registered - b.registered);
    const regCard = card('Register checks', `Polling units with fewer than ${SMALL_REGISTER} registered voters. Worth confirming against the official register.`,
      small.length ? h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['PU code', 'Polling unit', 'Ward', 'Registered'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
        h('tbody', small.map((u) => h('tr', h('td', { class: 'small nowrap' }, u.code), h('td', u.name), h('td', u.ward), h('td', { class: 'num' }, fmt(u.registered))))))) : h('p', { class: 'muted' }, 'None in scope.'));

    const flagged = units.filter((u) => R(u).status === 'Check figures');
    const why = (r, reg) => [r.pdp + r.apc + r.lp > r.valid && 'party votes > valid', r.valid + r.rejected > r.accredited && 'votes cast > accredited', r.accredited > reg && 'accredited > register'].filter(Boolean).join('; ');
    const flagCard = card(`Results needing review (${flagged.length})`, 'Click a row to open and correct the figures.',
      flagged.length ? h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['PU code', 'Polling unit', 'Ward', 'Problem', 'Sheet'].map((x) => h('th', x)))),
        h('tbody', flagged.map((u) => h('tr', { class: 'click', onclick: () => adminEdit(C, u.code, load) }, h('td', { class: 'small nowrap' }, u.code), h('td', u.name), h('td', u.ward), h('td', { class: 'small' }, why(R(u), u.registered)), h('td', { class: 'small muted' }, R(u).quality || '')))))) : h('p', { class: 'muted' }, 'Nothing flagged.'));

    return section('Data quality', 'How much of the data can be trusted, and what needs checking.',
      h('div', { class: 'two' }, statusCard, qualCard), h('div', { class: 'two' }, flagCard, regCard));
  }

  // ----- 5. Operations (hidden in presentation mode) -----
  function opsSection() {
    const d = st.data;
    return h('div', { class: 'ops' }, section('Operations', 'Data-entry progress and recent activity.',
      h('div', { class: 'two' },
        card('Agent progress', `${d.totals.assigned}/${d.totals.pus} polling units assigned · ${d.totals.agents} active agents`,
          d.agents.length ? h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['Agent', 'Units', 'Pres.', 'Sen.', 'House', 'Flags', 'Last entry'].map((x, i) => h('th', { class: i && i < 6 ? 'num' : '' }, x)))),
            h('tbody', d.agents.map((a) => h('tr', h('td', a.full_name, !a.active && h('span', { class: 'chip idle', style: 'margin-left:6px' }, 'inactive')), h('td', { class: 'num' }, a.assigned),
              ['presidential', 'senate', 'reps'].map((k) => h('td', { class: 'num' }, `${a.progress[k]}/${a.assigned}`)), h('td', { class: 'num' }, a.flagged ? h('span', { class: 'chip bad' }, a.flagged) : '0'), h('td', { class: 'small muted nowrap' }, ts(a.last_entry) || '—')))))) : h('p', { class: 'muted' }, 'No data entry agents yet.')),
        card('Latest activity', null, activityTable(st.act)))));
  }

  load().catch((e) => toast(e.message, true));
  timers.push(setInterval(() => {
    if (document.querySelector('.overlay') || root.contains(document.activeElement) && document.activeElement.matches('input,select')) return;
    load().catch(() => {});
  }, 30000));
}
