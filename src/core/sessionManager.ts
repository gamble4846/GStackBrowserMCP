// Session lifecycle (plan §4.1). One session = one gstack daemon + Chromium, running as its own
// Linux user with a brand-new profile in /data/sessions/<id>. Deleting a session wipes everything.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { config } from '../config';
import { runBrowse, run, type ExecResult, type SlotIdentity } from './exec';
import { startSessionProxy, type SessionProxy } from './sessionProxy';
import { closeTunnel, tunnelInfo } from './tunnel';
import { canonical, deniedReason, isWellFormed, redactArgs, validateNested } from './commandCatalog';
import { audit, log } from './log';
import type { Principal } from './keys';

export type SessionStatus = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed';

export interface SessionOptions {
  viewport?: string;          // "1280x720"
  stealth?: 'default' | 'extended';
  label?: string;
}

export interface Session {
  id: string;
  owner: string;              // user name from keys.json
  ownerKeyId: string;
  via: 'api' | 'mcp' | 'admin';
  label?: string;
  slot: number;
  status: SessionStatus;
  error?: string;
  createdAt: number;
  lastActivityAt: number;
  currentUrl: string;
  commandCount: number;
  busy: boolean;
  options: SessionOptions;
  ident: SlotIdentity;
  proxy?: SessionProxy;
  queue: Promise<unknown>;
  ready: Promise<void>;
}

export class SessionError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export const events = new EventEmitter();
events.setMaxListeners(100);

const sessions = new Map<string, Session>();
const sessionsRoot = path.join(config.dataDir, 'sessions');

function slotUser(slot: number): string { return `${config.sessionUserPrefix}${String(slot).padStart(2, '0')}`; }
function slotUid(slot: number): number { return config.sessionUidBase + slot; }

function newId(): string {
  return 'gs_' + crypto.randomBytes(9).toString('base64url').replace(/[-_]/g, 'x').toLowerCase();
}

export function publicView(s: Session) {
  return {
    id: s.id,
    owner: s.owner,
    via: s.via,
    label: s.label,
    status: s.status,
    error: s.error,
    createdAt: new Date(s.createdAt).toISOString(),
    lastActivityAt: new Date(s.lastActivityAt).toISOString(),
    idleSeconds: Math.round((Date.now() - s.lastActivityAt) / 1000),
    currentUrl: s.currentUrl,
    commandCount: s.commandCount,
    busy: s.busy,
    tunnel: tunnelInfo(s.id),
  };
}

function emit(type: string, s: Session) { events.emit('session', { type, session: publicView(s) }); }

// ---------- memory guard ----------
export function memoryInfo(): { usedMb: number; limitMb: number; freeMb: number } {
  try {
    const cur = Number(fs.readFileSync('/sys/fs/cgroup/memory.current', 'utf8'));
    const maxRaw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
    const limit = maxRaw === 'max' ? os.totalmem() : Number(maxRaw);
    return { usedMb: Math.round(cur / 1048576), limitMb: Math.round(limit / 1048576), freeMb: Math.round((limit - cur) / 1048576) };
  } catch {
    return { usedMb: Math.round((os.totalmem() - os.freemem()) / 1048576), limitMb: Math.round(os.totalmem() / 1048576), freeMb: Math.round(os.freemem() / 1048576) };
  }
}

// ---------- URL rules for goto/newtab (app-level; the egress proxy is the real wall) ----------
const PRIVATE_LITERAL = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[?f[cd][0-9a-f]{2}:|\[?fe80:)/i;
function globToRe(g: string): RegExp {
  return new RegExp('^' + g.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}
const allowRes = config.allowedUrlPatterns.map(globToRe);
export function isUrlAllowed(url: string): boolean {
  if (!allowRes.length) return true;
  return allowRes.some((re) => re.test(url));
}
function checkNavigationTarget(command: string, args: string[]): string | null {
  if (command !== 'goto' && command !== 'newtab') return null;
  const target = args.find((a) => !a.startsWith('-'));
  if (!target) return null;
  let u: URL;
  try { u = new URL(target); } catch { return null; }
  if (u.protocol === 'file:') return 'file:// URLs are not allowed on the remote browser.';
  if (PRIVATE_LITERAL.test(u.hostname)) return `${u.hostname} is a private network address and is blocked. Use localhost:<port> with a tunnel to reach your own machine.`;
  if (!['http:', 'https:', 'about:', 'data:'].includes(u.protocol)) return `${u.protocol} URLs are not allowed.`;
  if ((u.protocol === 'http:' || u.protocol === 'https:') && !/^(localhost|127\.)/.test(u.hostname) && !isUrlAllowed(u.href)) {
    return `${u.href} is not in ALLOWED_URL_PATTERNS.`;
  }
  return null;
}

// ---------- lifecycle ----------
function isLive(s: Session): boolean { return s.status !== 'stopped' && s.status !== 'failed'; }

export function getSession(id: string, who: Principal | 'system'): Session {
  const s = sessions.get(id);
  if (!s || s.status === 'stopped') throw new SessionError(404, `session ${id} not found`);
  if (who !== 'system' && who.role !== 'admin' && s.owner !== who.user) throw new SessionError(404, `session ${id} not found`);
  return s;
}

export function listSessions(who: Principal | 'system') {
  return [...sessions.values()]
    .filter((s) => s.status !== 'stopped')
    .filter((s) => who === 'system' || who.role === 'admin' || s.owner === who.user)
    .map(publicView);
}

export function usage() {
  const live = [...sessions.values()].filter(isLive);
  return { active: live.length, max: config.maxSessions, memory: memoryInfo() };
}

export async function createSession(who: Principal, via: Session['via'], options: SessionOptions = {}, afterStart?: (s: Session) => Promise<void>): Promise<Session> {
  const live = [...sessions.values()].filter(isLive);
  const mine = live.filter((s) => s.owner === who.user);
  if (mine.length >= who.maxSessions) {
    throw new SessionError(429, `you already have ${mine.length} of your ${who.maxSessions} sessions running: ${mine.map((s) => s.id).join(', ')}. Delete one first.`);
  }
  if (live.length >= config.maxSessions) {
    throw new SessionError(429, `the server is at its limit of ${config.maxSessions} sessions (${live.length} in use). Try again later.`);
  }
  const mem = memoryInfo();
  if (mem.freeMb < config.minFreeMemoryMb) {
    throw new SessionError(503, `the server is low on memory (${mem.freeMb} MB free). Try again later.`);
  }
  const used = new Set(live.map((s) => s.slot));
  let slot = 0;
  for (let i = 1; i <= Math.min(config.maxSessions, config.sessionUserSlots); i++) if (!used.has(i)) { slot = i; break; }
  if (!slot) throw new SessionError(429, 'no free session slot');
  if (options.viewport && !/^\d{2,4}x\d{2,4}$/.test(options.viewport)) throw new SessionError(400, 'viewport must look like 1280x720');

  const id = newId();
  const dir = path.join(sessionsRoot, id);
  const ident: SlotIdentity = {
    user: slotUser(slot),
    dir,
    browsePort: config.browsePortBase + slot,
    authToken: crypto.randomBytes(24).toString('hex'),
    proxyUrl: `http://127.0.0.1:${config.sessionProxyPortBase + slot}`,
    extraEnv: options.stealth === 'extended' ? { GSTACK_STEALTH: 'extended' } : {},
  };
  const now = Date.now();
  const s: Session = {
    id, owner: who.user, ownerKeyId: who.keyId, via, label: options.label?.slice(0, 80), slot,
    status: 'starting', createdAt: now, lastActivityAt: now, currentUrl: 'about:blank',
    commandCount: 0, busy: false, options, ident, queue: Promise.resolve(), ready: Promise.resolve(),
  };
  sessions.set(id, s);
  emit('created', s);
  audit({ action: 'session.create', user: who.user, keyId: who.keyId, session: id, via });

  s.ready = (async () => {
    try {
      await wipeSlot(slot);
      fs.mkdirSync(dir, { recursive: true });
      for (const sub of ['home', 'tmp', '.gstack', 'files']) fs.mkdirSync(path.join(dir, sub), { recursive: true });
      await run('chown', ['-R', `${ident.user}:${ident.user}`, dir]);
      fs.chmodSync(dir, 0o700);
      s.proxy = await startSessionProxy(id, config.sessionProxyPortBase + slot, slotUid(slot), isUrlAllowed);
      const st = await runBrowse(ident, ['status'], { timeoutMs: config.sessionStartTimeoutMs + 5000 });
      if (st.exitCode !== 0 || !/healthy/i.test(st.stdout)) throw new Error(`browser failed to start: ${(st.stderr || st.stdout).trim().slice(0, 500)}`);
      if (options.viewport) await runBrowse(ident, ['viewport', options.viewport]);
      if (afterStart) await afterStart(s);
      s.status = 'ready';
      s.lastActivityAt = Date.now();
      emit('ready', s);
      log.info('session', `${id} ready (owner ${s.owner}, slot ${slot})`);
    } catch (err: any) {
      s.status = 'failed';
      s.error = String(err?.message ?? err);
      emit('failed', s);
      log.error('session', `${id} failed to start: ${s.error}`);
      audit({ action: 'session.failed', user: who.user, session: id, detail: s.error });
      void destroy(s, 'start failed');
    }
  })();
  return s;
}

/** Wait (up to timeoutMs) until the session leaves "starting". */
export async function waitReady(s: Session, timeoutMs: number): Promise<void> {
  if (s.status !== 'starting') return;
  await Promise.race([s.ready, new Promise((r) => setTimeout(r, timeoutMs))]);
}

export interface ExecRequest {
  command: string;
  args?: string[];
  stdin?: string;
  timeoutMs?: number;
  via: 'api' | 'mcp' | 'admin';
  ip?: string;
  internal?: boolean;       // server-initiated (auth apply, live view): skips the deny list
  quiet?: boolean;          // don't audit / count as activity (live-view polling)
}

export async function execInSession(s: Session, who: Principal | 'system', req: ExecRequest): Promise<ExecResult> {
  const command = canonical(req.command);
  const args = (req.args ?? []).map(String);
  if (!isWellFormed(command)) throw new SessionError(400, `invalid command: ${req.command}`);
  if (!req.internal) {
    const why = deniedReason(command);
    if (why) throw new SessionError(403, `${command}: ${why}`);
    const nav = checkNavigationTarget(command, args);
    if (nav) throw new SessionError(403, nav);
    if ((command === 'chain' || command === 'batch') && req.stdin !== undefined) {
      let parsed: unknown;
      try { parsed = JSON.parse(req.stdin); } catch { throw new SessionError(400, `${command}: stdin must be JSON`); }
      const nested = validateNested(command === 'batch' ? (parsed as any)?.commands ?? parsed : parsed);
      if (nested) throw new SessionError(403, nested);
    }
    for (const a of args) {
      if (a.startsWith('/') && !a.startsWith(s.ident.dir + '/') && !a.startsWith('/tmp/')) {
        throw new SessionError(403, `paths must be inside the session (relative paths are fine): ${a}`);
      }
    }
  }
  if (s.status === 'starting' && !req.internal) await waitReady(s, config.sessionStartTimeoutMs * 3);
  if (s.status !== 'ready' && !(req.internal && s.status === 'starting')) throw new SessionError(409, `session ${s.id} is ${s.status}${s.error ? `: ${s.error}` : ''}`);

  const job = s.queue.then(async () => {
    s.busy = true;
    if (!req.quiet) emit('busy', s);
    try {
      return await runBrowse(s.ident, [command, ...args], { stdin: req.stdin, timeoutMs: req.timeoutMs });
    } finally {
      s.busy = false;
    }
  });
  s.queue = job.catch(() => undefined);
  const res = await job;

  const nav = /^Navigated to (\S+)/m.exec(res.stdout);
  if (nav) s.currentUrl = nav[1];
  if (!req.quiet) {
    s.lastActivityAt = Date.now();
    s.commandCount++;
    emit('updated', s);
    const ev = {
      action: 'exec', session: s.id, via: req.via, ip: req.ip, command,
      args: redactArgs(command, args), ok: res.exitCode === 0, exitCode: res.exitCode, durationMs: res.durationMs,
      user: who === 'system' ? 'system' : who.user, keyId: who === 'system' ? undefined : who.keyId,
    } as const;
    audit(ev);
    events.emit('exec', { ...ev, sessionOwner: s.owner, outputPreview: res.stdout.slice(0, 400), error: res.exitCode ? res.stderr.slice(0, 400) : undefined });
  }
  return res;
}

export async function deleteSession(id: string, who: Principal | 'system', reason = 'deleted'): Promise<void> {
  const s = getSession(id, who);
  audit({ action: 'session.delete', session: id, user: who === 'system' ? 'system' : who.user, detail: reason });
  await destroy(s, reason);
}

async function destroy(s: Session, reason: string): Promise<void> {
  if (s.status === 'stopping' || s.status === 'stopped') return;
  const wasFailed = s.status === 'failed';
  s.status = 'stopping';
  emit('stopping', s);
  closeTunnel(s.id);
  await s.queue.catch(() => undefined);
  try { await runBrowse(s.ident, ['stop'], { timeoutMs: 10_000 }); } catch { /* killed below anyway */ }
  await s.proxy?.close().catch(() => undefined);
  await wipeSlot(s.slot);
  fs.rmSync(s.ident.dir, { recursive: true, force: true });
  if (wasFailed) { s.status = 'failed'; setTimeout(() => sessions.delete(s.id), 10 * 60_000).unref(); }
  else { s.status = 'stopped'; sessions.delete(s.id); }
  emit('deleted', s);
  log.info('session', `${s.id} removed (${reason})`);
}

/** Kill every process of a slot user and remove its files outside the session dir. */
async function wipeSlot(slot: number): Promise<void> {
  const user = slotUser(slot);
  await run('pkill', ['-KILL', '-u', user]);
  await new Promise((r) => setTimeout(r, 300));
  for (const dir of ['/tmp', '/dev/shm', '/var/tmp']) {
    await run('find', [dir, '-xdev', '-user', user, '-delete']);
  }
}

export async function startupCleanup(): Promise<void> {
  fs.mkdirSync(sessionsRoot, { recursive: true });
  // 711: session users may enter their own folder (itself 700) but cannot list the others.
  fs.chmodSync(sessionsRoot, 0o711);
  fs.chmodSync(config.dataDir, 0o711);
  for (let i = 1; i <= config.sessionUserSlots; i++) await wipeSlot(i);
  for (const d of fs.readdirSync(sessionsRoot)) fs.rmSync(path.join(sessionsRoot, d), { recursive: true, force: true });
  log.info('session', 'startup: wiped leftover sessions');
}

export function startReaper(): void {
  setInterval(() => {
    const now = Date.now();
    for (const s of sessions.values()) {
      if (s.status === 'ready' && !s.busy && now - s.lastActivityAt > config.sessionIdleTimeoutMs) {
        log.info('session', `${s.id} idle for ${Math.round((now - s.lastActivityAt) / 60000)} min: removing`);
        audit({ action: 'session.reaped', session: s.id, user: 'system' });
        void destroy(s, 'idle timeout');
      }
    }
  }, 30_000).unref();
}

export async function shutdownAll(): Promise<void> {
  await Promise.all([...sessions.values()].map((s) => destroy(s, 'server shutdown').catch(() => undefined)));
}

/** Mark activity without running a command (e.g. client keep-alive). */
export function touch(s: Session): void { s.lastActivityAt = Date.now(); }
