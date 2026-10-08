// Reverse tunnel from a developer laptop (plan §4.9, phase P3b).
// The laptop's browse-remote opens a WebSocket; the session's proxy opens streams over it
// to reach the laptop's own localhost:<port>. Only ports the developer listed are allowed.
//
// Wire format on the WebSocket:
//   text   {"t":"open","id":N,"port":P}   server → client   open a stream to localhost:P
//   text   {"t":"opened","id":N}          client → server
//   text   {"t":"error","id":N,"msg":".."} client → server
//   text   {"t":"close","id":N}           either way
//   binary <uint32 id><payload>           either way
import { Duplex } from 'node:stream';
import crypto from 'node:crypto';
import type { WebSocket } from 'ws';
import { log } from './log';

interface Tunnel { ws: WebSocket; ports: Set<number>; streams: Map<number, Duplex>; nextId: number; pending: Map<number, (err?: Error) => void> }
const tunnels = new Map<string, Tunnel>();   // sessionId → tunnel
const tickets = new Map<string, { sessionId: string; ports: number[]; expires: number }>();

export function issueTicket(sessionId: string, ports: number[]): string {
  const ticket = crypto.randomBytes(24).toString('base64url');
  tickets.set(ticket, { sessionId, ports, expires: Date.now() + 60_000 });
  return ticket;
}

export function redeemTicket(ticket: string): { sessionId: string; ports: number[] } | null {
  const t = tickets.get(ticket);
  tickets.delete(ticket);
  if (!t || t.expires < Date.now()) return null;
  return { sessionId: t.sessionId, ports: t.ports };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of tickets) if (v.expires < now) tickets.delete(k); }, 30_000).unref();

export function attachTunnel(sessionId: string, ports: number[], ws: WebSocket): void {
  closeTunnel(sessionId);
  const t: Tunnel = { ws, ports: new Set(ports), streams: new Map(), nextId: 1, pending: new Map() };
  tunnels.set(sessionId, t);
  log.info('tunnel', `session ${sessionId}: tunnel up, ports ${ports.join(',')}`);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      if (buf.length < 4) return;
      const s = t.streams.get(buf.readUInt32BE(0));
      if (s) s.push(buf.subarray(4));
      return;
    }
    let msg: any;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    if (msg.t === 'opened') t.pending.get(msg.id)?.();
    else if (msg.t === 'error') t.pending.get(msg.id)?.(new Error(String(msg.msg ?? 'tunnel open failed')));
    else if (msg.t === 'close') { const s = t.streams.get(msg.id); t.streams.delete(msg.id); s?.push(null); }
  });
  ws.on('close', () => {
    if (tunnels.get(sessionId) === t) tunnels.delete(sessionId);
    for (const s of t.streams.values()) s.destroy();
    for (const p of t.pending.values()) p(new Error('tunnel closed'));
    log.info('tunnel', `session ${sessionId}: tunnel closed`);
  });
}

export function closeTunnel(sessionId: string): void {
  const t = tunnels.get(sessionId);
  if (!t) return;
  tunnels.delete(sessionId);
  try { t.ws.close(1000, 'session ended'); } catch { /* already closed */ }
}

export function tunnelInfo(sessionId: string): { connected: boolean; ports: number[] } {
  const t = tunnels.get(sessionId);
  return { connected: !!t, ports: t ? [...t.ports] : [] };
}

/** Open a byte stream to the laptop's localhost:<port>. */
export function openTunnelStream(sessionId: string, port: number): Promise<Duplex> {
  const t = tunnels.get(sessionId);
  if (!t) return Promise.reject(new Error('no tunnel connected for this session (set GSTACK_TUNNEL_PORTS in browse-remote)'));
  if (!t.ports.has(port)) return Promise.reject(new Error(`port ${port} is not shared by the tunnel (shared: ${[...t.ports].join(',') || 'none'})`));
  const id = t.nextId++;
  const header = Buffer.alloc(4);
  header.writeUInt32BE(id, 0);
  const stream = new Duplex({
    read() { /* data is pushed from the WebSocket */ },
    write(chunk: Buffer, _enc, cb) {
      t.ws.send(Buffer.concat([header, chunk]), { binary: true }, (err) => cb(err ?? undefined));
    },
    final(cb) { if (t.streams.delete(id)) t.ws.send(JSON.stringify({ t: 'close', id })); cb(); },
    destroy(err, cb) { if (t.streams.delete(id)) { try { t.ws.send(JSON.stringify({ t: 'close', id })); } catch { /* closed */ } } cb(err); },
  });
  t.streams.set(id, stream);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { t.pending.delete(id); t.streams.delete(id); reject(new Error('tunnel open timed out')); }, 10_000);
    t.pending.set(id, (err) => {
      clearTimeout(timer);
      t.pending.delete(id);
      if (err) { t.streams.delete(id); reject(err); } else resolve(stream);
    });
    t.ws.send(JSON.stringify({ t: 'open', id, port }));
  });
}
