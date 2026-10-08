// Small HTTP helpers shared by the API, MCP and admin servers (node:http, runs under Bun).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from '../config';
import { authenticate, bearer, isLockedOut, recordAuthFailure, type Principal } from '../core/keys';
import { audit } from '../core/log';
import { SessionError } from '../core/sessionManager';

const PRIVATE_PEER = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd]/i;

/** Client IP: X-Forwarded-For is only trusted from the reverse proxy (TRUST_PROXY, or any private peer by default). */
export function clientIp(req: IncomingMessage): string {
  const peer = req.socket.remoteAddress ?? '';
  const trusted = config.trustProxy.length ? config.trustProxy.includes(peer.replace(/^::ffff:/, '')) : PRIVATE_PEER.test(peer);
  const xff = req.headers['x-forwarded-for'];
  if (trusted && typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  return peer.replace(/^::ffff:/, '');
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

export function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof SessionError) { sendJson(res, err.status, { error: err.message }); return; }
  const msg = err instanceof Error ? err.message : String(err);
  sendJson(res, 500, { error: msg });
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new SessionError(413, `request body larger than ${limit} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson<T = any>(req: IncomingMessage, limit = 6 * 1024 * 1024): Promise<T> {
  const buf = await readBody(req, limit);
  if (!buf.length) return {} as T;
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new SessionError(400, 'body must be JSON'); }
}

/** Authenticate a request by Bearer key; handles lockout + audit. Returns null after sending the error. */
export function requireAuth(req: IncomingMessage, res: ServerResponse, via: 'api' | 'mcp' | 'admin', keyOverride?: string | null): Principal | null {
  const ip = clientIp(req);
  if (isLockedOut(ip)) {
    sendJson(res, 429, { error: 'too many failed authentication attempts; try again later' }, { 'retry-after': '300' });
    return null;
  }
  const key = keyOverride ?? bearer(req.headers.authorization);
  const who = authenticate(key);
  if (!who) {
    recordAuthFailure(ip);
    audit({ action: 'auth.fail', ip, via, detail: key ? 'unknown key' : 'missing key' });
    sendJson(res, 401, { error: 'missing or invalid API key (Authorization: Bearer gsk_...)' }, { 'www-authenticate': 'Bearer' });
    return null;
  }
  return who;
}
