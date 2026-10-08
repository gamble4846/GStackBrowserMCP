// Runs the upstream gstack `browse` CLI for one session, as that session's own Linux user
// (plan §4.2, spike change 2). stdout is returned unchanged so callers see exactly what a
// local `$B` would print.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config';

export interface SlotIdentity {
  user: string;          // Linux user, e.g. gsess03
  dir: string;           // /data/sessions/<id>
  browsePort: number;
  authToken: string;     // daemon root token for this session (never leaves the container)
  proxyUrl: string;      // per-session proxy (plan §4.9)
  extraEnv?: Record<string, string>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  files: string[];       // files created/changed under the session dir by this command (relative)
}

const MAX_OUTPUT = 20 * 1024 * 1024;
// Folders inside the session dir that are internal, never reported as output files.
const INTERNAL_DIRS = new Set(['home', 'tmp', '.gstack', 'auth']);

export function sessionEnv(id: SlotIdentity): Record<string, string> {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(id.dir, 'home'),
    TMPDIR: path.join(id.dir, 'tmp'),
    LANG: 'C.UTF-8',
    CONTAINER: '1',
    GSTACK_TELEMETRY_OFF: '1',
    GSTACK_SKIP_ASIDE: '1',
    PLAYWRIGHT_BROWSERS_PATH: config.playwrightBrowsersPath,
    BROWSE_STATE_FILE: path.join(id.dir, '.gstack', 'browse.json'),
    BROWSE_PARENT_PID: '0',
    BROWSE_PORT: String(id.browsePort),
    AUTH_TOKEN: id.authToken,
    BROWSE_PROXY_URL: id.proxyUrl,
    // Our reaper owns idle shutdown; keep gstack's own timer well beyond it.
    BROWSE_IDLE_TIMEOUT: String(config.sessionIdleTimeoutMs + 10 * 60_000),
    BROWSE_START_TIMEOUT: String(config.sessionStartTimeoutMs),
    ...(id.extraEnv ?? {}),
  };
}

type Snapshot = Map<string, number>;
function snapshotFiles(root: string): Snapshot {
  const out: Snapshot = new Map();
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 6) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (depth === 0 && INTERNAL_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r, depth + 1);
      else if (e.isFile()) { try { out.set(r, fs.statSync(abs).mtimeMs); } catch { /* raced */ } }
    }
  };
  walk(root, '', 0);
  return out;
}

export function runBrowse(
  id: SlotIdentity,
  args: string[],
  opts: { stdin?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const before = snapshotFiles(id.dir);
  const started = Date.now();
  const env = sessionEnv(id);
  // runuser drops to the session user; `env -i` gives the CLI exactly our environment.
  const envArgs = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  const script = 'cd "$1" && umask 077 && shift && exec "$0" "$@"';
  const child = spawn('runuser', ['-u', id.user, '--', 'env', '-i', ...envArgs,
    'bash', '-c', script, config.browsePath, id.dir, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timeoutMs = opts.timeoutMs ?? config.execTimeoutMs;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { if (stdout.length < MAX_OUTPUT) stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { if (stderr.length < MAX_OUTPUT) stderr += d.toString('utf8'); });
    child.on('error', (err) => { stderr += `\n[gstack-browser-mcp] failed to run browse: ${err.message}`; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const after = snapshotFiles(id.dir);
      const files: string[] = [];
      for (const [f, m] of after) if (before.get(f) !== m) files.push(f);
      if (timedOut) stderr += `\n[gstack-browser-mcp] command timed out after ${timeoutMs} ms`;
      resolve({
        exitCode: timedOut ? 124 : (code ?? 1),
        // The CLI prints "[browse] Starting server..." on cold start; it is noise for callers.
        stdout: stdout.replace(/^\[browse\] Starting server\.\.\.\r?\n/m, ''),
        stderr,
        durationMs: Date.now() - started,
        timedOut,
        files,
      });
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin); else child.stdin.end();
  });
}

/** Run a plain command (no session env) and wait; used for cleanup. */
export function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<number> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { stdio: 'ignore' });
    const t = setTimeout(() => c.kill('SIGKILL'), timeoutMs);
    c.on('error', () => { clearTimeout(t); resolve(127); });
    c.on('close', (code) => { clearTimeout(t); resolve(code ?? 1); });
  });
}
