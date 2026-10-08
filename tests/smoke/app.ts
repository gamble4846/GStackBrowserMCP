// "Developer laptop" test app for the smoke test, served on the tester's own localhost.
//   /login  sets an httpOnly session cookie   /whoami  echoes cookies   /  shows localStorage.auth_token
const port = Number(process.env.PORT || 3000);
Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/login') {
      const h = new Headers({ 'content-type': 'text/plain' });
      h.append('set-cookie', 'sid=laptop-session-42; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
      return new Response('logged in', { headers: h });
    }
    if (url.pathname === '/whoami') {
      const cookie = req.headers.get('cookie') || '';
      return Response.json({ loggedIn: /sid=laptop-session-42/.test(cookie), cookie });
    }
    return new Response(`<!doctype html><title>laptop app</title><h1>Hello from the laptop</h1>
      <p id="t"></p><script>document.getElementById('t').textContent='token='+(localStorage.getItem('auth_token')||'none')</script>`,
      { headers: { 'content-type': 'text/html' } });
  },
});
console.log(`laptop app on 127.0.0.1:${port}`);
