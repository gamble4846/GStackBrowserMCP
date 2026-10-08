// Tiny TCP forwarder used to publish the admin UI on the host's 127.0.0.1 only.
// (Docker does not publish ports of containers that sit only on internal networks.)
//   GATEWAY_LISTEN=8081  GATEWAY_TARGET=gstack-browser-mcp:8081
import net from 'node:net';

const listen = Number(process.env.GATEWAY_LISTEN || 8081);
const [host, port] = (process.env.GATEWAY_TARGET || 'gstack-browser-mcp:8081').split(':');

net.createServer((c) => {
  const up = net.connect(Number(port), host);
  c.pipe(up); up.pipe(c);
  const done = () => { c.destroy(); up.destroy(); };
  c.on('error', done); up.on('error', done); c.on('close', done); up.on('close', done);
}).listen(listen, '0.0.0.0', () => process.stdout.write(`[gateway] :${listen} -> ${host}:${port}\n`));
