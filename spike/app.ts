// Tiny test site for the spike. Runs inside the container on 127.0.0.1:9999.
//   /login   sets an httpOnly+Secure=false+SameSite=Lax session cookie, plus a JS-visible cookie
//   /whoami  echoes the Cookie header the browser sent (proves httpOnly cookies are sent)
//   /        a page that also shows localStorage.auth_token
const port = Number(process.env.PORT || 9999);

Bun.serve({
  hostname: '127.0.0.1',
  port,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/login') {
      const headers = new Headers({ 'content-type': 'text/plain' });
      headers.append('set-cookie', 'sid=secret-session-123; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400');
      headers.append('set-cookie', 'theme=dark; Path=/; Max-Age=86400');
      return new Response('logged in', { headers });
    }
    if (url.pathname === '/whoami') {
      const cookie = req.headers.get('cookie') || '';
      const loggedIn = /(^|;\s*)sid=secret-session-123/.test(cookie);
      return new Response(JSON.stringify({ loggedIn, cookie }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(
      `<!doctype html><title>spike app</title><h1>spike app</h1><p id="ls"></p>
       <input type="file" id="f"><a href="/whoami">whoami</a>
       <script>document.getElementById('ls').textContent = 'token=' + (localStorage.getItem('auth_token') || 'none');</script>`,
      { headers: { 'content-type': 'text/html' } },
    );
  },
});
console.log(`spike app on 127.0.0.1:${port}`);
