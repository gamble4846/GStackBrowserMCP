#!/usr/bin/env bash
# Follow-up checks: cookie-import (keeps localhost cookies), state load for a public domain, proxy + https.
set -u
source <(sed -n '/^declare -A PORT/,/^delsess() {/p' /spike/test.sh | sed '$d')
delsess() { local id=$1; sess "$id" stop >/dev/null 2>&1; pkill -KILL -u "gs-$id"; sleep 1; find /tmp -user "gs-$id" -delete 2>/dev/null; rm -rf "/data/sessions/$id"; userdel "gs-$id"; }
B=/opt/gstack/browse/dist/browse
APP=http://127.0.0.1:9999
bun /spike/app.ts >/dev/null 2>&1 &
sleep 1
newsess c 41003; D=/data/sessions/c
EXP=$(( $(date +%s) + 86400 ))
echo "--- cookie-import on loopback app"
cat > "$D/ck.json" <<J
[{"name":"sid","value":"secret-session-123","domain":"127.0.0.1","path":"/","expires":$EXP,"httpOnly":true,"secure":false,"sameSite":"Lax"},
 {"name":"theme","value":"dark","domain":"127.0.0.1","path":"/","expires":$EXP,"httpOnly":false,"secure":false,"sameSite":"Lax"}]
J
chown gs-c:gs-c "$D/ck.json"
sess c goto "$APP/" ; sess c cookie-import ck.json
sess c goto "$APP/whoami"; sess c text
echo "document.cookie: $(sess c js 'document.cookie')"
sess c state save exp; jq -c '.cookies[]' "$D/.gstack/browse-states/exp.json"
echo "--- state load with a public-domain cookie (no navigation needed)"
cat > "$D/.gstack/browse-states/pub.json" <<J
{"version":1,"savedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","cookies":[{"name":"pubsid","value":"v1","domain":".example.com","path":"/","expires":$EXP,"httpOnly":true,"secure":true,"sameSite":"None"}],"pages":[{"url":"about:blank","isActive":true}]}
J
chown -R gs-c:gs-c "$D/.gstack"
sess c state load pub; sess c state save exp2; jq -c '.cookies[] | select(.name=="pubsid")' "$D/.gstack/browse-states/exp2.json"
echo "--- proxy + https"
ALLOW=127.0.0.1:9999 PORT=3128 bun /spike/proxy.ts > /out/proxy2.log 2>&1 &
sleep 1
newsess p 41004
PROXY=http://127.0.0.1:3128 sess p goto https://example.com
PROXY=http://127.0.0.1:3128 sess p text | head -5
PROXY=http://127.0.0.1:3128 sess p goto http://localhost:9999/whoami
PROXY=http://127.0.0.1:3128 sess p text | head -3
cat /out/proxy2.log
echo "--- cleanup"
delsess c; delsess p
echo "leftover session processes: $(pgrep -u gs-c,gs-p 2>/dev/null | wc -l) ; dirs: $(ls /data/sessions | wc -l)"
