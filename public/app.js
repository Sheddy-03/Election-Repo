'use strict';
/* Bende 2023 Results Portal — vanilla JS SPA. All dynamic text is set via textContent (no innerHTML). */

const CONTESTS = [['presidential', 'Presidential'], ['senate', 'Senate'], ['reps', 'House of Reps']];
const CLABEL = Object.fromEntries(CONTESTS);
const FIELDS = [['pdp', 'PDP', 'p-pdp'], ['apc', 'APC', 'p-apc'], ['lp', 'LP', 'p-lp'], ['accredited', 'Accredited'], ['valid', 'Valid'], ['rejected', 'Rejected']];

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v === null || v === undefined) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const $app = document.getElementById('app');
const nf = new Intl.NumberFormat('en-NG');
const fmt = (n) => (n === null || n === undefined ? '—' : nf.format(Math.round(n)));
const fmt1 = (n) => (n === null || n === undefined ? '—' : nf.format(Math.round(n * 10) / 10));
const pct = (n, d = 1) => (n === null || n === undefined ? '—' : (n * 100).toFixed(d) + '%');
const ts = (s) => (s ? s.replace('T', ' ').slice(0, 16) : '');
const statusClass = (s) => (s === 'Check figures' ? 'Check' : s);
const chip = (s) => h('span', { class: 'chip ' + statusClass(s) }, s);

let toastTimer;
function toast(msg, err) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.className = ''), 3200);
}

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && me) { me = null; render(); }
    const e = new Error(data.error || 'Request failed'); e.status = res.status; e.data = data; throw e;
  }
  return data;
}

function modal(title, content, { onClose } = {}) {
  const close = () => { ov.remove(); onClose && onClose(); };
  const ov = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === ov) close(); } },
    h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'head' }, h('h2', title), h('button', { class: 'btn ghost small', onclick: close, type: 'button' }, 'Close')), content));
  document.body.append(ov);
  return { close };
}

const logoSvg = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke-width', '3'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', 'M5 12.5l4.5 4.5L19 7'); s.append(p); return s; };

// ---------- session ----------
let me = null;
let booted = false;

async function boot() {
  try { me = await api('GET', '/api/me'); } catch { me = null; }
  booted = true; render();
}

function render() {
  stopTimers();
  $app.replaceChildren();
  if (!me) return $app.append(loginView());
  if (me.must_change_password) return $app.append(changePasswordView(true));
  $app.append(shell());
}

async function logout() { try { await api('POST', '/api/logout', {}); } catch { /* ignore */ } me = null; render(); }

// ---------- login & password ----------
function loginView() {
  const err = h('div', { class: 'notice bad', hidden: true });
  const u = h('input', { id: 'u', autocomplete: 'username', required: true, autofocus: true });
  const p = h('input', { id: 'p', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'btn', type: 'submit', style: 'width:100%;justify-content:center' }, 'Sign in');
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); btn.disabled = true; err.hidden = true;
      try { me = await api('POST', '/api/login', { username: u.value, password: p.value }); render(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; p.value = ''; p.focus(); }
    },
  }, h('div', { class: 'field' }, h('label', { for: 'u' }, 'Username'), u), h('div', { class: 'field', style: 'margin-top:12px' }, h('label', { for: 'p' }, 'Password'), p), err,
  h('div', { style: 'margin-top:16px' }, btn));
  return h('div', { class: 'login' }, h('div', { class: 'card' }, h('div', { class: 'logo' }, logoSvg()), h('h1', { style: 'font-size:22px' }, 'Bende 2023 Results Portal'),
    h('p', { class: 'muted small', style: 'margin:4px 0 18px' }, 'Sign in with the account issued to you by the administrator.'), form));
}

function changePasswordView(forced) {
  const err = h('div', { class: 'notice bad', hidden: true });
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const n1 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const n2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.hidden = true;
      if (n1.value !== n2.value) { err.textContent = 'New passwords do not match.'; err.hidden = false; return; }
      try { await api('POST', '/api/me/password', { current: cur.value, next: n1.value }); me.must_change_password = false; toast('Password updated.'); forced ? render() : box.close(); }
      catch (ex) { err.textContent = ex.message; err.hidden = false; }
    },
  }, h('div', { class: 'field' }, h('label', forced ? 'Temporary password' : 'Current password'), cur),
  h('div', { class: 'field', style: 'margin-top:10px' }, h('label', 'New password (min. 8 characters)'), n1),
  h('div', { class: 'field', style: 'margin-top:10px' }, h('label', 'Confirm new password'), n2), err,
  h('div', { class: 'row', style: 'margin-top:14px' }, h('button', { class: 'btn', type: 'submit' }, 'Update password'), forced && h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'Sign out')));
  if (forced) return h('div', { class: 'login' }, h('div', { class: 'card' }, h('h1', { style: 'font-size:20px' }, 'Set a new password'), h('p', { class: 'muted small' }, 'Your account uses a temporary password. Choose your own to continue.'), form));
  const box = modal('Change password', form);
  return null;
}

// ---------- shell ----------
let tab = 'dashboard';
let timers = [];
const stopTimers = () => { timers.forEach(clearInterval); timers = []; };

function shell() {
  const isAdmin = me.role === 'admin';
  const tabs = isAdmin ? [['dashboard', 'Dashboard'], ['agents', 'Agents & assignments'], ['units', 'Polling units'], ['results', 'Results'], ['activity', 'Activity log']] : [];
  const content = h('main');
  const nav = isAdmin && h('div', { class: 'tabs', role: 'tablist' }, tabs.map(([k, l]) => h('button', {
    role: 'tab', 'aria-selected': String(tab === k),
    onclick: () => { tab = k; stopTimers(); [...nav.children].forEach((b, i) => b.setAttribute('aria-selected', String(tabs[i][0] === k))); show(); },
  }, l)));
  function show() {
    content.replaceChildren();
    if (!isAdmin) return content.append(agentHome());
    ({ dashboard: dashboardView, agents: agentsView, units: unitsView, results: resultsView, activity: activityView })[tab](content);
  }
  const top = h('div', { class: 'topbar' }, h('div', { class: 'in' },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, logoSvg()), h('div', 'Bende 2023 Results ', h('span', { class: 'muted small' }, isAdmin ? '· Admin centre' : '· Data entry'))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'who' }, h('div', me.full_name), h('div', me.role === 'admin' ? 'Administrator' : 'Data entry agent')),
    h('button', { class: 'btn ghost small', onclick: () => changePasswordView(false) }, 'Password'),
    h('button', { class: 'btn ghost small', onclick: logout }, 'Sign out')), nav || null);
  show();
  return h('div', top, content);
}

// ---------- entry form (shared by agent + admin override) ----------
function explain(v, registered) {
  const issues = [];
  const n = (x) => x !== null && x !== undefined;
  if (n(v.pdp) && n(v.apc) && n(v.lp) && n(v.valid) && v.pdp + v.apc + v.lp > v.valid) issues.push(`Party votes (${v.pdp + v.apc + v.lp}) are more than Valid votes (${v.valid}).`);
  if (n(v.valid) && n(v.rejected) && n(v.accredited) && v.valid + v.rejected > v.accredited) issues.push(`Valid + Rejected (${v.valid + v.rejected}) is more than Accredited (${v.accredited}).`);
  if (n(v.accredited) && v.accredited > registered) issues.push(`Accredited (${v.accredited}) is more than the register (${registered}).`);
  return issues;
}
function statusOf(v, registered) {
  const vals = ['pdp', 'apc', 'lp', 'accredited', 'valid', 'rejected'].map((f) => v[f]);
  const present = vals.filter((x) => x !== null).length;
  if (!present) return 'Missing';
  if (present < 6) return 'Incomplete';
  return explain(v, registered).length ? 'Check figures' : 'Complete';
}

function entryForm({ registered, data, onSave, canClear }) {
  const inputs = {};
  const calc = h('div', { class: 'calc' });
  const issues = h('div');
  const notes = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Optional — record any exception (e.g. result sheet damaged, figures unclear)' }, data.notes || '');
  const read = () => Object.fromEntries(FIELDS.map(([f]) => { const raw = inputs[f].value.trim(); return [f, raw === '' ? null : Number(raw)]; }));
  const valid = (v) => Object.values(v).every((x) => x === null || (Number.isInteger(x) && x >= 0));
  function refresh() {
    const v = read();
    const ok = valid(v);
    const st = ok ? statusOf(v, registered) : 'Check figures';
    const total = v.valid !== null && v.rejected !== null ? v.valid + v.rejected : null;
    calc.replaceChildren(
      h('div', h('div', { class: 'muted small' }, 'Total votes (Valid + Rejected)'), h('b', total === null ? '—' : fmt(total))),
      h('div', h('div', { class: 'muted small' }, 'Turnout'), h('b', st === 'Complete' && registered ? pct(total / registered, 2) : '—')),
      h('div', h('div', { class: 'muted small' }, 'Registered voters'), h('b', fmt(registered))),
      h('div', h('div', { class: 'muted small' }, 'Status'), chip(st)));
    issues.replaceChildren(...(ok ? explain(v, registered) : ['Use whole numbers of 0 or more.']).map((m) => h('div', { class: 'notice bad' }, m)));
    save.disabled = !ok;
  }
  const grid = h('div', { class: 'grid entry' }, FIELDS.map(([f, label, cls]) => {
    inputs[f] = h('input', { id: 'f-' + f, inputmode: 'numeric', pattern: '[0-9]*', autocomplete: 'off', value: data[f] ?? '', oninput: refresh });
    return h('div', { class: 'field ' + (cls || '') }, h('label', { for: 'f-' + f }, label), inputs[f]);
  }));
  const save = h('button', { class: 'btn', type: 'button', onclick: async () => {
    save.disabled = true;
    try { await onSave({ ...read(), notes: notes.value }); } catch (e) { toast(e.message, true); } finally { save.disabled = false; refresh(); }
  } }, 'Save result');
  const root = h('div', grid, calc, issues,
    h('div', { class: 'field' }, h('label', 'Source / notes'), notes),
    h('p', { class: 'muted small' }, 'Enter figures exactly as written on the result sheet. Type 0 for a confirmed zero; leave a box empty only if the figure is unknown. A result counts as Complete once all six figures pass the checks.'),
    h('div', { class: 'row' }, save, canClear && h('button', { class: 'btn ghost', type: 'button', onclick: () => { for (const f of Object.keys(inputs)) inputs[f].value = ''; notes.value = ''; refresh(); } }, 'Clear fields')));
  refresh();
  return root;
}

function contestTabs(unitCode, fetchData, putData, { onAfter } = {}) {
  let current = 'presidential';
  let datas = null;
  const body = h('div');
  const seg = h('div', { class: 'seg', role: 'tablist' });
  async function load() { datas = (await fetchData()); paint(); }
  function paint() {
    seg.replaceChildren(...CONTESTS.map(([k, l]) => h('button', { role: 'tab', 'aria-selected': String(current === k), onclick: () => { current = k; paint(); } }, l, chip(datas.contests[k].status))));
    body.replaceChildren(entryForm({
      registered: datas.unit.registered, data: datas.contests[current], canClear: true,
      onSave: async (payload) => {
        const r = await putData(current, payload);
        toast(`${CLABEL[current]} saved — ${r.status}`, r.status === 'Check figures');
        datas = await fetchData(); paint(); onAfter && onAfter();
      },
    }));
  }
  const root = h('div', seg, body);
  load().catch((e) => root.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  return root;
}

// ---------- agent ----------
function agentHome() {
  const root = h('div', h('p', { class: 'muted' }, 'Loading your polling units…'));
  async function load() {
    const { units } = await api('GET', '/api/my/units');
    const total = units.length * 3;
    const done = units.reduce((n, u) => n + Object.values(u.status).filter((s) => s === 'Complete').length, 0);
    root.replaceChildren(
      h('div', { class: 'head' }, h('h2', 'My polling units'), h('span', { class: 'muted' }, `${units.length} assigned`)),
      units.length ? h('div', { class: 'card' }, h('div', { class: 'row', style: 'align-items:center' }, h('div', { class: 'field' }, h('div', { class: 'small muted' }, 'Progress across Presidential, Senate and House of Reps'), h('div', { class: 'bar ok', style: 'margin-top:6px' }, h('i', { style: `width:${total ? (done / total) * 100 : 0}%` }))), h('b', `${done} / ${total} complete`))) : null,
      units.length ? h('div', { class: 'grid unitgrid' }, units.map((u) => h('button', { class: 'unit', onclick: () => openUnit(u, load) },
        h('div', { class: 'code' }, u.code + ' · ' + u.ward), h('div', { class: 'nm' }, u.name),
        h('div', { class: 'chips' }, CONTESTS.map(([k, l]) => h('span', { class: 'chip ' + statusClass(u.status[k]) }, l.replace('House of Reps', 'Reps') + ': ' + u.status[k])))))) :
        h('div', { class: 'card' }, 'No polling units have been assigned to your account yet. Please contact the administrator.'));
  }
  load().catch((e) => root.replaceChildren(h('div', { class: 'notice bad' }, e.message)));
  return root;
}

function openUnit(u, refresh) {
  const c = contestTabs(u.code, () => api('GET', `/api/my/units/${u.code}`), (k, payload) => api('PUT', `/api/my/units/${u.code}/${k}`, payload));
  modal(u.name, h('div', h('p', { class: 'muted small' }, `${u.code} · ${u.ward} · ${fmt(u.registered)} registered voters`), c), { onClose: refresh });
}

// ---------- admin: dashboard ----------
function dashboardView(root) {
  let ward = '';
  const body = h('div');
  const sel = h('select', { onchange: () => { ward = sel.value; load(); } }, h('option', { value: '' }, 'All wards'));
  const live = h('span', { class: 'muted small' });
  root.append(h('div', { class: 'head' }, h('h2', 'Election dashboard'), h('div', { class: 'spacer' }), live,
    h('div', { class: 'field sm' }, sel), CONTESTS.map(([k, l]) => h('a', { class: 'btn ghost small', href: `/api/admin/export/${k}.csv` }, 'CSV · ' + l.replace('House of ', '')))), body);

  async function load() {
    const [d, act] = await Promise.all([api('GET', '/api/admin/dashboard' + (ward ? '?ward=' + encodeURIComponent(ward) : '')), api('GET', '/api/admin/activity?limit=12')]);
    if (sel.options.length === 1) d.wards.forEach((w) => sel.append(h('option', { value: w }, w)));
    sel.value = d.ward || '';
    live.textContent = 'Live · updated ' + new Date().toLocaleTimeString();
    const T = d.totals;
    const tile = (k, v, s) => h('div', { class: 'tile' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), s && h('div', { class: 's' }, s));
    const partyBar = (c) => {
      const t = c.pdp + c.apc + c.lp;
      return h('div', c.complete ? [h('div', { class: 'partybar' }, [['pdp', c.pdp], ['apc', c.apc], ['lp', c.lp]].map(([p, v]) => h('span', { style: `width:${t ? (v / t) * 100 : 0}%;background:var(--${p})`, title: `${p.toUpperCase()} ${fmt(v)}` })))] : h('div', { class: 'partybar' }));
    };
    body.replaceChildren(...[
      h('div', { class: 'grid tiles' },
        tile('Registered voters', fmt(T.registered), `${T.pus} polling units`),
        tile('Units assigned', `${T.assigned} / ${T.pus}`, T.unassigned ? `${T.unassigned} still unassigned` : 'All units covered'),
        tile('Active agents', fmt(T.agents)),
        tile('Presidential coverage', pct(d.contests[0].coverage), `${d.contests[0].complete} of ${d.contests[0].expected} units`),
        tile('Flagged for review', fmt(d.flaggedCount), 'Check-figures results')),
      h('div', { class: 'card' }, h('h2', 'Contest summary' + (d.ward ? ' · ' + d.ward : ' · all wards')),
        h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Contest', 'Expected PUs', 'Complete', 'Coverage', 'PDP', 'APC', 'LP', 'PDP avg/PU', 'APC avg/PU', 'LP avg/PU', 'Total votes', 'Accredited', 'Avg PU turnout'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', d.contests.map((c) => h('tr', h('td', h('b', c.label)), [c.expected, c.complete].map((x) => h('td', { class: 'num' }, fmt(x))),
            h('td', { class: 'num' }, h('div', { class: 'bar ok' }, h('i', { style: `width:${c.coverage * 100}%` })), h('span', { class: 'small' }, pct(c.coverage))),
            [c.pdp, c.apc, c.lp].map((x) => h('td', { class: 'num' }, c.complete ? fmt(x) : '—')),
            [c.pdpAvg, c.apcAvg, c.lpAvg].map((x) => h('td', { class: 'num' }, fmt1(x))),
            h('td', { class: 'num' }, c.complete ? fmt(c.totalVotes) : '—'), h('td', { class: 'num' }, c.complete ? fmt(c.accredited) : '—'), h('td', { class: 'num' }, pct(c.avgTurnout)))))),
        ), h('div', { class: 'two', style: 'margin-top:14px' }, d.contests.map((c) => h('div', h('div', { class: 'small' }, h('b', c.label), h('span', { class: 'muted' }, ` · ${c.incomplete} incomplete · ${c.check} to check · ${c.missing} missing`)), partyBar(c)))),
        h('div', { class: 'legend' }, [['pdp', 'PDP'], ['apc', 'APC'], ['lp', 'LP']].map(([p, l]) => h('span', h('i', { style: `background:var(--${p})` }), l))),
        h('p', { class: 'muted small', style: 'margin-bottom:0' }, 'Totals and averages use Complete results only (all six figures present and passing the checks). Turnout = (valid + rejected) ÷ registered.')),

      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('h2', 'Progress by ward'), h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['Ward', 'Registered', 'PUs', 'Assigned', 'Pres.', 'Sen.', 'House'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', d.wardTable.map((w) => h('tr', { class: 'click', onclick: () => { ward = w.ward; load(); } }, h('td', w.ward), h('td', { class: 'num' }, fmt(w.registered)), h('td', { class: 'num' }, w.pus), h('td', { class: 'num' }, `${w.assigned}/${w.pus}`),
            ['presidential', 'senate', 'reps'].map((k) => h('td', { class: 'num' }, `${w[k]}/${w.pus}`))))))),
          h('p', { class: 'muted small' }, 'Click a ward to filter the dashboard.')),
        h('div', { class: 'card' }, h('h2', 'Agent progress'), d.agents.length ? h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['Agent', 'Units', 'Pres.', 'Sen.', 'House', 'Flags', 'Last entry'].map((x, i) => h('th', { class: i && i < 6 ? 'num' : '' }, x)))),
          h('tbody', d.agents.map((a) => h('tr', h('td', a.full_name, !a.active && h('span', { class: 'chip idle', style: 'margin-left:6px' }, 'inactive')), h('td', { class: 'num' }, a.assigned),
            ['presidential', 'senate', 'reps'].map((k) => h('td', { class: 'num' }, `${a.progress[k]}/${a.assigned}`)), h('td', { class: 'num' }, a.flagged ? h('span', { class: 'chip bad' }, a.flagged) : '0'), h('td', { class: 'small muted nowrap' }, ts(a.last_entry) || '—')))))) : h('p', { class: 'muted' }, 'No data entry agents yet. Create them under Agents & assignments.')),
      ),

      h('div', { class: 'two' },
        h('div', { class: 'card' }, h('h2', 'Registration profile' + (d.ward ? ' · ' + d.ward : '')), h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Class', 'PUs', 'Registered', 'Share', '80Grp', '20grp'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
          h('tbody', d.profile.classes.map((c) => { const tot = d.profile.classes.reduce((a, b) => a + b.registered, 0); return h('tr', h('td', c.cls), h('td', { class: 'num' }, c.pus), h('td', { class: 'num' }, fmt(c.registered)), h('td', { class: 'num' }, pct(tot ? c.registered / tot : null)), h('td', { class: 'num' }, c.g80), h('td', { class: 'num' }, c.g20)); }),
            d.profile.groups.map((g) => h('tr', h('td', h('b', g.group)), h('td', { class: 'num' }, g.pus), h('td', { class: 'num' }, fmt(g.registered)), h('td'), h('td'), h('td')))))),
          h('p', { class: 'muted small', style: 'margin-bottom:0' }, 'A ≥ 769 · B 525–768 · C 280–524 · D 0–279 registered voters per polling unit. 80Grp = the largest units needed to reach 80% of the register.')),
        h('div', { class: 'card' }, h('h2', 'Results by registration group'), h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Contest', 'Group', 'Complete', 'Coverage', 'PDP', 'APC', 'LP', 'Turnout'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
          h('tbody', d.byGroup.map((g) => h('tr', h('td', g.contest), h('td', g.group), h('td', { class: 'num' }, `${g.complete}/${g.expected}`), h('td', { class: 'num' }, pct(g.coverage, 0)),
            [g.pdp, g.apc, g.lp].map((x) => h('td', { class: 'num' }, g.complete ? fmt(x) : '—')), h('td', { class: 'num' }, pct(g.turnout)))))))),
      ),

      d.flaggedCount ? h('div', { class: 'card' }, h('h2', `Results needing review (${d.flaggedCount})`), h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['Contest', 'PU code', 'Polling unit', 'Ward'].map((x) => h('th', x)))),
        h('tbody', d.flagged.map((f) => h('tr', { class: 'click', onclick: () => adminEdit(f.contest, f.code, load) }, h('td', f.contestLabel), h('td', f.code), h('td', f.name), h('td', f.ward)))))), h('p', { class: 'muted small', style: 'margin-bottom:0' }, 'Click a row to review and correct the figures.')) : null,

      h('div', { class: 'card' }, h('h2', 'Latest activity'), activityTable(act.activity))].filter(Boolean));
  }
  load().catch((e) => toast(e.message, true));
  timers.push(setInterval(() => load().catch(() => {}), 15000));
}

function activityTable(rows) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing recorded yet.');
  return h('div', { class: 'tablewrap scroll' }, h('table', h('thead', h('tr', ['Time (UTC)', 'User', 'Action', 'Contest', 'PU', 'Detail'].map((x) => h('th', x)))),
    h('tbody', rows.map((r) => h('tr', h('td', { class: 'nowrap small' }, ts(r.at)), h('td', r.username || '—'), h('td', h('span', { class: 'chip ' + (r.action === 'login.fail' ? 'bad' : r.action === 'result.save' ? 'ok' : 'idle') }, r.action)), h('td', CLABEL[r.contest] || ''), h('td', { class: 'small' }, r.pu_code || ''), h('td', { class: 'small muted' }, r.detail || ''))))));
}

function activityView(root) {
  const body = h('div');
  root.append(h('div', { class: 'head' }, h('h2', 'Activity log'), h('span', { class: 'muted small' }, 'Every sign-in, data entry, assignment and export, newest first.')), h('div', { class: 'card' }, body));
  const load = async () => body.replaceChildren(activityTable((await api('GET', '/api/admin/activity?limit=300')).activity));
  load(); timers.push(setInterval(() => load().catch(() => {}), 15000));
}

// ---------- admin: agents ----------
function agentsView(root) {
  const body = h('div');
  root.append(h('div', { class: 'head' }, h('h2', 'Users & polling unit assignments'), h('div', { class: 'spacer' }), h('button', { class: 'btn', onclick: () => userDialog(null, load) }, '+ Create user')), h('div', { class: 'card' }, body));
  async function load() {
    const { users } = await api('GET', '/api/admin/users');
    body.replaceChildren(h('div', { class: 'tablewrap' }, h('table', h('thead', h('tr', ['Name', 'Username', 'Role', 'Polling units', 'Status', ''].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
      h('tbody', users.map((u) => h('tr', h('td', h('b', u.full_name)), h('td', u.username), h('td', u.role === 'admin' ? 'Administrator' : 'Data entry'), h('td', { class: 'num' }, u.role === 'agent' ? u.assigned : '—'),
        h('td', h('span', { class: 'chip ' + (u.active ? 'ok' : 'idle') }, u.active ? 'Active' : 'Disabled')), h('td', { class: 'right' }, h('button', { class: 'btn ghost small', onclick: () => userDialog(u, load) }, 'Manage'))))))));
  }
  load().catch((e) => toast(e.message, true));
}

function unitPicker(selectedSet, ownerId) {
  const wardSel = h('select'); const search = h('input', { placeholder: 'Search code or name…', type: 'search' });
  const list = h('div', { class: 'picker' }); const count = h('span', { class: 'small muted' });
  let units = [];
  function paint() {
    const w = wardSel.value, q = search.value.trim().toLowerCase();
    const vis = units.filter((u) => (!w || u.ward === w) && (!q || u.code.toLowerCase().includes(q) || u.name.toLowerCase().includes(q)));
    list.replaceChildren(...vis.map((u) => {
      const taken = u.agent_id && u.agent_id !== ownerId;
      return h('label', { class: taken ? 'taken' : '' }, h('input', { type: 'checkbox', disabled: !!taken, checked: selectedSet.has(u.code), onchange: (e) => { e.target.checked ? selectedSet.add(u.code) : selectedSet.delete(u.code); upd(); } }),
        h('span', h('b', u.code), ' ', u.name, h('span', { class: 'muted small' }, ` · ${u.registered} reg.`), taken ? h('span', { class: 'chip idle', style: 'margin-left:6px' }, u.agent_name) : null));
    }));
    upd(); picker.visible = vis.filter((u) => !(u.agent_id && u.agent_id !== ownerId));
  }
  const upd = () => (count.textContent = `${selectedSet.size} selected`);
  const picker = h('div', h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', 'Ward'), wardSel), h('div', { class: 'field' }, h('label', 'Search'), search)),
    h('div', { class: 'row', style: 'margin:8px 0;align-items:center' }, h('button', { type: 'button', class: 'btn ghost small', onclick: () => { picker.visible.filter((u) => !u.agent_id || u.agent_id === ownerId).forEach((u) => selectedSet.add(u.code)); paint(); } }, 'Select all available shown'),
      h('button', { type: 'button', class: 'btn ghost small', onclick: () => { picker.visible.forEach((u) => selectedSet.delete(u.code)); paint(); } }, 'Clear shown'), count), list);
  picker.visible = [];
  wardSel.onchange = paint; search.oninput = paint;
  api('GET', '/api/admin/units').then(({ units: us }) => {
    units = us; wardSel.append(h('option', { value: '' }, 'All wards'), ...[...new Set(us.map((u) => u.ward))].map((w) => h('option', { value: w }, w))); paint();
  });
  return picker;
}

function userDialog(user, reload) {
  const isNew = !user;
  const err = h('div', { class: 'notice bad', hidden: true });
  const showErr = (e) => { err.replaceChildren(e.message, ...(e.data?.conflicts ? [h('ul', e.data.conflicts.slice(0, 8).map((c) => h('li', `${c.code} (${c.name}) — ${c.owner}`)))] : [])); err.hidden = false; };
  const name = h('input', { value: user?.full_name || '', required: true, maxlength: 80 });
  const uname = h('input', { value: user?.username || '', disabled: !isNew, required: true, autocapitalize: 'none', maxlength: 32 });
  const role = h('select', { disabled: !isNew }, h('option', { value: 'agent' }, 'Data entry agent'), h('option', { value: 'admin' }, 'Administrator'));
  role.value = user?.role || 'agent';
  const pw = h('input', { type: 'text', autocomplete: 'off', placeholder: isNew ? 'Temporary password (min. 8)' : 'Leave blank to keep current', minlength: 8 });
  const gen = h('button', { type: 'button', class: 'btn ghost small', onclick: () => { pw.value = Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 54]).join(''); } }, 'Generate');
  const sel = new Set();
  const pickerBox = h('div');
  const unitsSection = h('div', h('h3', { style: 'margin:14px 0 6px' }, 'Assigned polling units'), h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'A polling unit can belong to only one agent. Units already held by another agent are greyed out.'), pickerBox);
  const refreshRole = () => (unitsSection.hidden = role.value !== 'agent');
  role.onchange = refreshRole; refreshRole();

  async function initPicker() {
    if (!isNew && user.role === 'agent') (await api('GET', `/api/admin/users/${user.id}/units`)).codes.forEach((c) => sel.add(c));
    pickerBox.append(unitPicker(sel, user?.id ?? -1));
  }
  initPicker();

  const save = h('button', { class: 'btn', type: 'button', onclick: async () => {
    err.hidden = true; save.disabled = true;
    try {
      if (isNew) {
        await api('POST', '/api/admin/users', { username: uname.value, full_name: name.value, password: pw.value, role: role.value, pu_codes: [...sel] });
        toast('User created. Share the temporary password securely — they must change it at first sign-in.');
      } else {
        const patch = { full_name: name.value }; if (pw.value) patch.password = pw.value;
        await api('PATCH', `/api/admin/users/${user.id}`, patch);
        if (user.role === 'agent') {
          const before = new Set((await api('GET', `/api/admin/users/${user.id}/units`)).codes);
          const remove = [...before].filter((c) => !sel.has(c)), add = [...sel].filter((c) => !before.has(c));
          if (remove.length) await api('DELETE', `/api/admin/users/${user.id}/units?codes=${remove.join(',')}`);
          if (add.length) await api('POST', `/api/admin/users/${user.id}/units`, { codes: add });
        }
        toast('Changes saved.');
      }
      box.close(); reload();
    } catch (e) { showErr(e); } finally { save.disabled = false; }
  } }, isNew ? 'Create user' : 'Save changes');

  const toggle = !isNew && user.id !== me.id && h('button', { class: user.active ? 'btn danger' : 'btn ghost', type: 'button', onclick: async () => {
    if (user.active && !confirm(`Disable ${user.full_name}? They will be signed out immediately. Their entered data and assigned units are kept.`)) return;
    try { await api('PATCH', `/api/admin/users/${user.id}`, { active: !user.active }); toast(user.active ? 'User disabled.' : 'User enabled.'); box.close(); reload(); } catch (e) { showErr(e); }
  } }, user.active ? 'Disable account' : 'Re-enable account');

  const form = h('div', err,
    h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', 'Full name'), name), h('div', { class: 'field' }, h('label', 'Username'), uname)),
    h('div', { class: 'row', style: 'margin-top:10px' }, h('div', { class: 'field' }, h('label', 'Role'), role), h('div', { class: 'field' }, h('label', isNew ? 'Temporary password' : 'Reset password'), h('div', { class: 'row', style: 'flex-wrap:nowrap' }, pw, gen))),
    unitsSection, h('div', { class: 'row', style: 'margin-top:16px' }, save, toggle || null));
  const box = modal(isNew ? 'Create user' : `Manage · ${user.full_name}`, form);
}

// ---------- admin: polling units ----------
function unitsView(root) {
  const body = h('div'); const wardSel = h('select', h('option', { value: '' }, 'All wards')); const only = h('select', h('option', { value: '' }, 'All units'), h('option', { value: 'un' }, 'Unassigned only'), h('option', { value: 'as' }, 'Assigned only'));
  const search = h('input', { type: 'search', placeholder: 'Search code, name or agent…' });
  let units = [];
  root.append(h('div', { class: 'head' }, h('h2', 'Polling units')), h('div', { class: 'card' }, h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', 'Ward'), wardSel), h('div', { class: 'field' }, h('label', 'Assignment'), only), h('div', { class: 'field' }, h('label', 'Search'), search)), h('div', { style: 'margin-top:12px' }, body)));
  function paint() {
    const q = search.value.trim().toLowerCase();
    const vis = units.filter((u) => (!wardSel.value || u.ward === wardSel.value) && (!only.value || (only.value === 'un' ? !u.agent_id : !!u.agent_id)) && (!q || `${u.code} ${u.name} ${u.agent_name || ''}`.toLowerCase().includes(q)));
    body.replaceChildren(h('p', { class: 'muted small' }, `${vis.length} of ${units.length} units · ${fmt(vis.reduce((a, u) => a + u.registered, 0))} registered voters`),
      h('div', { class: 'tablewrap scroll', style: 'max-height:640px' }, h('table', h('thead', h('tr', ['PU code', 'Polling unit', 'Ward', 'Registered', 'Class', 'Group', 'Assigned agent'].map((x, i) => h('th', { class: i === 3 ? 'num' : '' }, x)))),
        h('tbody', vis.map((u) => h('tr', h('td', u.code), h('td', u.name), h('td', u.ward), h('td', { class: 'num' }, fmt(u.registered)), h('td', u.reg_class), h('td', u.group80), h('td', u.agent_name ? u.agent_name : h('span', { class: 'chip warn' }, 'Unassigned'))))))));
  }
  wardSel.onchange = only.onchange = paint; search.oninput = paint;
  api('GET', '/api/admin/units').then(({ units: us }) => { units = us; [...new Set(us.map((u) => u.ward))].forEach((w) => wardSel.append(h('option', { value: w }, w))); paint(); }).catch((e) => toast(e.message, true));
}

// ---------- admin: results ----------
function resultsView(root) {
  let contest = 'presidential';
  const body = h('div'); const wardSel = h('select', h('option', { value: '' }, 'All wards')); const stSel = h('select', h('option', { value: '' }, 'Any status'), ['Complete', 'Incomplete', 'Check figures', 'Missing'].map((s) => h('option', { value: s }, s)));
  const search = h('input', { type: 'search', placeholder: 'Search code or name…' });
  const seg = h('div', { class: 'seg' });
  let rows = [];
  root.append(h('div', { class: 'head' }, h('h2', 'Results by polling unit'), h('div', { class: 'spacer' }), h('a', { class: 'btn ghost small', id: 'exp', href: '#' }, 'Export CSV')),
    h('div', { class: 'card' }, seg, h('div', { class: 'row' }, h('div', { class: 'field' }, h('label', 'Ward'), wardSel), h('div', { class: 'field' }, h('label', 'Status'), stSel), h('div', { class: 'field' }, h('label', 'Search'), search)), h('div', { style: 'margin-top:12px' }, body)));
  const exp = root.querySelector('#exp');
  function paint() {
    exp.href = `/api/admin/export/${contest}.csv`;
    seg.replaceChildren(...CONTESTS.map(([k, l]) => h('button', { 'aria-selected': String(k === contest), onclick: () => { contest = k; load(); } }, l)));
    const q = search.value.trim().toLowerCase();
    const vis = rows.filter((r) => (!wardSel.value || r.ward === wardSel.value) && (!stSel.value || r.status === stSel.value) && (!q || `${r.code} ${r.name}`.toLowerCase().includes(q)));
    body.replaceChildren(h('p', { class: 'muted small' }, `${vis.length} units shown. Click a row to view or correct a result.`), h('div', { class: 'tablewrap scroll', style: 'max-height:640px' }, h('table',
      h('thead', h('tr', ['PU code', 'Polling unit', 'Reg.', 'PDP', 'APC', 'LP', 'Accr.', 'Valid', 'Rej.', 'Total', 'Turnout', 'Status', 'Agent'].map((x, i) => h('th', { class: i > 1 && i < 11 ? 'num' : '' }, x)))),
      h('tbody', vis.map((r) => h('tr', { class: 'click', onclick: () => adminEdit(contest, r.code, load) }, h('td', r.code), h('td', r.name), h('td', { class: 'num' }, fmt(r.registered)),
        ['pdp', 'apc', 'lp', 'accredited', 'valid', 'rejected', 'total'].map((f) => h('td', { class: 'num' }, r[f] ?? '')), h('td', { class: 'num' }, pct(r.turnout)), h('td', chip(r.status)), h('td', { class: 'small' }, r.agent_name || '—')))))));
  }
  async function load() { rows = (await api('GET', `/api/admin/results/${contest}`)).results; if (wardSel.options.length === 1) [...new Set(rows.map((r) => r.ward))].forEach((w) => wardSel.append(h('option', { value: w }, w))); paint(); }
  wardSel.onchange = stSel.onchange = paint; search.oninput = paint;
  load().catch((e) => toast(e.message, true));
  timers.push(setInterval(() => { if (!document.querySelector('.overlay')) load().catch(() => {}); }, 20000));
}

async function adminEdit(contest, code, reload) {
  try {
    const { unit, result } = await api('GET', `/api/admin/results/${contest}/${code}`);
    const form = h('div', h('p', { class: 'muted small' }, `${unit.code} · ${unit.ward} · ${fmt(unit.registered)} registered · ${CLABEL[contest]}`),
      h('p', { class: 'notice warn' }, 'Administrator override — this change is recorded in the activity log.'),
      entryForm({ registered: unit.registered, data: result, canClear: true, onSave: async (payload) => { const r = await api('PUT', `/api/admin/results/${contest}/${code}`, payload); toast('Saved — ' + r.status); box.close(); reload && reload(); } }));
    const box = modal(unit.name, form);
  } catch (e) { toast(e.message, true); }
}

boot();
