// GStack Browser admin UI: sessions (live via SSE), stats, session drawer with live view
// (polling), timeline, console/network/tabs, files, auth profiles.
const $ = (id) => document.getElementById(id);
const H = { 'content-type': 'application/json', 'x-requested-with': 'gstack-admin' };
let me = null;
let sessions = new Map();
let openId = null;
let liveTimer = null;
let es = null;
let panel = 'timeline';
let timers = [];

// ---------- helpers ----------
async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('Signed out'); }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
}
function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k !== undefined && k !== null && k !== false) e.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return e;
}
function svg(path) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.innerHTML = path;
  return s;
}
const ago = (s) => (s < 5 ? 'now' : s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`);
const idleOf = (s) => Math.max(0, Math.round((Date.now() - Date.parse(s.lastActivityAt)) / 1000));
const statusOf = (s) => (s.busy ? 'busy' : s.status);
const initials = (name) => (name || '?').replace(/[^A-Za-z0-9]/g, ' ').trim().split(/\s+/).map((w) => w[0]).join('').slice(0, 2) || '?';
function hue(str) { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }
function avatar(name, cls = 'avatar sm') {
  const a = el('span', { class: cls, title: name }, initials(name));
  const h = hue(name || '');
  a.style.background = `hsl(${h} 70% 92% / .9)`; a.style.color = `hsl(${h} 55% 38%)`;
  if (document.documentElement.dataset.dark === '1') { a.style.background = `hsl(${h} 45% 30% / .5)`; a.style.color = `hsl(${h} 80% 80%)`; }
  return a;
}
function urlView(u) {
  let host = u, path = '';
  try { const x = new URL(u); host = x.host || x.protocol.replace(':', ''); path = x.pathname === '/' ? '' : x.pathname + x.search; } catch { /* about:blank etc. */ }
  const fav = el('span', { class: 'fav' }, (host[0] || '?').toUpperCase());
  fav.style.background = `hsl(${hue(host)} 55% 52%)`;
  return el('div', { class: 'url', title: u }, fav, el('span', { class: 'host' }, host), path ? el('span', { class: 'path' }, path) : null);
}
function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  $('toasts').append(t);
  setTimeout(() => t.remove(), 3500);
}
function confirmBox(title, text, yesLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('confirmTitle').textContent = title; $('confirmText').textContent = text; $('confirmYes').textContent = yesLabel;
    $('confirm').hidden = false; $('confirmYes').focus();
    const done = (v) => { $('confirm').hidden = true; $('confirmYes').onclick = $('confirmNo').onclick = null; document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
    document.addEventListener('keydown', onKey);
  });
}

// ---------- theme ----------
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.dataset.dark = dark ? '1' : '0';
}
let theme = null;
try { theme = localStorage.getItem('gs-theme'); } catch { /* storage unavailable */ }
applyTheme(theme);
$('themeToggle').addEventListener('click', () => {
  const dark = document.documentElement.dataset.dark === '1';
  theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('gs-theme', theme); } catch { /* ignore */ }
  applyTheme(theme); renderSessions();
  if (me) $('userAvatar').replaceWith(Object.assign(avatar(me.user, 'avatar'), { id: 'userAvatar' }));
  if (!$('profiles').hidden) refreshProfiles();
});

// ---------- auth ----------
function showLogin() {
  me = null;
  $('login').hidden = false; $('app').hidden = true; closeDetail();
  es?.close(); es = null;
  timers.forEach(clearInterval); timers = [];
  setTimeout(() => $('key').focus(), 50);
}
async function start() {
  try { me = await api('/api/me'); } catch { showLogin(); return; }
  $('login').hidden = true; $('app').hidden = false;
  $('whoami').textContent = me.user; $('whorole').textContent = me.role === 'admin' ? 'Administrator' : 'User';
  $('userAvatar').replaceWith(Object.assign(avatar(me.user, 'avatar'), { id: 'userAvatar' }));
  show('sessions');
  await refreshSessions();
  connectEvents();
  refreshUsage();
  timers.push(setInterval(refreshUsage, 10000), setInterval(renderSessions, 5000));
}
function show(view) {
  for (const v of ['sessions', 'profiles']) $(v).hidden = v !== view;
  for (const b of document.querySelectorAll('#tabs .nav-item')) b.classList.toggle('active', b.dataset.view === view);
  if (view === 'profiles') refreshProfiles();
}

// ---------- stats ----------
function setMeter(id, frac) {
  const m = $(id); m.style.width = `${Math.min(100, Math.round(frac * 100))}%`;
  m.classList.toggle('warn', frac >= 0.7 && frac < 0.9); m.classList.toggle('hot', frac >= 0.9);
}
async function refreshUsage() {
  try {
    const u = await api('/api/usage');
    $('statActive').textContent = u.active; $('statMax').textContent = u.max;
    $('statMem').textContent = u.memory.usedMb.toLocaleString(); $('statMemMax').textContent = u.memory.limitMb.toLocaleString();
    setMeter('meterSessions', u.max ? u.active / u.max : 0);
    setMeter('meterMem', u.memory.limitMb ? u.memory.usedMb / u.memory.limitMb : 0);
  } catch { /* shown on next tick */ }
}

// ---------- sessions ----------
async function refreshSessions() {
  const { sessions: list } = await api('/api/sessions');
  sessions = new Map(list.map((s) => [s.id, s]));
  renderSessions();
}
function renderSessions() {
  const list = [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('navCount').textContent = list.length;
  $('statBusy').textContent = list.filter((s) => s.busy).length;
  $('statTunnels').textContent = list.filter((s) => s.tunnel?.connected).length;
  $('sessionsEmpty').hidden = list.length > 0;
  $('sessionRows').replaceChildren(...list.map((s) => {
    const st = statusOf(s);
    return el('tr', { class: `row${s.id === openId ? ' selected' : ''}`, onclick: () => openDetail(s.id), tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter') openDetail(s.id); } },
      el('td', { class: 'id-cell' }, el('code', {}, s.id), s.label ? el('div', { class: 'sub' }, s.label) : el('div', { class: 'sub' }, `started ${ago(Math.round((Date.now() - Date.parse(s.createdAt)) / 1000))} ago`)),
      el('td', {}, el('div', { class: 'owner' }, avatar(s.owner), el('div', {}, s.owner, el('div', { class: 'sub' }, `via ${s.via}`)))),
      el('td', {}, el('span', { class: `status ${st}`, title: s.error || '' }, st)),
      el('td', { class: 'url-cell' }, urlView(s.currentUrl)),
      el('td', { class: 'num-col' }, s.commandCount),
      el('td', {}, ago(idleOf(s))),
      el('td', {}, s.tunnel?.connected ? el('span', { class: 'chip info' }, `:${s.tunnel.ports.join(', :')}`) : el('span', { class: 'muted' }, '—')),
      el('td', { class: 'row-actions' }, el('button', { class: 'btn small danger-outline', onclick: (e) => { e.stopPropagation(); kill(s.id); } }, 'Kill')),
    );
  }));
  if (openId) renderDetailHead();
}
async function kill(id) {
  const ok = await confirmBox('Kill this session?', `${id} will be stopped. Its browser profile, cookies and files are deleted permanently.`, 'Kill session');
  if (!ok) return;
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); toast(`Session ${id} killed`); } catch (e) { toast(e.message, 'error'); }
}

// ---------- drawer ----------
function renderDetailHead() {
  const s = sessions.get(openId);
  if (!s) return;
  const st = statusOf(s);
  $('detailStatus').className = `status ${st}`; $('detailStatus').textContent = st;
  $('detailTitle').textContent = s.id;
  $('detailMeta').replaceChildren(...[
    el('span', {}, 'Owner ', el('b', {}, s.owner)),
    el('span', {}, 'Via ', el('b', {}, s.via)),
    el('span', {}, 'Commands ', el('b', {}, s.commandCount)),
    el('span', {}, 'Idle ', el('b', {}, ago(idleOf(s)))),
    s.tunnel?.connected ? el('span', {}, 'Tunnel ', el('b', {}, `localhost:${s.tunnel.ports.join(', ')}`)) : null,
    s.label ? el('span', {}, 'Label ', el('b', {}, s.label)) : null,
  ].filter(Boolean));
  $('liveUrl').textContent = s.currentUrl;
}
async function openDetail(id) {
  openId = id;
  $('detail').hidden = false; $('scrim').hidden = false;
  $('live').removeAttribute('src'); $('livePlaceholder').hidden = false;
  renderSessions();
  setPanel('timeline');
  try {
    const { timeline } = await api(`/api/sessions/${id}/timeline`);
    renderTimeline(timeline.slice().reverse());
  } catch (e) { toast(e.message, 'error'); }
  refreshFiles();
  startLive();
}
function closeDetail() {
  openId = null; stopLive();
  $('detail').hidden = true; $('scrim').hidden = true;
  renderSessions();
}
function tlItem(ev, fresh = false) {
  const ok = ev.ok !== false;
  return el('li', { class: `${ok ? '' : 'fail'}${fresh ? ' fresh' : ''}` },
    el('div', { class: 'tl-top' }, el('span', { class: 'tl-cmd' }, ev.command), el('span', { class: 'tl-args' }, (ev.args || []).join(' '))),
    el('div', { class: 'tl-meta' },
      el('span', {}, new Date(ev.ts).toLocaleTimeString()), el('span', {}, `${ev.user} · ${ev.via}`),
      el('span', {}, `${ev.durationMs} ms`), ok ? null : el('span', { class: 'chip danger' }, `exit ${ev.exitCode}`)),
    ev.error || ev.outputPreview ? el('pre', { class: 'tl-out' }, ev.error || ev.outputPreview) : null);
}
function renderTimeline(items) {
  $('timeline').replaceChildren(...(items.length ? items.map((ev) => tlItem(ev)) : [el('li', { class: 'empty' }, el('div', { class: 'empty-title' }, 'No commands yet'), el('div', { class: 'muted' }, 'Commands appear here as they run.'))]));
}
function setPanel(name) {
  panel = name;
  for (const b of document.querySelectorAll('.seg-btn')) b.classList.toggle('active', b.dataset.panel === name);
  $('timeline').hidden = name !== 'timeline';
  $('files').hidden = name !== 'files';
  $('toolOut').hidden = !['console', 'network', 'tabs'].includes(name);
  if (['console', 'network', 'tabs'].includes(name)) runTool(name);
  if (name === 'files') refreshFiles();
}
async function runTool(name) {
  if (!openId) return;
  const out = $('toolOut'); out.textContent = 'Loading…';
  try { const r = await api(`/api/sessions/${openId}/${name}`); if (panel === name) out.textContent = (r.output || '').trim() || '(empty)'; }
  catch (e) { if (panel === name) out.textContent = e.message; }
}
async function refreshFiles() {
  if (!openId) return;
  try {
    const { files } = await api(`/api/sessions/${openId}/files`);
    $('fileCount').textContent = files.length ? files.length : '';
    $('files').replaceChildren(...(files.length ? files.map((f) => el('li', {},
      el('a', { href: `/api/sessions/${openId}/file?path=${encodeURIComponent(f.path)}` },
        svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>'),
        el('span', { class: 'fname' }, f.path), el('span', { class: 'fsize' }, f.bytes > 1048576 ? `${(f.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(f.bytes / 1024))} KB`))))
      : [el('li', { class: 'empty' }, el('div', { class: 'empty-title' }, 'No files'), el('div', { class: 'muted' }, 'Screenshots, PDFs and downloads show up here.'))]));
  } catch { /* drawer may have closed */ }
}

// ---------- live view (polling) ----------
function startLive() {
  stopLive();
  const state = $('liveState');
  if (me.liveView === 'off') { state.className = 'live-state'; state.textContent = 'Live view off'; return; }
  const img = $('live');
  let inflight = false;
  const tick = async () => {
    if (!openId || inflight || document.hidden) return;
    inflight = true;
    try {
      const res = await fetch(`/api/sessions/${openId}/live.png?t=${Date.now()}`, { credentials: 'same-origin' });
      if (res.status === 200) {
        const url = URL.createObjectURL(await res.blob());
        const old = img.src; img.src = url; if (old.startsWith('blob:')) URL.revokeObjectURL(old);
        $('livePlaceholder').hidden = true;
        state.className = 'live-state on'; state.textContent = 'Live';
      } else if (res.status === 204) { state.className = 'live-state'; state.textContent = 'Busy…'; }
      else { state.className = 'live-state'; state.textContent = 'Unavailable'; }
    } catch { state.className = 'live-state'; state.textContent = 'Offline'; }
    inflight = false;
  };
  tick();
  liveTimer = setInterval(tick, 1000);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }

// ---------- server events ----------
function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('session', (m) => {
    const { type, session } = JSON.parse(m.data);
    if (type === 'deleted') { sessions.delete(session.id); if (openId === session.id) { closeDetail(); toast(`Session ${session.id} ended`); } }
    else sessions.set(session.id, session);
    renderSessions();
  });
  es.addEventListener('exec', (m) => {
    const ev = JSON.parse(m.data);
    if (ev.session !== openId) return;
    const tl = $('timeline');
    tl.querySelector('.empty')?.remove();
    tl.prepend(tlItem({ ...ev, ts: new Date().toISOString() }, true));
    if (/screenshot|pdf|responsive|download|archive|scrape/.test(ev.command)) refreshFiles();
  });
  es.onerror = () => setTimeout(() => { if (me) refreshSessions().catch(() => {}); }, 2000);
}

// ---------- profiles ----------
async function refreshProfiles() {
  try {
    const { profiles } = await api('/api/profiles');
    $('profilesEmpty').hidden = profiles.length > 0;
    $('profileRows').replaceChildren(...profiles.map((p) => {
      const expiry = p.earliestExpiry
        ? el('span', { class: p.expired ? 'chip danger' : p.expiresSoon ? 'chip warn' : '' }, new Date(p.earliestExpiry).toLocaleString(), p.expired ? ' · expired' : p.expiresSoon ? ' · soon' : '')
        : el('span', { class: 'muted' }, 'session cookies');
      return el('tr', {},
        el('td', {}, el('div', { class: 'owner' }, avatar(p.owner), p.owner)),
        el('td', { class: 'id-cell' }, el('code', {}, p.name)),
        el('td', { class: 'num-col' }, p.cookieCount), el('td', { class: 'num-col' }, p.originCount),
        el('td', {}, expiry), el('td', {}, new Date(p.updatedAt).toLocaleString()),
        el('td', { class: 'row-actions' }, el('button', { class: 'btn small danger-outline', onclick: async () => {
          if (!(await confirmBox('Delete this profile?', `${p.owner}/${p.name} will be removed. Sessions can no longer start with it.`, 'Delete'))) return;
          try { await api(`/api/profiles/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); toast('Profile deleted'); refreshProfiles(); }
          catch (e) { toast(e.message, 'error'); }
        } }, 'Delete')));
    }));
  } catch (e) { toast(e.message, 'error'); }
}

// ---------- wiring ----------
$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginError').textContent = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ key: $('key').value.trim() }) }); $('key').value = ''; start(); }
  catch (err) { $('loginError').textContent = err.message === 'invalid key' ? 'That key is not valid.' : err.message; }
});
$('logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
for (const b of document.querySelectorAll('#tabs .nav-item')) b.addEventListener('click', () => show(b.dataset.view));
for (const b of document.querySelectorAll('.seg-btn')) b.addEventListener('click', () => setPanel(b.dataset.panel));
$('detailClose').addEventListener('click', closeDetail);
$('scrim').addEventListener('click', closeDetail);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openId && $('confirm').hidden) closeDetail(); });
$('detailKill').addEventListener('click', () => openId && kill(openId));
$('copyId').addEventListener('click', async () => { try { await navigator.clipboard.writeText(openId); toast('Session id copied'); } catch { toast(openId); } });
$('killIdle').addEventListener('click', async () => {
  const minutes = Math.max(1, Number($('idleMin').value || 10));
  if (!(await confirmBox('Kill idle sessions?', `Every session idle for more than ${minutes} minutes will be stopped and deleted.`, 'Kill idle'))) return;
  try { const r = await api(`/api/sessions/kill-idle?minutes=${minutes}`, { method: 'POST' }); toast(r.deleted.length ? `Killed ${r.deleted.length} idle session(s)` : 'No idle sessions'); }
  catch (e) { toast(e.message, 'error'); }
});
start();
