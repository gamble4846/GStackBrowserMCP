// Per-session HTTP proxy that the session's Chromium is forced to use (BROWSE_PROXY_URL).
//   localhost / 127.x / [::1] / 0.0.0.0  → the session owner's tunnel (by NAME, before any DNS: spike change 4)
//   everything else                      → the egress proxy, which blocks private addresses
// Works at the TCP level so CONNECT (HTTPS, WebSockets) and plain HTTP are both relayed byte-for-byte.
import fs from 'node:fs';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import { config } from '../config';
import { openTunnelStream } from './tunnel';
import { log } from './log';

const LOOPBACK_NAMES = /^(localhost|localhost\.|127(\.\d{1,3}){3}|\[?::1\]?|0\.0\.0\.0|\[?0:0:0:0:0:0:0:1\]?)$/i;
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_NAMES.test(host) || host.toLowerCase().endsWith('.localhost');
}

const egress = new URL(config.egressProxyUrl);
const egressHost = egress.hostname;
const egressPort = Number(egress.port || 80);

interface Head { method: string; target: string; version: string; headerLines: string[]; rest: Buffer }

function parseHead(buf: Buffer): Head | null {
  const end = buf.indexOf('\r\n\r\n');
  if (end < 0) return null;
  const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
  const [method, target, version] = lines[0].split(' ');
  if (!method || !target) return null;
  return { method, target, version: version || 'HTTP/1.1', headerLines: lines.slice(1), rest: buf.subarray(end + 4) };
}

function hostPort(target: string, defPort: number): { host: string; port: number } {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target);
  return m ? { host: m[1], port: Number(m[2]) } : { host: target, port: defPort };
}

function refuse(sock: net.Socket, code: number, reason: string, msg: string): void {
  const body = `gstack-browser-mcp: ${msg}\n`;
  sock.end(`HTTP/1.1 ${code} ${reason}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function pipeBoth(a: Duplex, b: Duplex): void {
  a.pipe(b); b.pipe(a);
  const done = () => { a.destroy(); b.destroy(); };
  a.on('error', done); b.on('error', done);
  a.on('close', done); b.on('close', done);
}

export interface SessionProxy { port: number; close(): Promise<void> }

/**
 * All sessions share the container's loopback, so a proxy must only serve its own session:
 * look up which Linux user owns the connecting socket in /proc/net/tcp.
 */
export function socketOwnerUid(clientPort: number, serverPort: number): number | null {
  const hex = (n: number) => n.toString(16).toUpperCase().padStart(4, '0');
  const local = `:${hex(clientPort)}`;
  const remote = `:${hex(serverPort)}`;
  for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length > 7 && cols[1].endsWith(local) && cols[2].endsWith(remote)) return Number(cols[7]);
    }
  }
  return null;
}

export function startSessionProxy(sessionId: string, port: number, expectedUid: number | null, isUrlAllowed: (url: string) => boolean): Promise<SessionProxy> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    if (expectedUid !== null) {
      const uid = socketOwnerUid(client.remotePort ?? 0, port);
      if (uid !== expectedUid) {
        log.warn('proxy', `session ${sessionId}: refused connection from uid ${uid} (expected ${expectedUid})`);
        client.destroy();
        return;
      }
    }
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > 64 * 1024) { refuse(client, 431, 'Request Header Fields Too Large', 'request head too large'); return; }
      const head = parseHead(buf);
      if (!head) return;
      client.off('data', onData);
      client.pause();
      route(head, client).catch((err) => refuse(client, 502, 'Bad Gateway', String(err?.message ?? err)));
    };
    client.on('data', onData);
  });

  async function route(head: Head, client: net.Socket): Promise<void> {
    const isConnect = head.method.toUpperCase() === 'CONNECT';
    let host: string; let port: number; let urlForCheck: string;
    if (isConnect) {
      ({ host, port } = hostPort(head.target, 443));
      urlForCheck = `https://${host}:${port}/`;
    } else {
      let u: URL;
      try { u = new URL(head.target); } catch { refuse(client, 400, 'Bad Request', 'proxy requests must use an absolute URL'); return; }
      host = u.hostname.replace(/^\[|\]$/g, ''); port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
      urlForCheck = u.href;
    }

    if (!isLoopbackHost(host) && !isUrlAllowed(urlForCheck)) {
      refuse(client, 403, 'Forbidden', `blocked by ALLOWED_URL_PATTERNS: ${host}`);
      return;
    }

    if (isLoopbackHost(host)) {
      // → developer laptop through the tunnel
      let stream: Duplex;
      try { stream = await openTunnelStream(sessionId, port); } catch (err: any) {
        refuse(client, 502, 'Bad Gateway', `localhost:${port} is not reachable: ${err.message}`); return;
      }
      if (isConnect) {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.rest.length) stream.write(head.rest);
      } else {
        const u = new URL(head.target);
        const lines = head.headerLines.filter((l) => !/^(proxy-connection|connection|keep-alive):/i.test(l));
        stream.write(Buffer.concat([
          Buffer.from(`${head.method} ${u.pathname}${u.search} ${head.version}\r\n${lines.join('\r\n')}\r\nConnection: close\r\n\r\n`, 'latin1'),
          head.rest,
        ]));
      }
      pipeBoth(client, stream);
      client.resume();
      return;
    }

    // → egress proxy (it resolves DNS and blocks private/LAN/metadata addresses)
    const up = net.connect(egressPort, egressHost);
    up.once('error', (err) => refuse(client, 502, 'Bad Gateway', `egress proxy unreachable: ${err.message}`));
    up.once('connect', () => {
      const lines = head.headerLines.filter((l) => !/^proxy-authorization:/i.test(l)
        && (isConnect || !/^(proxy-connection|connection|keep-alive):/i.test(l)));
      if (config.egressToken) lines.push(`Proxy-Authorization: Basic ${Buffer.from('gstack:' + config.egressToken).toString('base64')}`);
      const extra = isConnect ? '' : 'Connection: close\r\n';
      up.write(Buffer.concat([
        Buffer.from(`${head.method} ${head.target} ${head.version}\r\n${lines.join('\r\n')}\r\n${extra}\r\n`, 'latin1'),
        head.rest,
      ]));
      pipeBoth(client, up);
      client.resume();
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port,
        close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
      });
    });
  }).then((p) => { log.info('proxy', `session ${sessionId}: proxy on 127.0.0.1:${port}`); return p as SessionProxy; });
}
