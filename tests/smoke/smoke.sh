#!/usr/bin/env bash
# End-to-end smoke test. Runs INSIDE a "tester" container on the same internal network as the
# server, acting as a developer laptop: browse-remote, a localhost app shared through the tunnel,
# MCP over HTTP, isolation, auth import/export, and the LAN lockdown.
#   env: GSTACK_REMOTE_URL, GSTACK_REMOTE_KEY, KEY2 (second user's key), LAN_TARGET (e.g. http://192.168.1.6:8654)
set -u
export GSTACK_REMOTE_INSECURE=1 GSTACK_TUNNEL_PORTS=3000
B="node /client/browse-remote"
W=$(mktemp -d); cd "$W" && git init -q .   # browse-remote keeps its session file in <git root>/.gstack
PASS=0; FAIL=0
pass() { echo "PASS  $*"; PASS=$((PASS+1)); }
fail() { echo "FAIL  $*"; FAIL=$((FAIL+1)); }
check() { local n=$1; shift; if "$@"; then pass "$n"; else fail "$n"; fi; }

bun /tests/smoke/app.ts >/tmp/app.log 2>&1 &
sleep 1

echo "== basics"
OUT=$($B goto https://example.com 2>&1); echo "$OUT" | head -2
check "goto public site" grep -q 'Navigated to https://example.com' <<<"$OUT"
check "text works" bash -c "$B text | grep -qi 'documentation examples'"
$B screenshot shot.png >/dev/null 2>&1
check "screenshot downloaded to local path" bash -c "head -c 8 shot.png | od -An -tx1 | grep -q '89 50 4e 47'"
$B responsive resp/home >/dev/null 2>&1
check "responsive files downloaded" bash -c "ls resp/home-mobile.png resp/home-desktop.png >/dev/null"
echo '<h1 id=x>uploaded html</h1>' > page.html
$B load-html page.html >/dev/null 2>&1
check "load-html uploads local file" bash -c "$B text | grep -q 'uploaded html'"
OUT=$($B cookie-import-browser chrome 2>&1)
check "denied command gives a clear message" grep -q 'no local browser on the server' <<<"$OUT"
OUT=$($B handoff 2>&1)
check "handoff gives the v1 message" grep -q "Human takeover isn't available" <<<"$OUT"

echo "== LAN lockdown"
for t in "${LAN_TARGET:-http://192.168.1.6:8654}" http://host.docker.internal:5432 http://169.254.169.254/ http://10.0.0.1/; do
  OUT=$($B goto "$t" 2>&1; $B text 2>&1)
  if grep -qiE 'blocked|private network address|403|ERR_' <<<"$OUT" && ! grep -qiE 'vaultwarden|bitwarden' <<<"$OUT"; then pass "blocked $t"; else fail "blocked $t -> $(head -c 200 <<<"$OUT")"; fi
done
OUT=$($B js "fetch('http://192.168.1.6:8654/').then(r=>'reached '+r.status).catch(e=>'error '+e.message)" 2>&1)
check "page JS cannot reach the LAN either" bash -c "! grep -q 'reached 200' <<<\"$OUT\""

echo "== tunnel to the laptop's localhost"
sleep 2
OUT=$($B goto http://localhost:3000/ 2>&1; $B text 2>&1)
check "localhost:3000 reached through tunnel" grep -q 'Hello from the laptop' <<<"$OUT"
OUT=$($B goto http://localhost:3001/ 2>&1)
check "unshared port refused" bash -c "! grep -q '(200)' <<<\"$OUT\""

echo "== auth: import cookies + localStorage, export, profile"
cat > auth.json <<'J'
{"cookies":[{"name":"sid","value":"laptop-session-42","domain":"localhost","path":"/","expires":4102444800,"httpOnly":true,"secure":false,"sameSite":"Lax"}],
 "origins":[{"origin":"http://localhost:3000","localStorage":[{"name":"auth_token","value":"tok-123"}]}]}
J
OUT=$($B remote-auth import auth.json 2>&1); echo "$OUT"
check "auth import reports OK" grep -q '^OK' <<<"$OUT"
$B goto http://localhost:3000/whoami >/dev/null 2>&1
check "imported httpOnly cookie logs in" bash -c "$B text | grep -q '\"loggedIn\":true'"
$B goto http://localhost:3000/ >/dev/null 2>&1
check "imported localStorage visible" bash -c "$B text | grep -q 'token=tok-123'"
check "httpOnly cookie hidden from page JS" bash -c "! $B js document.cookie | grep -q sid="
$B remote-auth export exported.json >/dev/null 2>&1
check "export keeps httpOnly + value" bash -c "grep -q '\"httpOnly\": true' exported.json && grep -q 'laptop-session-42' exported.json"
OUT=$($B remote-auth save smoke-profile 2>&1); echo "$OUT"
check "profile saved" grep -q 'Saved profile smoke-profile' <<<"$OUT"
ID1=$($B remote-status 2>/dev/null | sed -n 's/^session: \(gs_[a-z0-9x]*\).*/\1/p')
echo "first user's session: $ID1"

echo "== isolation + delete"
OUT=$(GSTACK_REMOTE_KEY=$KEY2 GSTACK_TUNNEL_PORTS= $B goto http://localhost:3000/whoami 2>&1)
check "second user cannot reach first user's laptop tunnel" bash -c "! grep -q '(200)' <<<\"$OUT\""
OUT=$(curl -s -H "authorization: Bearer $KEY2" "$GSTACK_REMOTE_URL/api/sessions/$ID1")
check "second user cannot see first user's session" grep -q 'not found' <<<"$OUT"
GSTACK_REMOTE_KEY=$KEY2 $B stop >/dev/null 2>&1
$B stop
check "stop deletes the session" bash -c "curl -s -H 'authorization: Bearer $GSTACK_REMOTE_KEY' $GSTACK_REMOTE_URL/api/sessions/$ID1 | grep -q 'not found'"
OUT=$(GSTACK_REMOTE_AUTH_PROFILE=smoke-profile $B goto http://localhost:3000/whoami 2>&1; $B text 2>&1)
check "new session from saved profile starts logged in" grep -q '"loggedIn":true' <<<"$OUT"
$B stop >/dev/null
OUT=$($B goto http://localhost:3000/whoami 2>&1; $B text 2>&1)
check "fresh session (no profile) starts logged out" grep -q '"loggedIn":false' <<<"$OUT"
$B stop >/dev/null

echo "== MCP"
MCP="$GSTACK_REMOTE_URL/mcp"
H=(-H "authorization: Bearer $GSTACK_REMOTE_KEY" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
OUT=$(curl -s "${H[@]}" "$MCP" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
check "MCP tools/list includes browser_start" grep -q 'browser_start' <<<"$OUT"
OUT=$(curl -s "${H[@]}" "$MCP" -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"browser_start","arguments":{"wait":true}}}')
SID=$(grep -o 'gs_[a-z0-9x]*' <<<"$OUT" | head -1)
check "MCP browser_start returns a ready session" bash -c "[ -n '$SID' ] && grep -q 'ready' <<<'$OUT'"
OUT=$(curl -s "${H[@]}" "$MCP" -d "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_goto\",\"arguments\":{\"sessionId\":\"$SID\",\"url\":\"https://example.com\"}}}")
check "MCP browser_goto" grep -q 'Navigated to' <<<"$OUT"
OUT=$(curl -s "${H[@]}" "$MCP" -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_screenshot\",\"arguments\":{\"sessionId\":\"$SID\",\"viewport\":true}}}")
check "MCP browser_screenshot returns an image" grep -q '"type":"image"' <<<"$OUT"
OUT=$(curl -s "${H[@]}" "$MCP" -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"browser_stop\",\"arguments\":{\"sessionId\":\"$SID\"}}}")
check "MCP browser_stop" grep -q 'deleted' <<<"$OUT"
OUT=$(curl -s -H 'authorization: Bearer gsk_wrongwrongwrongwrongwrong' "$GSTACK_REMOTE_URL/api/me")
check "bad key rejected" grep -q 'invalid API key' <<<"$OUT"

echo "== admin UI"
ADMIN=http://gstack-browser-mcp:8081
check "admin page served" bash -c "curl -s $ADMIN/ | grep -q 'GStack Browser Admin'"
check "admin API needs login" bash -c "curl -s $ADMIN/api/sessions | grep -q 'not logged in'"
curl -s -c /tmp/adm.jar -H 'content-type: application/json' -d "{\"key\":\"$GSTACK_REMOTE_KEY\"}" $ADMIN/login >/dev/null
$B goto https://example.com >/dev/null 2>&1
SIDA=$($B remote-status 2>/dev/null | sed -n 's/^session: \(gs_[a-z0-9x]*\).*/\1/p')
check "admin lists live sessions" bash -c "curl -s -b /tmp/adm.jar $ADMIN/api/sessions | grep -q '$SIDA'"
check "admin timeline has commands" bash -c "curl -s -b /tmp/adm.jar $ADMIN/api/sessions/$SIDA/timeline | grep -q '\"command\":\"goto\"'"
check "admin live view returns a PNG" bash -c "curl -s -b /tmp/adm.jar $ADMIN/api/sessions/$SIDA/live.png | head -c 8 | od -An -tx1 | grep -q '89 50 4e 47'"
check "admin kill requires CSRF header" bash -c "curl -s -b /tmp/adm.jar -X DELETE $ADMIN/api/sessions/$SIDA | grep -q 'x-requested-with'"
check "admin kill works" bash -c "curl -s -b /tmp/adm.jar -X DELETE -H 'x-requested-with: gstack-admin' $ADMIN/api/sessions/$SIDA | grep -q deleted"
check "second user cannot log into admin as admin" bash -c "curl -s -H 'content-type: application/json' -d '{\"key\":\"$KEY2\"}' $ADMIN/login | grep -q '\"role\":\"user\"'"

echo "RESULT: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
