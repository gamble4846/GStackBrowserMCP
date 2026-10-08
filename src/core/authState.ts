// Logged-in sessions: cookies + localStorage + sessionStorage (plan §4.10, spike change 1).
// Import uses gstack's `cookie-import` (keeps httpOnly/secure/sameSite/expires, and unlike
// `state load` does not drop localhost cookies) after navigating to each site, then sets
// storage with `eval`, then reloads. Export uses `state save` (unredacted cookies) + `eval`.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';
import { run } from './exec';
import { execInSession, SessionError, type Session } from './sessionManager';
import type { Principal } from './keys';

export interface Cookie {
  name: string; value: string; domain: string; path: string;
  expires: number; httpOnly: boolean; secure: boolean; sameSite: 'Strict' | 'Lax' | 'None';
}
export interface OriginState {
  origin: string;
  localStorage: { name: string; value: string }[];
  sessionStorage: { name: string; value: string }[];
  landingPath?: string;
}
export interface AuthState { cookies: Cookie[]; origins: OriginState[] }

// ---------- normalisation of the accepted formats ----------
function normSameSite(v: unknown, secure: boolean): Cookie['sameSite'] {
  const s = String(v ?? '').toLowerCase();
  if (s === 'strict') return 'Strict';
  if (s === 'none' || s === 'no_restriction') return secure ? 'None' : 'Lax';
  return 'Lax';
}

function normCookie(c: any): Cookie | null {
  if (!c || typeof c.name !== 'string' || c.value === undefined || typeof c.domain !== 'string' || !c.domain) return null;
  const secure = Boolean(c.secure);
  let expires = -1;
  const e = c.expires ?? c.expirationDate ?? c.expiry;
  if (typeof e === 'number' && e > 0 && !c.session) expires = e > 1e11 ? Math.floor(e / 1000) : Math.floor(e);
  let domain = String(c.domain).trim().toLowerCase();
  if (c.hostOnly === true) domain = domain.replace(/^\./, '');
  return {
    name: c.name, value: String(c.value), domain, path: typeof c.path === 'string' && c.path ? c.path : '/',
    expires, httpOnly: Boolean(c.httpOnly), secure, sameSite: normSameSite(c.sameSite, secure),
  };
}

function kv(v: unknown): { name: string; value: string }[] {
  if (Array.isArray(v)) return v.filter((x) => x && typeof x.name === 'string').map((x) => ({ name: x.name, value: String(x.value ?? '') }));
  if (v && typeof v === 'object') return Object.entries(v as Record<string, unknown>).map(([name, value]) => ({ name, value: typeof value === 'string' ? value : JSON.stringify(value) }));
  return [];
}

function normOrigin(o: string): string {
  const u = new URL(o);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`origin must be http(s): ${o}`);
  return u.origin;
}

export interface NormalizeResult { state: AuthState; warnings: string[] }

/** Accepts Playwright storageState (+sessionStorage), gstack cookie JSON / state files,
 *  Cookie-Editor / EditThisCookie exports, and {origin, localStorage:{...}} maps. */
export function normalizeAuthState(input: unknown, originHint?: string): NormalizeResult {
  const warnings: string[] = [];
  let rawCookies: unknown[] = [];
  const origins: OriginState[] = [];
  const data: any = typeof input === 'string' ? JSON.parse(input) : input;

  if (Array.isArray(data)) rawCookies = data;                       // gstack / Cookie-Editor / EditThisCookie
  else if (data && typeof data === 'object') {
    if (Array.isArray(data.cookies)) rawCookies = data.cookies;      // Playwright storageState / gstack state file
    if (Array.isArray(data.origins)) {
      for (const o of data.origins) {
        if (!o?.origin) continue;
        origins.push({
          origin: normOrigin(o.origin), localStorage: kv(o.localStorage), sessionStorage: kv(o.sessionStorage),
          landingPath: typeof o.landingPath === 'string' && o.landingPath.startsWith('/') ? o.landingPath : undefined,
        });
      }
    }
    if (!Array.isArray(data.origins) && (data.localStorage || data.sessionStorage)) {
      const o = data.origin ?? originHint;
      if (!o) throw new Error('a localStorage map needs an "origin" (e.g. "https://app.example.com")');
      origins.push({ origin: normOrigin(o), localStorage: kv(data.localStorage), sessionStorage: kv(data.sessionStorage) });
    }
  } else throw new Error('auth state must be a JSON object or array');

  const now = Date.now() / 1000;
  const cookies: Cookie[] = [];
  for (const rc of rawCookies) {
    const c = normCookie(rc);
    if (!c) { warnings.push('skipped a malformed cookie'); continue; }
    if (c.expires > 0 && c.expires < now) { warnings.push(`dropped expired cookie ${c.name} (${c.domain})`); continue; }
    cookies.push(c);
  }
  if (cookies.length > 2000) throw new Error('too many cookies (max 2000)');
  if (origins.length > 200) throw new Error('too many origins (max 200)');
  if (!cookies.length && !origins.length) throw new Error('auth state has no cookies and no storage');
  return { state: { cookies, origins }, warnings };
}

export function summarize(state: AuthState) {
  const exp = state.cookies.filter((c) => c.expires > 0).map((c) => c.expires);
  return {
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
    hosts: [...new Set([...state.cookies.map((c) => c.domain.replace(/^\./, '')), ...state.origins.map((o) => new URL(o.origin).hostname)])],
    earliestExpiry: exp.length ? new Date(Math.min(...exp) * 1000).toISOString() : null,
  };
}

// ---------- apply ----------
const LOCAL = /^(localhost|127\.|\[?::1)/;
function originForCookie(c: Cookie, origins: OriginState[]): string {
  const d = c.domain.replace(/^\./, '');
  const match = origins.find((o) => { const h = new URL(o.origin).hostname; return h === d || h.endsWith('.' + d); });
  if (match) return match.origin;
  return `${c.secure || !LOCAL.test(d) ? 'https' : 'http'}://${d}`;
}

async function writeSessionFile(s: Session, name: string, content: string): Promise<string> {
  const dir = path.join(s.ident.dir, 'auth');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode: 0o600 });
  await run('chown', ['-R', `${s.ident.user}:${s.ident.user}`, dir]);
  return `auth/${name}`; // relative to the session's working directory
}

function storageScript(o: OriginState): string {
  const data = JSON.stringify({ l: o.localStorage, s: o.sessionStorage });
  return `(() => { const d = ${data}; for (const x of d.l) localStorage.setItem(x.name, x.value); for (const x of d.s) sessionStorage.setItem(x.name, x.value); return 'storage set: ' + d.l.length + ' local, ' + d.s.length + ' session'; })()`;
}

export interface ApplyReport { origins: { origin: string; cookies: number; localStorage: number; sessionStorage: number; ok: boolean; error?: string }[]; warnings: string[] }

export async function applyAuthState(s: Session, who: Principal | 'system', state: AuthState, opts: { returnTo?: string } = {}): Promise<ApplyReport> {
  const byOrigin = new Map<string, { cookies: Cookie[]; storage?: OriginState }>();
  for (const o of state.origins) byOrigin.set(o.origin, { cookies: [], storage: o });
  for (const c of state.cookies) {
    const o = originForCookie(c, state.origins);
    if (!byOrigin.has(o)) byOrigin.set(o, { cookies: [] });
    byOrigin.get(o)!.cookies.push(c);
  }
  const report: ApplyReport = { origins: [], warnings: [] };
  const ex = (command: string, args: string[]) => execInSession(s, who, { command, args, via: 'api', internal: true, quiet: true });
  const tag = crypto.randomBytes(4).toString('hex');
  let n = 0;
  try {
    for (const [origin, part] of byOrigin) {
      const entry = { origin, cookies: part.cookies.length, localStorage: part.storage?.localStorage.length ?? 0, sessionStorage: part.storage?.sessionStorage.length ?? 0, ok: true as boolean, error: undefined as string | undefined };
      try {
        const nav = await ex('goto', [origin + (part.storage?.landingPath ?? '/')]);
        if (nav.exitCode !== 0) throw new Error(`could not open ${origin}: ${(nav.stderr || nav.stdout).trim().slice(0, 200)}`);
        if (part.cookies.length) {
          const f = await writeSessionFile(s, `ck-${tag}-${n++}.json`, JSON.stringify(part.cookies));
          const r = await ex('cookie-import', [f]);
          if (r.exitCode !== 0) throw new Error(`cookie import failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
        }
        if (part.storage && (part.storage.localStorage.length || part.storage.sessionStorage.length)) {
          const f = await writeSessionFile(s, `st-${tag}-${n++}.js`, storageScript(part.storage));
          const r = await ex('eval', [f]);
          if (r.exitCode !== 0) throw new Error(`storage set failed: ${(r.stderr || r.stdout).trim().slice(0, 200)}`);
        }
        await ex('reload', []);
      } catch (err: any) {
        entry.ok = false; entry.error = String(err?.message ?? err);
      }
      report.origins.push(entry);
    }
  } finally {
    fs.rmSync(path.join(s.ident.dir, 'auth'), { recursive: true, force: true });
    await ex('goto', [opts.returnTo ?? 'about:blank']).catch(() => undefined);
  }
  return report;
}

// ---------- export ----------
export async function exportAuthState(s: Session, who: Principal | 'system', origins?: string[]): Promise<AuthState> {
  const ex = (command: string, args: string[]) => execInSession(s, who, { command, args, via: 'api', internal: true, quiet: true });
  const name = `x${crypto.randomBytes(6).toString('hex')}`;
  const saved = await ex('state', ['save', name]);
  if (saved.exitCode !== 0) throw new SessionError(500, `could not read cookies: ${(saved.stderr || saved.stdout).trim().slice(0, 200)}`);
  const file = path.join(s.ident.dir, '.gstack', 'browse-states', `${name}.json`);
  let raw: any;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } finally { fs.rmSync(file, { force: true }); }
  const cookies = (raw.cookies ?? []).map(normCookie).filter(Boolean) as Cookie[];

  const startUrl = s.currentUrl;
  const targets = origins?.length ? origins.map(normOrigin)
    : (/^https?:/.test(startUrl) ? [new URL(startUrl).origin] : []);
  const out: OriginState[] = [];
  const script = '(() => JSON.stringify({ l: Object.entries(localStorage).map(([name, value]) => ({ name, value })), s: Object.entries(sessionStorage).map(([name, value]) => ({ name, value })) }))()';
  const f = await writeSessionFile(s, `export-${name}.js`, script);
  try {
    for (const o of targets) {
      const here = /^https?:/.test(s.currentUrl) && new URL(s.currentUrl).origin === o;
      if (!here) { const nav = await ex('goto', [o + '/']); if (nav.exitCode !== 0) continue; }
      const r = await ex('eval', [f]);
      const m = /\{"l":[\s\S]*\}/.exec(r.stdout);
      if (r.exitCode !== 0 || !m) continue;
      const parsed = JSON.parse(m[0]);
      out.push({ origin: o, localStorage: parsed.l ?? [], sessionStorage: parsed.s ?? [] });
    }
  } finally {
    fs.rmSync(path.join(s.ident.dir, 'auth'), { recursive: true, force: true });
    if (/^https?:/.test(startUrl) && s.currentUrl !== startUrl) await ex('goto', [startUrl]).catch(() => undefined);
  }
  return { cookies, origins: out };
}

export function assertSize(body: string): void {
  if (Buffer.byteLength(body) > config.authStateMaxBytes) throw new SessionError(413, `auth state is larger than ${config.authStateMaxBytes} bytes`);
}
