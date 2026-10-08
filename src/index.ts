// gstack-browser-mcp entry point.
//   :8080  BASE_PATH/api/*   REST API (browse-remote, scripts)
//          BASE_PATH/mcp     MCP (Streamable HTTP)
//          BASE_PATH/tunnel  WebSocket reverse tunnel from developer laptops
//   :8081  admin UI (never published publicly)
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { config } from './config';
import { log } from './core/log';
import { startKeyWatcher } from './core/keys';
import { getSession, shutdownAll, startReaper, startupCleanup } from './core/sessionManager';
import { attachTunnel, redeemTicket } from './core/tunnel';
import { handleApi } from './api/routes';
import { handleMcp } from './mcp/server';
import { sendJson } from './api/http';
import { startAdminServer } from './admin/server';

function stripBase(pathname: string): string {
  if (config.basePath && (pathname === config.basePath || pathname.startsWith(config.basePath + '/'))) {
    return pathname.slice(config.basePath.length) || '/';
  }
  return pathname;
}

async function main() {
  if (typeof process.getuid === 'function' && process.getuid() !== 0) {
    log.warn('main', 'not running as root: per-session Linux users cannot be used (development mode only)');
  }
  startKeyWatcher();
  await startupCleanup();
  startReaper();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = stripBase(url.pathname);
    res.setHeader('x-content-type-options', 'nosniff');
    if (p === '/mcp' || p === '/mcp/') { void handleMcp(req, res); return; }
    if (p.startsWith('/api/')) { void handleApi(req, res, p, url); return; }
    sendJson(res, 404, { error: 'not found', hint: `use ${config.basePath}/api/... or ${config.basePath}/mcp` });
  });
  server.requestTimeout = 0;           // exec calls and long-polls can take minutes
  server.headersTimeout = 30_000;

  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (stripBase(url.pathname) !== '/tunnel') { socket.destroy(); return; }
    const t = redeemTicket(url.searchParams.get('ticket') ?? '');
    if (!t) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
    try { getSession(t.sessionId, 'system'); } catch { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, (ws) => attachTunnel(t.sessionId, t.ports, ws));
  });

  server.listen(config.apiPort, '0.0.0.0', () => log.info('main', `API + MCP on :${config.apiPort} (base path "${config.basePath}")`));
  const admin = startAdminServer();

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info('main', `${sig}: stopping, removing all sessions`);
    server.close(); admin.close();
    const timer = setTimeout(() => process.exit(0), 60_000);
    await shutdownAll();
    clearTimeout(timer);
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => { log.error('main', String(err?.stack ?? err)); process.exit(1); });
