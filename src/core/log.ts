// Process logging (stdout, for `docker logs`) and the audit log (JSON lines in /data/logs, plan §4.9).
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

function line(level: string, scope: string, msg: string): void {
  process.stdout.write(`${new Date().toISOString()} ${level} [${scope}] ${msg}\n`);
}
export const log = {
  info: (scope: string, msg: string) => line('INFO ', scope, msg),
  warn: (scope: string, msg: string) => line('WARN ', scope, msg),
  error: (scope: string, msg: string) => line('ERROR', scope, msg),
};

export interface AuditEvent {
  ts?: string;
  user?: string;
  keyId?: string;
  ip?: string;
  session?: string;
  via?: 'api' | 'mcp' | 'admin' | 'system';
  action: string;           // e.g. "exec", "session.create", "auth.fail"
  command?: string;
  args?: string[];          // already redacted
  ok?: boolean;
  exitCode?: number;
  durationMs?: number;
  detail?: string;
}

const logDir = path.join(config.dataDir, 'logs');
let currentDay = '';
let stream: fs.WriteStream | null = null;

function rotate(): fs.WriteStream {
  const day = new Date().toISOString().slice(0, 10);
  if (stream && day === currentDay) return stream;
  stream?.end();
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  currentDay = day;
  stream = fs.createWriteStream(path.join(logDir, `audit-${day}.jsonl`), { flags: 'a', mode: 0o600 });
  pruneOld();
  return stream;
}
function pruneOld(): void {
  const cutoff = Date.now() - config.auditRetentionDays * 86_400_000;
  for (const f of fs.readdirSync(logDir)) {
    const m = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (m && Date.parse(m[1]) < cutoff) fs.rmSync(path.join(logDir, f), { force: true });
  }
}

type Listener = (e: AuditEvent) => void;
const listeners = new Set<Listener>();
export function onAudit(fn: Listener): () => void { listeners.add(fn); return () => listeners.delete(fn); }

export function audit(e: AuditEvent): void {
  const ev = { ts: new Date().toISOString(), ...e };
  try { rotate().write(JSON.stringify(ev) + '\n'); } catch (err: any) { log.error('audit', String(err?.message ?? err)); }
  for (const fn of listeners) { try { fn(ev); } catch { /* listener errors never break auditing */ } }
}
