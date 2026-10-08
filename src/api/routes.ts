// REST API for browse-remote and scripts (plan §4.3). Mounted under BASE_PATH (default /gstack).
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config';
import { clientIp, readBody, readJson, requireAuth, sendError, sendJson } from './http';
import { run } from '../core/exec';
import {
  createSession, deleteSession, execInSession, getSession, listSessions, publicView, SessionError,
  touch, usage, waitReady, type Session,
} from '../core/sessionManager';
import { applyAuthState, assertSize, exportAuthState, normalizeAuthState, summarize } from '../core/authState';
import { deleteProfile, listProfiles, loadProfile, saveProfile } from '../core/profiles';
import { issueTicket } from '../core/tunnel';
import { audit } from '../core/log';
import type { Principal } from '../core/keys';

const SAFE_REL = /^files\/[A-Za-z0-9._\-/]{1,200}$/;

function safeFilePath(s: Session, rel: string): string {
  const clean = decodeURIComponent(rel);
  if (!SAFE_REL.test(clean) || clean.includes('..')) throw new SessionError(400, 'file path must look like files/<name> (letters, digits, . _ - /)');
  return path.join(s.ident.dir, clean);
}

async function resolveAuth(who: Principal, body: any) {
  if (body.authProfile) return { state: loadProfile(who.user, String(body.authProfile)), warnings: [] as string[] };
  if (body.authState) {
    const raw = typeof body.authState === 'string' ? body.authState : JSON.stringify(body.authState);
    assertSize(raw);
    try { return normalizeAuthState(raw, body.origin); } catch (err: any) { throw new SessionError(400, `auth state: ${err.message}`); }
  }
  return null;
}

export async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const p = pathname.replace(/\/+$/, '') || '/';

  if (p === '/api/health') { sendJson(res, 200, { status: 'ok', ...usage() }); return; }

  const who = requireAuth(req, res, 'api');
  if (!who) return;
  const ip = clientIp(req);

  try {
    if (p === '/api/me' && method === 'GET') {
      sendJson(res, 200, { user: who.user, role: who.role, maxSessions: who.maxSessions, sessions: listSessions(who).length, server: usage() });
      return;
    }

    // ---- sessions ----
    if (p === '/api/sessions' && method === 'GET') { sendJson(res, 200, { sessions: listSessions(who) }); return; }
    if (p === '/api/sessions' && method === 'POST') {
      const body = await readJson(req);
      const auth = await resolveAuth(who, body);
      const s = await createSession(who, 'api', { viewport: body.viewport, stealth: body.stealth, label: body.label },
        auth ? async (sess) => {
          const r = await applyAuthState(sess, who, auth.state);
          audit({ action: 'auth.apply', user: who.user, session: sess.id, ip, ok: r.origins.every((o) => o.ok), detail: JSON.stringify(summarize(auth.state)) });
          (sess as any).authReport = { ...r, warnings: auth.warnings };
        } : undefined);
      const wait = Math.min(Number(body.wait ?? 0), 120);
      if (wait > 0) await waitReady(s, wait * 1000);
      sendJson(res, 201, { session: publicView(s), authReport: (s as any).authReport });
      return;
    }

    const m = /^\/api\/sessions\/(gs_[a-z0-9x]+)(\/.*)?$/.exec(p);
    if (m) {
      const s = getSession(m[1], who);
      const sub = m[2] ?? '';
      if (sub === '' && method === 'GET') {
        const wait = Math.min(Number(url.searchParams.get('wait') ?? 0), 120);
        if (wait > 0) await waitReady(s, wait * 1000);
        sendJson(res, 200, { session: publicView(s), authReport: (s as any).authReport });
        return;
      }
      if (sub === '' && method === 'DELETE') { await deleteSession(s.id, who); sendJson(res, 200, { deleted: s.id }); return; }
      if (sub === '/keepalive' && method === 'POST') { touch(s); sendJson(res, 200, { ok: true }); return; }

      if (sub === '/exec' && method === 'POST') {
        const body = await readJson(req);
        if (typeof body.command !== 'string') throw new SessionError(400, 'body needs {"command": "...", "args": [...]}');
        const args = Array.isArray(body.args) ? body.args.map(String) : [];
        const r = await execInSession(s, who, {
          command: body.command, args, stdin: typeof body.stdin === 'string' ? body.stdin : undefined,
          timeoutMs: body.timeoutMs ? Math.min(Number(body.timeoutMs), 300_000) : undefined, via: 'api', ip,
        });
        sendJson(res, 200, { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr, durationMs: r.durationMs, files: r.files, sessionDir: s.ident.dir });
        return;
      }

      const fm = /^\/files\/(.+)$/.exec(sub);
      if (fm && method === 'PUT') {
        const file = safeFilePath(s, `files/${fm[1]}`);
        const buf = await readBody(req, config.uploadMaxBytes);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buf, { mode: 0o600 });
        await run('chown', ['-R', `${s.ident.user}:${s.ident.user}`, path.join(s.ident.dir, 'files')]);
        sendJson(res, 201, { path: path.relative(s.ident.dir, file).split(path.sep).join('/'), bytes: buf.length });
        return;
      }
      if (fm && method === 'GET') {
        const rel = decodeURIComponent(fm[1]);
        const file = path.join(s.ident.dir, rel);
        if (rel.includes('..') || path.isAbsolute(rel) || /^(home|tmp|\.gstack|auth)(\/|$)/.test(rel) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          throw new SessionError(404, `file not found: ${rel}`);
        }
        const data = fs.readFileSync(file);
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-store' });
        res.end(data);
        return;
      }
      if (sub === '/files' && method === 'GET') {
        const out: string[] = [];
        const walk = (d: string, rel: string) => {
          for (const e of fs.readdirSync(d, { withFileTypes: true })) {
            if (!rel && ['home', 'tmp', '.gstack', 'auth'].includes(e.name)) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) walk(path.join(d, e.name), r); else out.push(r);
          }
        };
        walk(s.ident.dir, '');
        sendJson(res, 200, { files: out });
        return;
      }

      if (sub === '/auth-state' && method === 'POST') {
        const body = await readJson(req);
        const auth = await resolveAuth(who, body);
        if (!auth) throw new SessionError(400, 'body needs "authState" or "authProfile"');
        const r = await applyAuthState(s, who, auth.state, { returnTo: body.returnTo });
        audit({ action: 'auth.apply', user: who.user, session: s.id, ip, ok: r.origins.every((o) => o.ok), detail: JSON.stringify(summarize(auth.state)) });
        sendJson(res, 200, { report: { ...r, warnings: auth.warnings } });
        return;
      }
      if (sub === '/auth-state' && method === 'GET') {
        if (s.owner !== who.user) throw new SessionError(403, 'only the session owner can export its auth state');
        const origins = url.searchParams.get('origins')?.split(',').filter(Boolean);
        const state = await exportAuthState(s, who, origins);
        audit({ action: 'auth.export', user: who.user, session: s.id, ip, detail: JSON.stringify(summarize(state)) });
        sendJson(res, 200, { authState: state });
        return;
      }
      if (sub === '/tunnel-ticket' && method === 'POST') {
        if (s.owner !== who.user) throw new SessionError(403, 'only the session owner can open a tunnel to their machine');
        const body = await readJson(req);
        const ports = (Array.isArray(body.ports) ? body.ports : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0 && n < 65536);
        if (!ports.length) throw new SessionError(400, 'ports: list the localhost ports to share, e.g. [3000]');
        if (ports.length > config.tunnelMaxPorts) throw new SessionError(400, `at most ${config.tunnelMaxPorts} ports per tunnel`);
        audit({ action: 'tunnel.ticket', user: who.user, session: s.id, ip, detail: ports.join(',') });
        sendJson(res, 200, { ticket: issueTicket(s.id, ports), path: `${config.basePath}/tunnel`, ports });
        return;
      }
    }

    // ---- auth profiles (strictly per user) ----
    if (p === '/api/profiles' && method === 'GET') { sendJson(res, 200, { profiles: listProfiles(who.user) }); return; }
    if (p === '/api/profiles' && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.name !== 'string') throw new SessionError(400, 'body needs "name"');
      let state;
      if (body.sessionId) {
        const s = getSession(String(body.sessionId), who);
        if (s.owner !== who.user) throw new SessionError(403, 'only the session owner can save its auth state');
        state = await exportAuthState(s, who, body.origins);
      } else {
        const auth = await resolveAuth(who, body);
        if (!auth) throw new SessionError(400, 'body needs "sessionId" or "authState"');
        state = auth.state;
      }
      const meta = saveProfile(who.user, body.name, state);
      audit({ action: 'profile.save', user: who.user, ip, detail: body.name });
      sendJson(res, 201, { profile: meta });
      return;
    }
    const pm = /^\/api\/profiles\/([^/]+)$/.exec(p);
    if (pm && method === 'DELETE') {
      deleteProfile(who.user, decodeURIComponent(pm[1]));
      audit({ action: 'profile.delete', user: who.user, ip, detail: pm[1] });
      sendJson(res, 200, { deleted: pm[1] });
      return;
    }

    sendJson(res, 404, { error: `no route: ${method} ${p}` });
  } catch (err) {
    sendError(res, err);
  }
}
