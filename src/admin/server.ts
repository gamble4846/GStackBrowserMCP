// Admin UI + its API (plan §4.6). Never published through Funnel: reachable on 127.0.0.1:18081
// (via the admin gateway) or tailnet-only `tailscale serve`.
// Admins see every session; ordinary users who log in see only their own.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { config } from '../config';
import { authenticate, isLockedOut, recordAuthFailure, type Principal } from '../core/keys';
import { audit, log, onAudit } from '../core/log';
import { clientIp, readJson, sendError, sendJson } from '../api/http';
import {
  deleteSession, events, execInSession, getSession, listSessions, SessionError, usage,
} from '../core/sessionManager';
import { deleteProfile, listProfiles } from '../core/profiles';

const UI_DIR = path.join(import.meta.dir, 'ui');
const STATIC: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

// ---- admin login sessions (cookie) ----
const logins = new Map<string, { who: Principal; expires: number }>();
const LOGIN_TTL = 12 * 3600_000;
function cookieToken(req: IncomingMessage): string | null {
  const m = /(?:^|;\s*)gsadmin=([A-Za-z0-9_-]+)/.exec(req.headers.cookie ?? '');
  return m ? m[1] : null;
}
function currentUser(req: IncomingMessage): Principal | null {
  const t = cookieToken(req);
  const l = t ? logins.get(t) : undefined;
  if (!l || l.expires < Date.now()) { if (t) logins.delete(t); return null; }
  return l.who;
}

// ---- per-session timeline (last 200 commands) ----
const timelines = new Map<string, any[]>();
events.on('exec', (ev: any) => {
  const list = timelines.get(ev.session) ?? [];
  list.push({ ...ev, ts: new Date().toISOString() });
  if (list.length > 200) list.shift();
  timelines.set(ev.session, list);
});
events.on('session', (e: any) => { if (e.type === 'deleted') setTimeout(() => timelines.delete(e.session.id), 3600_000).unref(); });

// ---- live view frames (polling mode): one screenshot at a time, never queued behind agent work ----
const frames = new Map<string, { at: number; png: Buffer }>();
async function liveFrame(id: string, who: Principal): Promise<Buffer | null> {
  const s = getSession(id, who);
  const cached = frames.get(id);
  if (s.busy || s.status !== 'ready' || (cached && Date.now() - cached.at < 700)) return cached?.png ?? null;
  const r = await execInSession(s, 'system', { command: 'screenshot', args: ['--viewport', '--base64'], via: 'admin', internal: true, quiet: true, timeoutMs: 10_000 });
  const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(r.stdout);
  if (!m) return cached?.png ?? null;
  const png = Buffer.from(m[1], 'base64');
  frames.set(id, { at: Date.now(), png });
  return png;
}
events.on('session', (e: any) => { if (e.type === 'deleted') frames.delete(e.session.id); });

function canSee(who: Principal, owner: string): boolean { return who.role === 'admin' || who.user === owner; }

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://admin');
  const p = url.pathname.replace(/^\/admin(?=\/|$)/, '') || '/';
  const method = req.method ?? 'GET';
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');

  if (method === 'GET' && STATIC[p]) {
    const file = path.join(UI_DIR, STATIC[p]);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)], 'cache-control': 'no-cache',
      'content-security-policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com" });
    res.end(fs.readFileSync(file));
    return;
  }

  try {
    if (p === '/login' && method === 'POST') {
      const ip = clientIp(req);
      if (isLockedOut(ip)) { sendJson(res, 429, { error: 'too many failed attempts; try again later' }); return; }
      const body = await readJson(req, 4096);
      const who = authenticate(String(body.key ?? ''));
      if (!who) { recordAuthFailure(ip); audit({ action: 'auth.fail', ip, via: 'admin' }); sendJson(res, 401, { error: 'invalid key' }); return; }
      const token = crypto.randomBytes(32).toString('base64url');
      logins.set(token, { who, expires: Date.now() + LOGIN_TTL });
      const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      audit({ action: 'admin.login', user: who.user, ip, via: 'admin' });
      sendJson(res, 200, { user: who.user, role: who.role }, { 'set-cookie': `gsadmin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LOGIN_TTL / 1000}${secure}` });
      return;
    }
    if (p === '/logout' && method === 'POST') {
      const t = cookieToken(req); if (t) logins.delete(t);
      sendJson(res, 200, { ok: true }, { 'set-cookie': 'gsadmin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      return;
    }

    const who = currentUser(req);
    if (!who) { sendJson(res, 401, { error: 'not logged in' }); return; }
    // State-changing calls must come from our own page (SameSite=Strict cookie + this header).
    if (method !== 'GET' && req.headers['x-requested-with'] !== 'gstack-admin') { sendJson(res, 403, { error: 'missing x-requested-with' }); return; }

    if (p === '/api/me') { sendJson(res, 200, { user: who.user, role: who.role, liveView: config.liveViewMode }); return; }
    if (p === '/api/usage') { sendJson(res, 200, usage()); return; }
    if (p === '/api/sessions' && method === 'GET') { sendJson(res, 200, { sessions: listSessions(who) }); return; }
    if (p === '/api/sessions/kill-idle' && method === 'POST') {
      const minutes = Math.max(1, Number(url.searchParams.get('minutes') ?? 10));
      const victims = listSessions(who).filter((s) => s.idleSeconds > minutes * 60 && !s.busy);
      for (const v of victims) await deleteSession(v.id, who, `admin kill-idle by ${who.user}`);
      sendJson(res, 200, { deleted: victims.map((v) => v.id) });
      return;
    }
    const m = /^\/api\/sessions\/(gs_[a-z0-9x]+)(\/[a-z.]+)?$/.exec(p);
    if (m) {
      const s = getSession(m[1], who);
      const sub = m[2] ?? '';
      if (sub === '' && method === 'DELETE') { await deleteSession(s.id, who, `killed in admin UI by ${who.user}`); sendJson(res, 200, { deleted: s.id }); return; }
      if (sub === '/timeline') { sendJson(res, 200, { timeline: timelines.get(s.id) ?? [] }); return; }
      if (sub === '/live.png') {
        if (config.liveViewMode === 'off') { res.writeHead(204).end(); return; }
        const png = await liveFrame(s.id, who);
        if (!png) { res.writeHead(204).end(); return; }
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'content-length': png.length });
        res.end(png);
        return;
      }
      if (sub === '/console' || sub === '/network' || sub === '/tabs') {
        const r = await execInSession(s, who, { command: sub.slice(1), args: [], via: 'admin', ip: clientIp(req) });
        sendJson(res, 200, { output: r.stdout || r.stderr });
        return;
      }
      if (sub === '/files') {
        const out: { path: string; bytes: number }[] = [];
        const walk = (d: string, rel: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (!rel && ['home', 'tmp', '.gstack', 'auth'].includes(e.name)) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push({ path: r, bytes: fs.statSync(path.join(d, e.name)).size });
          }
        };
        walk(s.ident.dir, '');
        sendJson(res, 200, { files: out });
        return;
      }
      if (sub === '/file') {
        const rel = url.searchParams.get('path') ?? '';
        const abs = path.join(s.ident.dir, rel);
        if (!rel || rel.includes('..') || path.isAbsolute(rel) || /^(home|tmp|\.gstack|auth)(\/|$)/.test(rel) || !fs.existsSync(abs)) throw new SessionError(404, 'file not found');
        const data = fs.readFileSync(abs);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${path.basename(rel).replace(/"/g, '')}"`, 'content-length': data.length });
        res.end(data);
        return;
      }
    }
    if (p === '/api/profiles' && method === 'GET') { sendJson(res, 200, { profiles: listProfiles(who.role === 'admin' ? null : who.user) }); return; }
    const pm = /^\/api\/profiles\/([^/]+)\/([^/]+)$/.exec(p);
    if (pm && method === 'DELETE') {
      const owner = decodeURIComponent(pm[1]);
      if (!canSee(who, owner)) throw new SessionError(404, 'profile not found');
      deleteProfile(owner, decodeURIComponent(pm[2]));
      audit({ action: 'profile.delete', user: who.user, via: 'admin', detail: `${owner}/${pm[2]}` });
      sendJson(res, 200, { deleted: true });
      return;
    }
    if (p === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(': connected\n\n');
      const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      const onSession = (e: any) => { if (canSee(who, e.session.owner)) send('session', e); };
      const onExec = (e: any) => { if (canSee(who, e.sessionOwner)) send('exec', e); };
      events.on('session', onSession);
      events.on('exec', onExec);
      const offAudit = who.role === 'admin' ? onAudit((e) => { if (e.action === 'auth.fail') send('audit', e); }) : () => undefined;
      const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
      req.on('close', () => { clearInterval(ping); events.off('session', onSession); events.off('exec', onExec); offAudit(); });
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    sendError(res, err);
  }
}

export function startAdminServer(): http.Server {
  const server = http.createServer((req, res) => { void handle(req, res); });
  server.listen(config.adminPort, '0.0.0.0', () => log.info('admin', `admin UI on :${config.adminPort}`));
  return server;
}
