// All runtime configuration, read once from the environment (plan §5).
import fs from 'node:fs';

function int(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}
function str(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function list(name: string): string[] {
  return (process.env[name] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}
function secret(name: string): string {
  const fileVar = process.env[`${name}_FILE`];
  if (fileVar && fs.existsSync(fileVar)) return fs.readFileSync(fileVar, 'utf8').trim();
  return process.env[name] ?? '';
}

export const config = {
  apiPort: int('API_PORT', 8080),
  adminPort: int('ADMIN_PORT', 8081),
  basePath: str('BASE_PATH', '/gstack').replace(/\/+$/, ''),
  dataDir: str('DATA_DIR', '/data'),
  keysFile: str('KEYS_FILE', '/config/keys.json'),

  browsePath: str('BROWSE_BIN', '/opt/gstack/browse/dist/browse'),
  playwrightBrowsersPath: str('PLAYWRIGHT_BROWSERS_PATH', '/opt/playwright-browsers'),

  maxSessions: int('MAX_SESSIONS', 10),
  defaultUserMaxSessions: int('DEFAULT_USER_MAX_SESSIONS', 3),
  minFreeMemoryMb: int('MIN_FREE_MEMORY_MB', 500),
  sessionIdleTimeoutMs: int('SESSION_IDLE_TIMEOUT', 15 * 60 * 1000),
  sessionStartTimeoutMs: int('SESSION_START_TIMEOUT', 45_000),
  execTimeoutMs: int('EXEC_TIMEOUT', 60_000),

  // Session processes run as dedicated Linux users gsess01..gsessNN (created in the image).
  sessionUidBase: int('SESSION_UID_BASE', 20000),
  sessionUserPrefix: str('SESSION_USER_PREFIX', 'gsess'),
  sessionUserSlots: int('SESSION_USER_SLOTS', 32),
  browsePortBase: int('BROWSE_PORT_BASE', 41000),
  sessionProxyPortBase: int('SESSION_PROXY_PORT_BASE', 42000),

  egressProxyUrl: str('EGRESS_PROXY_URL', 'http://egress-proxy:4750'),
  egressToken: secret('EGRESS_TOKEN'),
  allowedUrlPatterns: list('ALLOWED_URL_PATTERNS'),
  trustProxy: list('TRUST_PROXY'),
  authLockout: (() => {
    const [n, w] = str('AUTH_LOCKOUT', '10/5m').split('/');
    const m = /^(\d+)([smh])$/.exec(w ?? '5m');
    const mult = m ? { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'] : 60_000;
    return { attempts: parseInt(n, 10) || 10, windowMs: (m ? parseInt(m[1], 10) : 5) * mult };
  })(),
  tunnelMaxPorts: int('TUNNEL_MAX_PORTS', 5),

  authProfileKey: secret('AUTH_PROFILE_KEY'),
  authStateMaxBytes: int('AUTH_STATE_MAX_BYTES', 5 * 1024 * 1024),
  uploadMaxBytes: int('UPLOAD_MAX_BYTES', 50 * 1024 * 1024),
  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 30),
  liveViewMode: str('LIVEVIEW_MODE', 'poll') as 'poll' | 'off',
};

export type Config = typeof config;
