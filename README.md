# GStack Browser MCP

Runs the [gstack](https://github.com/garrytan/gstack) headless browser (`browse`) in a Linux Docker container on a shared server, so that:

- **gstack skills** (`/qa`, `/browse`, `/design-review`, …) drive a **remote** browser with no changes. `browse-remote` replaces `$B` in your project.
- **Any AI agent** can drive the same browsers over **MCP**: it starts a session, gets a session ID, and sends commands.
- An **admin UI** shows live sessions, each session's command history and a live view of its browser.

The browser is the original, unmodified upstream gstack at a pinned commit. Every session is a separate browser running as its own Linux user with a brand-new profile. Deleting a session wipes its profile and all its files.

```
 laptop: gstack skill ─ $B = browse-remote ─┐                ┌─ admin UI (tailnet / 127.0.0.1 only)
 cloud/any: AI agent ─── MCP ───────────────┤ HTTPS (Funnel) │
                                            ▼                ▼
                     nginx /gstack/ ──► gstack-browser-mcp ──► per session: gstack daemon + Chromium (own Linux user)
                                            │  each browser ─► per-session proxy ─┬─► laptop tunnel (localhost:PORT)
                                            │                                   └─► egress-proxy ─► internet only
                                            └ internal Docker networks only: no direct route to the LAN
```

Design docs are in [Plans/](Plans/): [the plan](Plans/01-initial-plan.md), [research](Plans/02-research-findings.md) and [spike results](Plans/03-spike-findings.md).

---

## 1. Server setup (SATVADELL, once)

You need Docker Desktop (Linux containers) and Windows PowerShell 5.1 or later.

```powershell
cd "D:\Git Repos\GStackBrowserMCP"
.\deploy\setup-host.ps1                 # F:\DockerVolumes\GStackBrowserMCP: secrets, .env, keys.json, prints your admin key
.\build-image.ps1 -SmokeTest -Deploy    # build, run the end-to-end test in isolated networks, start the stack
.\deploy\connect-reverse-proxy.ps1      # DRY RUN: shows the changes to the existing Funnel/nginx
.\deploy\connect-reverse-proxy.ps1 -Apply   # backs up, patches, runs nginx -t, reloads (no restart of other services)
```

After that:

| What | Where |
|---|---|
| API + MCP (public, through Tailscale Funnel) | `https://<funnel-host>/gstack/api/...` and `https://<funnel-host>/gstack/mcp` |
| API + MCP (this machine only) | `http://127.0.0.1:18080/gstack/api/...` and `http://127.0.0.1:18080/gstack/mcp` |
| Admin UI | `http://127.0.0.1:18081` on SATVADELL, or `https://<funnel-host>:10001` from the tailnet. **Never public.** |
| Config + secrets | `F:\DockerVolumes\GStackBrowserMCP\` (`keys.json`, `.env`, `secrets\`). **Back up `secrets\auth_profile_key`**: without it, saved logins can't be decrypted. |

Host checklist (plan §4.12):
- Turn on Docker Desktop's "Start when you sign in", and set up Windows auto sign-in.
- Set the machine to never sleep on AC power, and set lid close on AC to "Do nothing".
- Reserve 192.168.1.6 in the router.

### API keys
```powershell
.\scripts\new-key.ps1 -User alice                # prints the key once; only its SHA-256 is stored
.\scripts\new-key.ps1 -User bob -Role admin
.\scripts\new-key.ps1 -User alice -Rotate        # disable old keys, issue a new one
.\scripts\new-key.ps1 -User alice -Disable       # revoke
.\scripts\new-key.ps1 -List
```
The server picks up changes to `keys.json` within 5 seconds. Each user can run at most 3 sessions at once (set `maxSessions` per key to change this), and the server runs at most 10 in total. **Acceptable use:** test your own apps only. No scraping, spam or attacks. All browsing leaves through this server's IP, and every command is logged for 30 days.

### Updating and rolling back
```powershell
git pull; .\build-image.ps1 -SmokeTest -Deploy
.\build-image.ps1 -Deploy -Tag 0.1.0-abc1234      # roll back to a previous tag (the last 3 are kept)
```
### Updating gstack (upstream)
gstack is used unmodified, pinned to one commit in `.gstack-ref`. To pull in upstream changes:
```powershell
.\scripts\update-gstack.ps1                  # dry run: new commits + changed files that matter here
.\scripts\update-gstack.ps1 -Apply           # pin latest main, rebuild, run the smoke test
.\scripts\update-gstack.ps1 -Apply -Deploy   # ...and deploy if it passes
.\scripts\update-gstack.ps1 -Ref <sha> -Apply   # pin a specific commit instead
```
If the build or smoke test fails, the old pin is restored and the running stack stays as it was. If a problem only appears after deploying, roll back with `.\build-image.ps1 -Deploy -Tag <previous>`. Only the gstack layers are rebuilt, which takes about 10 minutes the first time.

After an update, also reinstall `browse-remote` in your projects if `client/browse-remote` changed. If gstack changed how skills find `$B` (`scripts/resolvers/runtime-root.ts`, which the dry run flags), check that the install path in `client/install.*` still matches.

---

## 2. Using it from gstack skills (`/qa`, `/browse`, …)

Install the client into the project you're testing. It must be a git repo.

```powershell
.\client\install.ps1 -Project "D:\Git Repos\MyApp" -Url "https://<funnel-host>/gstack" -TunnelPorts 3000
[Environment]::SetEnvironmentVariable('GSTACK_REMOTE_KEY', 'gsk_...', 'User')   # once
[Environment]::SetEnvironmentVariable('GSTACK_SKIP_ASIDE', '1', 'User')         # make skills use $B, not the Aside app
```
Use `./client/install.sh <project> <url> [ports]` on macOS or Linux. Node.js 22+ is required.

The installer places `browse-remote` at `<project>/.claude/skills/gstack/browse/dist/browse`, which is where gstack skills look first, and git-ignores it. After that, skills run `$B goto …`, `$B snapshot -i`, `$B screenshot shot.png` and so on as usual:
- **Sessions:** the first command starts a remote session and later commands reuse it. The session ID is kept in `.gstack/remote-session*.json`.
- **Files:** screenshots, PDFs, `responsive` shots and downloads are copied back to the local path the skill asked for. Local files you upload (`upload`, `load-html`, `eval`, `cookie-import`) are sent up first.
- **Stopping:** `browse stop` deletes the remote session, including its profile and files.
- **Checking the setup:** `browse remote-status` shows which server, session and tunnel are in use.

**Testing your own `localhost` app:** list its ports in `GSTACK_TUNNEL_PORTS` (or `-TunnelPorts`). `browse-remote` keeps a tunnel open, so the remote browser's `http://localhost:3000` is *your* `localhost:3000`, and cookies and OAuth callbacks keep working. Only the listed ports are reachable.

**Not available remotely:**
- `cookie-import-browser`: use `remote-auth` instead (§4).
- `connect` / `handoff` / `resume`: human takeover is planned for P8. Until then you get a message telling you to load an auth profile or mark the step as blocked.
- `pair-agent` and the `skill` / `domain-skill` commands.

---

## 3. Using it over MCP (any agent)

Endpoint (Streamable HTTP, header `Authorization: Bearer gsk_...`):
- on SATVADELL itself: `http://127.0.0.1:18080/gstack/mcp`, which is local only
- everywhere else: `https://<funnel-host>/gstack/mcp`, once published

**Claude Code: add a `.mcp.json` to the project.** It's safe to commit, because the key comes from an environment variable:
```json
{ "mcpServers": { "gstack-browser": {
    "type": "http",
    "url": "${GSTACK_MCP_URL:-http://127.0.0.1:18080/gstack/mcp}",
    "headers": { "Authorization": "Bearer ${GSTACK_REMOTE_KEY}" } } } }
```
Set `GSTACK_REMOTE_KEY` (and `GSTACK_MCP_URL` on other machines) as user environment variables, restart Claude Code, and approve the server when prompted. `/mcp` shows whether it's connected. You can also copy the "Using the remote browser" section of this repo's `CLAUDE.md` into the project's CLAUDE.md, so Claude knows to use these tools.

Or register it for yourself only, across every project:
```bash
claude mcp add --transport http --scope user gstack-browser https://<funnel-host>/gstack/mcp --header "Authorization: Bearer gsk_..."
```

| Tool | Purpose |
|---|---|
| `browser_start` | Start a session with a fresh profile. Options: `authProfile`, `authState`, `viewport`. Returns `sessionId` once it's ready (`wait` defaults to true; with `wait:false`, poll `browser_status`). |
| `browser_status`, `browser_list_sessions`, `browser_stop` | Check, list, or end a session. Stopping deletes everything. |
| `browser_goto`, `browser_snapshot`, `browser_click`, `browser_fill`, `browser_type`, `browser_press`, `browser_select`, `browser_hover`, `browser_scroll`, `browser_wait` | Navigate and interact. `browser_snapshot` returns `@e` refs that click and fill accept. |
| `browser_text`, `browser_links`, `browser_forms`, `browser_console`, `browser_tabs`, `browser_newtab`, `browser_switch_tab`, `browser_close_tab` | Read the page and manage tabs. |
| `browser_screenshot` | Returns the screenshot as an image. |
| `browser_command`, `browser_batch` | Run any gstack command (`responsive`, `pdf`, `js`, `cleanup`, `perf`, …), or several in a row. |
| `browser_get_file` | Fetch a file the session wrote. |
| `browser_set_auth_state`, `browser_export_auth_state`, `auth_profile_save`, `auth_profiles_list`, `auth_profile_delete` | Log in with saved cookies and storage (§4). |

MCP sessions and `browse-remote` sessions are the same thing. An agent can pick up a session ID that a skill started, if both belong to the same user.

---

## 4. Logged-in sessions (cookies + localStorage)

An auth state is cookies plus localStorage and sessionStorage for each site. Accepted formats:
- Playwright `storageState`
- Cookie-Editor or EditThisCookie exports
- gstack cookie JSON
- `{"origin": "...", "localStorage": {...}}`

```bash
browse remote-auth import auth.json          # load into the current session (reports OK/FAIL per site)
browse remote-auth save staging-admin        # save the current login as an encrypted, per-user profile
browse remote-auth use staging-admin         # load a saved profile into the current session
browse remote-auth export auth.json          # export (contains secrets: keep it out of git)
browse remote-auth profiles | delete <name>
GSTACK_REMOTE_AUTH_PROFILE=staging-admin     # every new session starts logged in
```

Ways to get an auth state:
- `npx playwright codegen --save-storage=auth.json https://your-app`
- export cookies with the Cookie-Editor extension, then add localStorage with `{"origin":…, "localStorage":{…}}`
- your test suite's login script

All cookie flags (`httpOnly`, `secure`, `sameSite`, expiry) are kept. Profiles are encrypted (AES-256-GCM) and private to their owner. Admins can list and delete profiles but can't read them. **Use test accounts only.**

---

## 5. Security model

- **No LAN access.** The browser container sits only on internal Docker networks. Every browser request goes through a per-session proxy, which:
  - accepts connections only from that session's Linux user
  - sends `localhost` traffic to the owner's tunnel
  - sends everything else to `egress-proxy`

  `egress-proxy` resolves DNS itself and refuses private, loopback, link-local, CGNAT (Tailscale), metadata and Docker addresses. VaultWarden, the databases, the router and other containers can't be reached. The smoke test checks this.
- **Isolation between sessions:**
  - Each session runs as its own Linux user (`gsess01…`) with its own `HOME`, `TMPDIR` and profile, and files are created with `umask 077`.
  - Other sessions can't read its files, use its proxy or reach its tunnel.
  - Users only see their own sessions.
- **Authentication:**
  - Per-user keys are stored as hashes only.
  - After 10 failed attempts from one IP within 5 minutes, that IP is locked out.
  - nginx rate-limits per client IP.
  - The admin UI is never routed through Funnel.
- **Secrets:**
  - Auth states and profile values never appear in logs, the timeline or metrics.
  - `fill`/`type`/`header`/`cookie` arguments are redacted in the audit log (`/data/logs`, kept 30 days).
- **Upstream protections:** gstack's own prompt-injection markers, path checks and CDP allowlist stay on.

## 6. Operations

| Task | Command |
|---|---|
| Logs | `docker logs -f gstack-browser-mcp` · `docker logs gstack-egress-proxy` (allowed and denied destinations) |
| Health | `curl http://127.0.0.1:18081` (admin) · `docker exec gstack-browser-mcp curl -s localhost:8080/api/health` |
| Audit log | `docker exec gstack-browser-mcp ls /data/logs` (JSON lines, one file per day) |
| Kill sessions | Admin UI → Kill / Kill idle, or `DELETE /gstack/api/sessions/<id>` |
| Config | `F:\DockerVolumes\GStackBrowserMCP\.env`: `MAX_SESSIONS`, `DEFAULT_USER_MAX_SESSIONS`, `SESSION_IDLE_TIMEOUT` (ms), `ALLOWED_URL_PATTERNS`, `EGRESS_ALLOW` |

Resources: about 290 MB per session (measured). The container is capped at 6 GB RAM, 4 CPUs and 2 GB `/dev/shm`. A new session is refused when less than 500 MB of memory is free.

### REST API (used by `browse-remote`)
`Authorization: Bearer gsk_...` on everything except `/api/health`. All paths are under `/gstack`.

| Method | Path | |
|---|---|---|
| GET | `/api/health`, `/api/me` | Health check; who you are and current usage |
| POST | `/api/sessions` | `{viewport?, authProfile?, authState?, wait?}` → `{session}` |
| GET/DELETE | `/api/sessions/{id}` | Status (`?wait=30` waits until ready) / delete |
| POST | `/api/sessions/{id}/exec` | `{command, args[], stdin?}` → `{exitCode, stdout, stderr, files[]}` |
| PUT/GET | `/api/sessions/{id}/files/{path}` | Upload a file (to `files/…`) / download an output |
| POST/GET | `/api/sessions/{id}/auth-state` | Apply / export an auth state |
| POST | `/api/sessions/{id}/tunnel-ticket` | `{ports}` → one-time ticket for `wss://…/gstack/tunnel` |
| GET/POST/DELETE | `/api/profiles[/{name}]` | Saved auth profiles |

## License
MIT. Bundles gstack (MIT, © Garry Tan). gstack's `LICENSE`, `NOTICE.md` and `licenses/` ship unchanged inside the image at `/opt/gstack`.
