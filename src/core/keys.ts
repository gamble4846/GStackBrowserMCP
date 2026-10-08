// Per-user API keys (plan §4.9). keys.json stores only SHA-256 hashes:
//   { "keys": { "<sha256 hex of key>": { "user": "rohan", "role": "admin", "maxSessions": 3 } } }
// The file is re-read when it changes (polling: it is bind-mounted from Windows, where inotify does not cross).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from '../config';
import { log } from './log';

export type Role = 'user' | 'admin';
export interface Principal {
  user: string;
  role: Role;
  maxSessions: number;
  keyId: string; // first 8 hex chars of the hash, safe to log
}
interface KeyEntry { user: string; role?: Role; maxSessions?: number; disabled?: boolean }

let entries = new Map<string, KeyEntry>();
let lastMtime = 0;

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

function load(): void {
  try {
    const st = fs.statSync(config.keysFile);
    if (st.mtimeMs === lastMtime) return;
    lastMtime = st.mtimeMs;
    const raw = JSON.parse(fs.readFileSync(config.keysFile, 'utf8').replace(/^﻿/, ''));
    const next = new Map<string, KeyEntry>();
    for (const [hash, e] of Object.entries<KeyEntry>(raw.keys ?? {})) {
      if (!/^[0-9a-f]{64}$/.test(hash) || !e?.user) continue;
      next.set(hash, e);
    }
    entries = next;
    log.info('keys', `loaded ${entries.size} keys from ${config.keysFile}`);
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      if (entries.size || lastMtime !== -1) log.warn('keys', `${config.keysFile} not found: no API keys accepted`);
      entries = new Map();
      lastMtime = -1;
    } else {
      log.error('keys', `cannot read ${config.keysFile}: ${err?.message ?? err} (keeping previous keys)`);
    }
  }
}

export function startKeyWatcher(): void {
  load();
  setInterval(load, 5000).unref();
}

export function authenticate(key: string | undefined | null): Principal | null {
  if (!key || key.length < 20) return null;
  const hash = hashKey(key);
  const e = entries.get(hash);
  if (!e || e.disabled) return null;
  return {
    user: e.user,
    role: e.role === 'admin' ? 'admin' : 'user',
    maxSessions: e.maxSessions && e.maxSessions > 0 ? e.maxSessions : config.defaultUserMaxSessions,
    keyId: hash.slice(0, 8),
  };
}

export function bearer(header: string | undefined | null): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

// ---- lockout: N failures per IP within a window → temporary block ----
const failures = new Map<string, number[]>();

export function isLockedOut(ip: string): boolean {
  const now = Date.now();
  const list = (failures.get(ip) ?? []).filter((t) => now - t < config.authLockout.windowMs);
  failures.set(ip, list);
  return list.length >= config.authLockout.attempts;
}
export function recordAuthFailure(ip: string): void {
  const list = failures.get(ip) ?? [];
  list.push(Date.now());
  failures.set(ip, list);
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, list] of failures) if (!list.some((t) => now - t < config.authLockout.windowMs)) failures.delete(ip);
}, 60_000).unref();
