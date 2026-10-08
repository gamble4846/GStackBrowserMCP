// Saved auth profiles (plan §4.10): strictly per user (decision A18), encrypted at rest with
// AES-256-GCM using AUTH_PROFILE_KEY. Admins can list and delete them but never read them.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '../config';
import { SessionError } from './sessionManager';
import { summarize, type AuthState } from './authState';

const root = path.join(config.dataDir, 'profiles');
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

let key: Buffer | null = null;
function getKey(): Buffer {
  if (key) return key;
  const raw = config.authProfileKey;
  if (!raw) throw new SessionError(503, 'saved auth profiles are disabled: AUTH_PROFILE_KEY is not set on the server');
  // Accept 32 raw bytes as base64/hex, or derive from a passphrase.
  const b64 = /^[A-Za-z0-9+/_-]{43,44}=?$/.test(raw) ? Buffer.from(raw, 'base64') : null;
  const hex = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : null;
  key = (b64?.length === 32 ? b64 : null) ?? (hex?.length === 32 ? hex : null) ?? crypto.createHash('sha256').update(raw).digest();
  return key;
}

function userDir(user: string): string {
  return path.join(root, crypto.createHash('sha256').update(user).digest('hex').slice(0, 24));
}

export interface ProfileMeta {
  name: string; owner: string; createdAt: string; updatedAt: string;
  cookieCount: number; originCount: number; earliestExpiry: string | null;
  expiresSoon: boolean; expired: boolean;
}

function withFlags(m: Omit<ProfileMeta, 'expiresSoon' | 'expired'>): ProfileMeta {
  const t = m.earliestExpiry ? Date.parse(m.earliestExpiry) : Infinity;
  return { ...m, expired: t < Date.now(), expiresSoon: t >= Date.now() && t < Date.now() + 86_400_000 };
}

export function saveProfile(user: string, name: string, state: AuthState): ProfileMeta {
  if (!NAME_RE.test(name)) throw new SessionError(400, 'profile name: letters, digits, "_", "-", "." (max 64)');
  const dir = userDir(user);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  cipher.setAAD(Buffer.from(`${user}\n${name}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
  const metaPath = path.join(dir, `${name}.meta.json`);
  const prev = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  const s = summarize(state);
  const now = new Date().toISOString();
  const meta = { name, owner: user, createdAt: prev?.createdAt ?? now, updatedAt: now, cookieCount: s.cookieCount, originCount: s.originCount, earliestExpiry: s.earliestExpiry };
  fs.writeFileSync(path.join(dir, `${name}.enc`), JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
  fs.writeFileSync(metaPath, JSON.stringify(meta), { mode: 0o600 });
  return withFlags(meta);
}

export function loadProfile(user: string, name: string): AuthState {
  if (!NAME_RE.test(name)) throw new SessionError(400, 'invalid profile name');
  const file = path.join(userDir(user), `${name}.enc`);
  if (!fs.existsSync(file)) throw new SessionError(404, `auth profile "${name}" not found`);
  const box = JSON.parse(fs.readFileSync(file, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(box.iv, 'base64'));
  decipher.setAAD(Buffer.from(`${user}\n${name}`));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  try {
    return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
  } catch {
    throw new SessionError(500, `auth profile "${name}" cannot be decrypted (was AUTH_PROFILE_KEY changed?)`);
  }
}

export function listProfiles(user: string | null): ProfileMeta[] {
  if (!fs.existsSync(root)) return [];
  const dirs = user ? [userDir(user)] : fs.readdirSync(root).map((d) => path.join(root, d));
  const out: ProfileMeta[] = [];
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.meta.json')) continue;
      try { out.push(withFlags(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')))); } catch { /* skip corrupt */ }
    }
  }
  return out.sort((a, b) => a.owner.localeCompare(b.owner) || a.name.localeCompare(b.name));
}

export function deleteProfile(user: string, name: string): void {
  if (!NAME_RE.test(name)) throw new SessionError(400, 'invalid profile name');
  const dir = userDir(user);
  const enc = path.join(dir, `${name}.enc`);
  if (!fs.existsSync(enc)) throw new SessionError(404, `auth profile "${name}" not found`);
  fs.rmSync(enc, { force: true });
  fs.rmSync(path.join(dir, `${name}.meta.json`), { force: true });
}
