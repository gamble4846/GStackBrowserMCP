// Egress proxy (plan §4.9): the ONLY way session browsers reach the network.
// Runs in its own container (on the internal gstack-egress network + a normal outbound network).
// Resolves DNS itself and refuses every private, loopback, link-local, CGNAT (Tailscale),
// multicast and reserved address, so pages cannot reach the LAN, the Docker host or other
// containers. It connects to the IP it checked, so DNS rebinding cannot slip through.
// Requests must carry the shared EGRESS_TOKEN (added by the per-session proxies).
import fs from 'node:fs';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';

const PORT = Number(process.env.EGRESS_PORT || 4750);
const TOKEN = (process.env.EGRESS_TOKEN_FILE && fs.existsSync(process.env.EGRESS_TOKEN_FILE)
  ? fs.readFileSync(process.env.EGRESS_TOKEN_FILE, 'utf8') : process.env.EGRESS_TOKEN || '').trim();
const ALLOW = (process.env.EGRESS_ALLOW || '').split(',').map((s) => s.trim()).filter(Boolean); // "host:port" or "ip" exceptions
const log = (m: string) => process.stdout.write(`${new Date().toISOString()} [egress] ${m}\n`);

function v4Blocked(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0)
    || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return v4Blocked(ip);
  const l = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (mapped) return v4Blocked(mapped[1]);
  return l === '::' || l === '::1' || /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || /^ff/.test(l) || l.startsWith('64:ff9b:') || l.startsWith('2002:');
}

async function decide(host: string, port: number): Promise<{ ok: boolean; ip?: string; why: string }> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (ALLOW.includes(`${h}:${port}`) || ALLOW.includes(h)) {
    const ip = net.isIP(h) ? h : (await dns.lookup(h).catch(() => null))?.address;
    return ip ? { ok: true, ip, why: 'allow-list' } : { ok: false, why: 'dns-fail' };
  }
  let addrs: string[];
  if (net.isIP(h)) addrs = [h];
  else {
    try { addrs = (await dns.lookup(h, { all: true })).map((a) => a.address); } catch { return { ok: false, why: 'dns-fail' }; }
  }
  if (!addrs.length) return { ok: false, why: 'dns-fail' };
  if (addrs.some(isBlockedIp)) return { ok: false, ip: addrs[0], why: 'private-address' };
  return { ok: true, ip: addrs[0], why: 'public' };
}

function deny(sock: net.Socket, code: number, msg: string) {
  const body = `blocked by gstack egress proxy: ${msg}\n`;
  sock.end(`HTTP/1.1 ${code} ${code === 407 ? 'Proxy Authentication Required' : 'Forbidden'}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
}

function tokenOk(lines: string[]): boolean {
  if (!TOKEN) return true;
  const h = lines.find((l) => /^proxy-authorization:/i.test(l));
  const m = h && /basic\s+(\S+)/i.exec(h);
  if (!m) return false;
  const got = Buffer.from(Buffer.from(m[1], 'base64').toString('utf8').split(':').slice(1).join(':'));
  const want = Buffer.from(TOKEN);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

const server = net.createServer((client) => {
  client.on('error', () => client.destroy());
  let buf = Buffer.alloc(0);
  const onData = async (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    const end = buf.indexOf('\r\n\r\n');
    if (end < 0) { if (buf.length > 64 * 1024) client.destroy(); return; }
    client.off('data', onData);
    client.pause();
    const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
    const rest = buf.subarray(end + 4);
    const [method, target, version = 'HTTP/1.1'] = lines[0].split(' ');
    if (!tokenOk(lines.slice(1))) { deny(client, 407, 'missing or wrong proxy token'); return; }
    const headers = lines.slice(1).filter((l) => !/^(proxy-authorization|proxy-connection):/i.test(l));
    const isConnect = method?.toUpperCase() === 'CONNECT';
    let host: string; let port: number; let path = '';
    try {
      if (isConnect) {
        const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target);
        if (!m) throw new Error('bad CONNECT target');
        host = m[1]; port = Number(m[2]);
      } else {
        const u = new URL(target);
        if (u.protocol !== 'http:') throw new Error('only http:// in absolute form');
        host = u.hostname; port = Number(u.port || 80); path = u.pathname + u.search;
      }
    } catch (err: any) { deny(client, 400, err.message); return; }
    const d = await decide(host, port);
    log(`${isConnect ? 'CONNECT' : method} ${host}:${port} -> ${d.ip ?? '?'} ${d.ok ? 'ALLOW' : 'DENY'} (${d.why})`);
    if (!d.ok) { deny(client, 403, `${host} (${d.why})`); return; }
    const up = net.connect(port, d.ip!);
    up.on('error', () => { if (!client.destroyed) deny(client, 502, `cannot connect to ${host}:${port}`); });
    up.on('connect', () => {
      if (isConnect) client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      else up.write(Buffer.from(`${method} ${path} ${version}\r\n${headers.join('\r\n')}\r\n\r\n`, 'latin1'));
      if (rest.length) up.write(rest);
      up.pipe(client); client.pipe(up);
      client.resume();
      const done = () => { up.destroy(); client.destroy(); };
      up.on('close', done); client.on('close', done);
    });
  };
  client.on('data', onData);
});

if (import.meta.main) {
  server.listen(PORT, '0.0.0.0', () => log(`listening on :${PORT}${TOKEN ? ' (token required)' : ' (WARNING: no EGRESS_TOKEN set)'}; allow-list: ${ALLOW.join(',') || 'none'}`));
}
