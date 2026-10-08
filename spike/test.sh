#!/usr/bin/env bash
# P1 spike checks. Runs as root inside the spike container; each session runs as
# its own Linux user (gs-<id>) with its own HOME/TMPDIR/state dir, umask 077.
set -u
B=/opt/gstack/browse/dist/browse
OUT=/out
mkdir -p "$OUT"
RES="$OUT/results.txt"; : > "$RES"
pass() { echo "PASS  $*" | tee -a "$RES"; }
fail() { echo "FAIL  $*" | tee -a "$RES"; }
info() { echo "INFO  $*" | tee -a "$RES"; }
check() { local name=$1; shift; if "$@"; then pass "$name"; else fail "$name"; fi; }

declare -A PORT
newsess() { # id port
  local id=$1 d=/data/sessions/$1
  PORT[$id]=$2
  useradd -M -d "$d/home" -s /usr/sbin/nologin "gs-$id" 2>/dev/null
  mkdir -p "$d/home" "$d/tmp" "$d/.gstack"
  chown -R "gs-$id:gs-$id" "$d"; chmod 700 "$d"
}
sess() { # id cmd...   (PROXY env var optional)
  local id=$1; shift
  local d=/data/sessions/$id
  runuser -u "gs-$id" -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$d/home" TMPDIR="$d/tmp" \
    CONTAINER=1 GSTACK_TELEMETRY_OFF=1 GSTACK_SKIP_ASIDE=1 PLAYWRIGHT_BROWSERS_PATH=/opt/playwright-browsers \
    BROWSE_STATE_FILE="$d/.gstack/browse.json" BROWSE_PARENT_PID=0 BROWSE_PORT="${PORT[$id]}" \
    AUTH_TOKEN="tok-$id-0123456789abcdef" ${PROXY:+BROWSE_PROXY_URL=$PROXY} \
    bash -c 'cd "$1" && umask 077 && shift && exec '"$B"' "$@"' _ "$d" "$@" 2>&1
}
delsess() { # id  -> stop daemon, kill leftovers, wipe /tmp files, dir, user
  local id=$1 d=/data/sessions/$1
  sess "$id" stop >/dev/null 2>&1
  pkill -KILL -u "gs-$id" 2>/dev/null; sleep 1
  find /tmp -user "gs-$id" -delete 2>/dev/null
  rm -rf "$d"; userdel "gs-$id" 2>/dev/null
}

APP=http://127.0.0.1:9999
bun /spike/app.ts > "$OUT/app.log" 2>&1 &
sleep 1

echo "=== 1. Isolation: separate profile per session, delete removes everything ===" | tee -a "$RES"
newsess a 41001; newsess b 41002
T0=$(date +%s); sess a goto "$APP/login" > "$OUT/a-start.log"; info "session a cold start + first goto: $(( $(date +%s) - T0 ))s"
sess a goto "$APP/" >/dev/null
sess a js "localStorage.setItem('auth_token','A-token')" >/dev/null
A_WHO=$(sess a goto "$APP/whoami" >/dev/null; sess a text)
check "a is logged in after /login" grep -q '"loggedIn":true' <<<"$A_WHO"
sess b goto "$APP/whoami" >/dev/null; B_WHO=$(sess b text)
check "b (running at same time) does NOT see a's cookie" grep -q '"loggedIn":false' <<<"$B_WHO"
sess b goto "$APP/" >/dev/null; B_LS=$(sess b js "localStorage.getItem('auth_token')")
check "b does NOT see a's localStorage" bash -c "! grep -q 'A-token' <<<\"$B_LS\""
sess a screenshot /tmp/a-shot.png >/dev/null
check "a can write /tmp/a-shot.png" test -f /tmp/a-shot.png
check "b cannot read a's /tmp file (per-user perms)" bash -c "! runuser -u gs-b -- cat /tmp/a-shot.png >/dev/null 2>&1"
B_STEAL=$(sess b eval /tmp/a-shot.png)
info "b 'eval /tmp/a-shot.png' -> $(head -c 160 <<<"$B_STEAL" | tr '\n' ' ')"
info "processes for gs-a before delete: $(pgrep -u gs-a | wc -l)"
delsess a
check "after delete: no processes left for a" bash -c "[ \$(pgrep -u gs-a 2>/dev/null | wc -l) -eq 0 ]"
check "after delete: a's folder is gone" test ! -e /data/sessions/a
check "after delete: a's /tmp files are gone" test ! -e /tmp/a-shot.png
newsess a 41001
sess a goto "$APP/whoami" >/dev/null; A2_WHO=$(sess a text)
check "new session a starts logged out" grep -q '"loggedIn":false' <<<"$A2_WHO"
sess a goto "$APP/" >/dev/null; A2_LS=$(sess a js "localStorage.getItem('auth_token')")
check "new session a has empty localStorage" bash -c "! grep -q 'A-token' <<<\"$A2_LS\""

echo "=== 3. Auth import: cookies (with flags) + localStorage keep you logged in ===" | tee -a "$RES"
newsess c 41003
D=/data/sessions/c; mkdir -p "$D/.gstack/browse-states"
EXP=$(( $(date +%s) + 86400 ))
cat > "$D/.gstack/browse-states/auth.json" <<EOF
{"version":1,"savedAt":"$(date -u +%Y-%m-%dT%H:%M:%SZ)",
 "cookies":[{"name":"sid","value":"secret-session-123","domain":"127.0.0.1","path":"/","expires":$EXP,"httpOnly":true,"secure":false,"sameSite":"Lax"},
            {"name":"theme","value":"dark","domain":"127.0.0.1","path":"/","expires":$EXP,"httpOnly":false,"secure":false,"sameSite":"Lax"}],
 "pages":[{"url":"about:blank","isActive":true}]}
EOF
chown -R gs-c:gs-c "$D/.gstack"
info "state load -> $(sess c state load auth | tr '\n' ' ')"
sess c goto "$APP/whoami" >/dev/null; C_WHO=$(sess c text)
check "imported httpOnly cookie is sent -> logged in" grep -q '"loggedIn":true' <<<"$C_WHO"
sess c goto "$APP/" >/dev/null
C_DOC=$(sess c js "document.cookie")
check "httpOnly cookie stays hidden from page JS" bash -c "! grep -q 'sid=' <<<\"$C_DOC\""
check "normal cookie visible to page JS" grep -q 'theme=dark' <<<"$C_DOC"
sess c js "localStorage.setItem('auth_token','C-token'); sessionStorage.setItem('tab','1'); 'ok'" >/dev/null
sess c reload >/dev/null
C_TXT=$(sess c text)
check "page sees imported localStorage after reload" grep -q 'token=C-token' <<<"$C_TXT"
info "state save -> $(sess c state save exp | head -1)"
EXPF="$D/.gstack/browse-states/exp.json"
if [ -f "$EXPF" ]; then
  SID=$(jq -c '.cookies[] | select(.name=="sid")' "$EXPF")
  info "exported sid cookie: $SID"
  check "export keeps value (not redacted)" grep -q '"value":"secret-session-123"' <<<"$SID"
  check "export keeps httpOnly" grep -q '"httpOnly":true' <<<"$SID"
  check "export keeps sameSite" grep -q '"sameSite":"Lax"' <<<"$SID"
  check "export keeps expiry" bash -c "jq -e '.expires > $(( EXP - 5 ))' <<<'$SID' >/dev/null"
else fail "state save wrote $EXPF"; fi
C_LSX=$(sess c js "JSON.stringify({local:{...localStorage},session:{...sessionStorage}})")
info "storage export via js: $C_LSX"
check "storage export via js is unredacted" grep -q 'C-token' <<<"$C_LSX"
C_RED=$(sess c storage)
info "built-in 'storage' command output (for comparison): $(tr '\n' ' ' <<<"$C_RED" | head -c 200)"

echo "=== 2. Proxy: browser forced through our proxy; private addresses blocked ===" | tee -a "$RES"
ALLOW=127.0.0.1:9999 PORT=3128 bun /spike/proxy.ts > "$OUT/proxy.log" 2>&1 &
sleep 1
info "direct (no proxy) from session a -> 192.168.1.6:8654 (VaultWarden): $(sess a goto http://192.168.1.6:8654 | head -1)"
newsess p 41004
PROXY=http://127.0.0.1:3128 sess p goto "$APP/whoami" > "$OUT/p-goto.log"
P_WHO=$(PROXY=http://127.0.0.1:3128 sess p text)
check "loopback app reachable via proxy allow-list" grep -q 'loggedIn' <<<"$P_WHO"
check "loopback request actually went THROUGH the proxy" grep -q 'HTTP 127.0.0.1:9999' "$OUT/proxy.log"
for tgt in http://192.168.1.6:8654 http://host.docker.internal:5432 http://169.254.169.254/ http://10.0.0.1/ http://172.17.0.1/; do
  R=$(PROXY=http://127.0.0.1:3128 sess p goto "$tgt"; PROXY=http://127.0.0.1:3128 sess p text 2>/dev/null | head -c 120)
  if grep -qiE 'blocked by proxy|403|ERR_|error|fail' <<<"$R"; then pass "blocked: $tgt"; else fail "blocked: $tgt -> $(tr '\n' ' ' <<<"$R" | head -c 160)"; fi
done
R=$(PROXY=http://127.0.0.1:3128 sess p goto https://example.com; PROXY=http://127.0.0.1:3128 sess p text | head -c 200)
check "public site allowed through proxy (example.com)" grep -q 'Example Domain' <<<"$R"
info "proxy log:"; sed 's/^/      /' "$OUT/proxy.log" | tee -a "$RES" >/dev/null

echo "=== 5. Files: screenshots, PDF, uploads land in the session folder ===" | tee -a "$RES"
newsess f 41005
D=/data/sessions/f
sess f goto "$APP/" >/dev/null
info "screenshot rel -> $(sess f screenshot shot.png | head -1)"
check "relative screenshot lands in session folder" test -s "$D/shot.png"
B64=$(sess f screenshot --base64 | head -c 40)
check "screenshot --base64 returns data URL" grep -q 'data:image/png;base64' <<<"$B64"
info "pdf -> $(sess f pdf out.pdf | head -1)"
check "pdf lands in session folder" test -s "$D/out.pdf"
info "responsive -> $(sess f responsive resp | tr '\n' ' ' | head -c 200)"
check "responsive writes files with prefix" bash -c "ls $D/resp* >/dev/null 2>&1"
info "annotated snapshot -> $(sess f snapshot -i -a -o ann.png | tail -1 | head -c 120)"
check "annotated snapshot file" test -s "$D/ann.png"
echo hello > "$D/up.txt"; chown gs-f:gs-f "$D/up.txt"
info "upload -> $(sess f upload '#f' up.txt | head -1)"
UPN=$(sess f js "document.getElementById('f').files[0] && document.getElementById('f').files[0].name")
check "upload attached file to input" grep -q 'up.txt' <<<"$UPN"
ESC=$(sess f screenshot /etc/evil.png)
check "writing outside session/tmp is refused" bash -c "[ ! -e /etc/evil.png ] && grep -qi 'must be within' <<<\"$ESC\""
info "newtab --json -> $(sess f newtab "$APP/" --json | head -c 120)"
info "tabs -> $(sess f tabs | tr '\n' ' ' | head -c 200)"
info "status -> $(sess f status | tr '\n' ' ' | head -c 200)"
info "handoff (headless) -> $(sess f handoff test | tr '\n' ' ' | head -c 200)"

echo "=== 4. Memory per session ===" | tee -a "$RES"
for id in a b c p f; do
  sess "$id" goto https://en.wikipedia.org/wiki/Web_browser >/dev/null 2>&1
done
sleep 2
TOTAL=0
for id in a b c p f; do
  KB=$(ps -u "gs-$id" -o rss= | awk '{s+=$1} END {print s+0}')
  TOTAL=$((TOTAL + KB))
  info "session $id: $((KB / 1024)) MB RSS across $(pgrep -u gs-$id | wc -l) processes (wikipedia page loaded)"
done
info "average per session: $((TOTAL / 5 / 1024)) MB  (RSS double-counts shared libs; see cgroup figure)"
if [ -f /sys/fs/cgroup/memory.current ]; then info "container cgroup memory.current: $(( $(cat /sys/fs/cgroup/memory.current) / 1048576 )) MB with 5 sessions"; fi
info "memory --json (session f): $(sess f memory --json | tr '\n' ' ' | head -c 300)"

for id in a b c p f; do delsess "$id"; done
check "all sessions cleaned up (no gs-* processes)" bash -c "! pgrep -f 'gs-' >/dev/null && [ -z \"\$(ls /data/sessions 2>/dev/null)\" ]"
echo "=== done ===" | tee -a "$RES"
grep -c '^PASS' "$RES" | xargs -I{} echo "PASS count: {}"; grep -c '^FAIL' "$RES" | xargs -I{} echo "FAIL count: {}"
