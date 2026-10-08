// GStack Browser admin UI: sessions (live), timeline, live view (polling), files, auth profiles.
const $ = (id) => document.getElementById(id);
const H = { 'content-type': 'application/json', 'x-requested-with': 'gstack-admin' };
let me = null;
let sessions = new Map();
let openId = null;
let liveTimer = null;
let es = null;

async function api(path, opts = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (res.status === 401 && path !== '/login') { showLogin(); throw new Error('not logged in'); }
  const ct = res.headers.get('content-type') || '';
  const body = ct.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(body?.error || res.statusText);
  return body;
}

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) e.append(k instanceof Node ? k : document.createTextNode(String(k ?? '')));
  return e;
}
const ago = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`);

function showLogin() {
  me = null;
  $('login').hidden = false; $('sessions').hidden = true; $('profiles').hidden = true;
  $('tabs').hidden = true; $('logout').hidden = true; $('whoami').textContent = ''; $('usage').textContent = '';
  es?.close(); es = null;
}

async function start() {
  try { me = await api('/api/me'); } catch { showLogin(); return; }
  $('login').hidden = true; $('tabs').hidden = false; $('logout').hidden = false;
  $('whoami').textContent = `${me.user} (${me.role})`;
  show('sessions');
  await refreshSessions();
  connectEvents();
  setInterval(refreshUsage, 10000); refreshUsage();
  setInterval(renderSessions, 5000);
}

function show(view) {
  for (const v of ['sessions', 'profiles']) $(v).hidden = v !== view;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.view === view);
  if (view === 'profiles') refreshProfiles();
}

async function refreshUsage() {
  try { const u = await api('/api/usage'); $('usage').textContent = `${u.active}/${u.max} sessions · ${u.memory.usedMb}/${u.memory.limitMb} MB`; } catch {}
}

async function refreshSessions() {
  const { sessions: list } = await api('/api/sessions');
  sessions = new Map(list.map((s) => [s.id, s]));
  renderSessions();
}

function renderSessions() {
  const rows = $('sessionRows');
  rows.replaceChildren();
  const list = [...sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  if (!list.length) { rows.append(el('tr', {}, el('td', { colspan: 8, class: 'muted' }, 'No sessions.'))); return; }
  for (const s of list) {
    const idle = Math.round((Date.now() - Date.parse(s.lastActivityAt)) / 1000);
    const status = s.busy ? 'busy' : s.status;
    rows.append(el('tr', { class: 'clickable', onclick: () => openDetail(s.id) },
      el('td', {}, el('code', {}, s.id), s.label ? el('div', { class: 'muted' }, s.label) : ''),
      el('td', {}, s.owner, el('div', { class: 'muted' }, s.via)),
      el('td', {}, el('span', { class: `pill s-${status}` }, status)),
      el('td', { class: 'url', title: s.currentUrl }, s.currentUrl),
      el('td', {}, s.commandCount),
      el('td', {}, ago(idle)),
      el('td', {}, s.tunnel?.connected ? `:${s.tunnel.ports.join(',')}` : '—'),
      el('td', {}, el('button', { class: 'danger ghost', onclick: (e) => { e.stopPropagation(); kill(s.id); } }, 'Kill')),
    ));
  }
  if (openId && sessions.has(openId)) $('detailTitle').replaceChildren(el('code', {}, openId), ` · ${sessions.get(openId).owner} · ${sessions.get(openId).currentUrl}`);
}

async function kill(id) {
  if (!confirm(`Kill session ${id}? Its browser profile and files are deleted permanently.`)) return;
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch (e) { alert(e.message); }
}

async function openDetail(id) {
  openId = id;
  $('detail').hidden = false; $('toolOut').hidden = true;
  renderSessions();
  const { timeline } = await api(`/api/sessions/${id}/timeline`);
  $('timeline').replaceChildren(...timeline.slice().reverse().map(timelineItem));
  refreshFiles();
  startLive();
  $('detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeDetail() { openId = null; $('detail').hidden = true; stopLive(); }

function timelineItem(ev) {
  const ok = ev.ok !== false;
  return el('li', { class: ok ? '' : 'fail' },
    el('div', { class: 'cmd' }, `${ev.command} ${(ev.args || []).join(' ')}`),
    el('div', { class: 'meta' }, `${new Date(ev.ts).toLocaleTimeString()} · ${ev.user} via ${ev.via} · ${ev.durationMs} ms · exit ${ev.exitCode}`),
    ev.error || ev.outputPreview ? el('pre', {}, ev.error || ev.outputPreview) : '');
}

function startLive() {
  stopLive();
  if (me.liveView === 'off') { $('liveState').textContent = '(disabled)'; return; }
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
        $('liveState').textContent = `· ${new Date().toLocaleTimeString()}`;
      } else if (res.status === 204) $('liveState').textContent = '· busy/starting';
      else $('liveState').textContent = '· unavailable';
    } catch { $('liveState').textContent = '· error'; }
    inflight = false;
  };
  tick();
  liveTimer = setInterval(tick, 1000);
}
function stopLive() { clearInterval(liveTimer); liveTimer = null; }

async function refreshFiles() {
  if (!openId) return;
  const { files } = await api(`/api/sessions/${openId}/files`);
  $('files').replaceChildren(...(files.length ? files.map((f) => el('li', {},
    el('a', { href: `/api/sessions/${openId}/file?path=${encodeURIComponent(f.path)}` }, f.path), el('span', { class: 'muted' }, ` ${Math.ceil(f.bytes / 1024)} KB`))) : [el('li', { class: 'muted' }, 'none')]));
}

async function runTool(name) {
  if (!openId) return;
  const out = $('toolOut'); out.hidden = false; out.textContent = `${name}…`;
  try { const r = await api(`/api/sessions/${openId}/${name}`); out.textContent = r.output || '(empty)'; } catch (e) { out.textContent = e.message; }
}

function connectEvents() {
  es?.close();
  es = new EventSource('/api/events');
  es.addEventListener('session', (m) => {
    const { type, session } = JSON.parse(m.data);
    if (type === 'deleted') { sessions.delete(session.id); if (openId === session.id) closeDetail(); }
    else sessions.set(session.id, session);
    renderSessions();
  });
  es.addEventListener('exec', (m) => {
    const ev = JSON.parse(m.data);
    if (ev.session === openId) { $('timeline').prepend(timelineItem({ ...ev, ts: new Date().toISOString() })); if (ev.command.match(/screenshot|pdf|responsive|download|archive|scrape/)) refreshFiles(); }
  });
  es.onerror = () => setTimeout(() => { if (me) refreshSessions().catch(() => {}); }, 2000);
}

async function refreshProfiles() {
  const { profiles } = await api('/api/profiles');
  const rows = $('profileRows');
  rows.replaceChildren(...(profiles.length ? profiles.map((p) => el('tr', {},
    el('td', {}, p.owner), el('td', {}, el('code', {}, p.name)), el('td', {}, p.cookieCount), el('td', {}, p.originCount),
    el('td', { class: p.expired ? 's-failed' : p.expiresSoon ? 's-starting' : '' }, p.earliestExpiry ? new Date(p.earliestExpiry).toLocaleString() + (p.expired ? ' (expired)' : p.expiresSoon ? ' (soon)' : '') : 'session cookies'),
    el('td', {}, new Date(p.updatedAt).toLocaleString()),
    el('td', {}, el('button', { class: 'danger ghost', onclick: async () => {
      if (!confirm(`Delete profile ${p.owner}/${p.name}?`)) return;
      await api(`/api/profiles/${encodeURIComponent(p.owner)}/${encodeURIComponent(p.name)}`, { method: 'DELETE' }); refreshProfiles();
    } }, 'Delete')))) : [el('tr', {}, el('td', { colspan: 7, class: 'muted' }, 'No saved profiles.'))]));
}

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); $('loginError').textContent = '';
  try { await api('/login', { method: 'POST', body: JSON.stringify({ key: $('key').value }) }); $('key').value = ''; start(); }
  catch (err) { $('loginError').textContent = err.message; }
});
$('logout').addEventListener('click', async () => { await api('/logout', { method: 'POST' }).catch(() => {}); location.reload(); });
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => show(b.dataset.view));
$('detailClose').addEventListener('click', closeDetail);
$('detailKill').addEventListener('click', () => openId && kill(openId));
for (const b of document.querySelectorAll('[data-tool]')) b.addEventListener('click', () => runTool(b.dataset.tool));
$('killIdle').addEventListener('click', async () => {
  const minutes = Number($('idleMin').value || 10);
  if (!confirm(`Kill all sessions idle for more than ${minutes} minutes?`)) return;
  const r = await api(`/api/sessions/kill-idle?minutes=${minutes}`, { method: 'POST' });
  alert(`Killed ${r.deleted.length} session(s).`);
});
start();
