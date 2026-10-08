// Spike forward proxy: logs every target and refuses private/loopback/link-local
// addresses after DNS resolution, except an explicit allow list (stands in for the tunnel).
// Prototype of the per-session proxy + smokescreen rules from plan §4.9.
import net from 'node:net';
import dns from 'node:dns/promises';
import http from 'node:http';

const port = Number(process.env.PORT || 3128);
const allow = new Set((process.env.ALLOW || '').split(',').filter(Boolean)); // e.g. "127.0.0.1:9999"

function isPrivate(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l.startsWith('::ffff:')) return isPrivate(l.slice(7));
    return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

async function decide(host: string, p: number): Promise<{ ok: boolean; ip?: string; why: string }> {
  const h = host.replace(/^\[|\]$/g, '');
  let ip = h;
  if (!net.isIP(h)) {
    try { ip = (await dns.lookup(h)).address; } catch { return { ok: false, why: 'dns-fail' }; }
  }
  if (allow.has(`${h}:${p}`) || allow.has(`${ip}:${p}`)) return { ok: true, ip, why: 'allow-list' };
  if (isPrivate(ip)) return { ok: false, ip, why: 'private-ip' };
  return { ok: true, ip, why: 'public' };
}

const log = (m: string) => console.log(`[proxy] ${m}`);

const server = http.createServer(async (req, res) => {
  // Plain HTTP proxying: absolute-form URL.
  let u: URL;
  try { u = new URL(req.url || ''); } catch { res.writeHead(400).end(); return; }
  const p = Number(u.port || 80);
  const d = await decide(u.hostname, p);
  log(`HTTP ${u.hostname}:${p} -> ${d.ip ?? '?'} ${d.ok ? 'ALLOW' : 'DENY'} (${d.why})`);
  if (!d.ok) { res.writeHead(403, { 'content-type': 'text/plain' }).end(`blocked by proxy: ${d.why}`); return; }
  const up = http.request({ host: d.ip, port: p, method: req.method, path: u.pathname + u.search,
    headers: { ...req.headers, host: u.host } }, (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
  up.on('error', (e) => { res.writeHead(502).end(String(e)); });
  req.pipe(up);
});

server.on('connect', async (req, client, head) => {
  const [host, ps] = (req.url || '').split(/:(?=\d+$)/);
  const p = Number(ps || 443);
  const d = await decide(host, p);
  log(`CONNECT ${host}:${p} -> ${d.ip ?? '?'} ${d.ok ? 'ALLOW' : 'DENY'} (${d.why})`);
  if (!d.ok) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const up = net.connect(p, d.ip!, () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.write(head); up.pipe(client); client.pipe(up); });
  up.on('error', () => client.destroy());
  client.on('error', () => up.destroy());
});

server.listen(port, '127.0.0.1', () => log(`listening 127.0.0.1:${port} allow=[${[...allow].join(',')}]`));
