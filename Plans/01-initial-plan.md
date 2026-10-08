# GStack Browser MCP: Initial Plan

**Status:** Draft v0.2 (updated after research; see [02-research-findings.md](02-research-findings.md)) · **Date:** 2026-10-08 · **Owner:** rohanp@satvasolutions.com

## 1. Goal

Run the gstack headless browser (`browse`, see [gstack BROWSER.md](https://github.com/garrytan/gstack/blob/main/BROWSER.md)) inside a Docker container instead of on each developer's machine, so that:

1. **gstack skills** (`/qa`, `/browse`, `/design-review`, …) drive the remote browser **without modification**.
2. **Other AI agents** can drive the same browsers through an **MCP server**. An agent asks for a session, is told to wait, gets a session ID, then sends commands.
3. A **management UI** lists active sessions, their command history, and a **live view** of each browser.
4. A **`build-image.ps1`** script builds a versioned Docker image that other projects can use.

### Non-goals (v1)
- Replacing gstack with a custom Playwright implementation. Skills depend on gstack's exact command output, such as the `@e` refs and text formats.
- Multi-node scaling or orchestration. One container, many sessions.
- Using the developer's local browser profile (`cookie-import-browser` and headed `connect`).

## 2. Key Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Run the **real gstack `browse` CLI + daemon from the original upstream repo** (MIT license, pinned SHA, no fork) in the container | Output is identical to a local run, so skills don't break. No re-implementation. The only change is an optional build-time patch for the live view (D9). |
| D2 | Server runs the **gstack CLI for each command** (`BROWSE_STATE_FILE` per session) instead of calling the daemon's HTTP API directly | The daemon's HTTP API is internal and undocumented. The CLI is the interface the skills use, and the 100–200 ms per call is acceptable. |
| D3 | **Node.js / TypeScript** server | gstack is TypeScript on Bun, so one runtime serves both. The MCP TypeScript SDK is the most complete. |
| D4 | A **`browse-remote` client** installed at `<repo>/.claude/skills/gstack/browse/dist/browse`, plus `GSTACK_SKIP_ASIDE=1` | **Confirmed by research.** Skills check this path before `$HOME` and have no other way to choose a browser. The upstream CLI can't reach a remote daemon (it's hardcoded to `127.0.0.1`). |
| D5 | **One session = one gstack daemon + Chromium** | Matches gstack's design and keeps sessions fully isolated. Costs about 200–400 MB per session. |
| D6 | Separate ports: **8080** (client API + MCP) and **8081** (admin UI) | The admin UI can stay on a private network. |
| D7 | gstack version is **pinned at image build time by commit SHA** (`-GstackRef`) | gstack has no tags or releases and gets several commits a day, so builds must be reproducible. |
| D8 | **No Playwright re-implementation, and no relying on "use our MCP" instructions** to steer gstack skills | Research (§3 of 02) showed CLAUDE.md and skill instructions are advisory. A hook could enforce them, but skills would then translate `$B` steps to MCP tools on the fly and break their output markers. MCP is for our own and other agents. |
| D9 | Live view: **polling `screenshot --base64`** by default; **DevTools screencast** through an optional build-time patch that opens a DevTools port | gstack opens no DevTools port and has no screencast. If the patch fails to apply, the live view falls back to polling. |

## 3. Architecture

```
 Developer machine                                   Docker container (Linux)
 ─────────────────                                   ────────────────────────────────────────────
 gstack skill (/qa ...)                              Node server
   $B goto ... ──► browse-remote (client) ─HTTPS──►  :8080  /api/*   (client REST API)
                                                     :8080  /mcp     (MCP Streamable HTTP)
 Other AI agent ──MCP─────────────────────────────►          │
                                                             ▼
 Browser (admin) ─────────────────────────────────►  :8081  Admin UI + WebSocket
                                                             │
                                                     SessionManager ── CallLog ── ScreencastHub
                                                             │
                                          ┌──────────────────┼──────────────────┐
                                          ▼                  ▼                  ▼
                                   session A            session B            session C
                                   /data/sessions/A     /data/sessions/B     ...
                                   browse CLI ► daemon ► Chromium (one each)
```

## 4. Components

### 4.1 SessionManager (`src/core/sessionManager.ts`)
- **Session record:** `{ id, status, createdAt, lastActivityAt, owner, dir, options, currentUrl, tabCount }`.
- **Status lifecycle:** `starting → ready → (busy) → stopping → stopped | failed`.
- **Creating a session:**
  1. Create `/data/sessions/<id>/` with `files/`, `uploads/` and `.gstack/` inside.
  2. Run `browse status` there to start the daemon, with this environment:
     - working directory set to the session folder (gstack only writes output files under its working directory or a temp dir)
     - `BROWSE_STATE_FILE=<dir>/.gstack/browse.json`
     - `BROWSE_PORT` and `AUTH_TOKEN` chosen by the server for this session
     - `CONTAINER=1` (Chromium runs with `--no-sandbox`)
     - `BROWSE_PARENT_PID=0` (stops the daemon from shutting down when the CLI process exits)
     - `GSTACK_SKIP_ASIDE=1`

     The daemon listens only on `127.0.0.1`, so it can't be reached from outside the container. The server knows each session's port and token, so it can also read `/health` and `/activity/stream`, the gstack feed that fills the command timeline.
  3. Mark the session `ready` once `status` reports healthy.
  4. Return immediately with `status: "starting"`. Callers poll or long-poll until it's ready.
- **Per-session options:**
  - `GSTACK_STEALTH` (stealth mode)
  - `BROWSE_PERSIST_STATE` (save state automatically)
  - `BROWSE_IDLE_TIMEOUT` (idle shutdown)
  - a starting viewport
- **Commands in order:** one queue per session, so commands never overlap. This matches how a single local CLI behaves.
- **Limits:**
  - `MAX_SESSIONS`; past it, creating a session fails with `429`.
  - A reaper ends sessions idle longer than `SESSION_IDLE_TIMEOUT`, and wipes them exactly as `DELETE` does (below).
- **Every session gets a brand-new, separate browser profile (decided):**
  - **Nothing is shared between sessions or carried over from older ones:** no cookies, localStorage, sessionStorage, IndexedDB, cache, service workers, permissions, history or downloads. Every session starts as a clean, never-used browser.
  - **The whole profile lives inside `/data/sessions/<id>/`:**
    - `CHROMIUM_PROFILE=<dir>/profile` for headed mode
    - Headless mode uses gstack's default in-memory context, so nothing touches disk.
    - `BROWSE_STATE_FILE`, the working directory, `state save` files, uploads and outputs all stay under `<dir>`.
    - `BROWSE_PERSIST_STATE` is never set.
  - **On `DELETE`, or when the reaper ends a session:**
    1. Stop the daemon, then kill any leftover Chromium processes for that session.
    2. **Delete the whole `/data/sessions/<id>/` folder at once**: profile, cookies, storage, uploads, screenshots and downloads.
    3. Remove the session from memory.
  - **Nothing is kept after deletion.** If you want a screenshot or file, download it before deleting the session. To keep a login, save it as an **auth profile** first (§4.10). That's the only thing that outlives a session, and only when it's saved explicitly.
  - **Tests (P2):**
    - Session A sets a cookie and localStorage, and session B, running at the same time, can't see them.
    - After deleting A, its folder and processes are gone.
    - A new session on the same site starts logged out.
- **Startup recovery:** on server start, kill any leftover daemons and **wipe every leftover session folder**, using the same deletion as above. Sessions don't survive a server restart.

### 4.2 Running commands (`src/core/exec.ts`)
- Calls `spawn(browsePath, [command, ...args], { cwd: sessionDir, env: sessionEnv, stdin? })`.
- Returns `{ exitCode, stdout, stderr, durationMs, files: [...] }`. `stdout` passes through unchanged.
- Each command has a timeout (default 60 s, configurable per call).
- **Allowlist**, configured in `commandCatalog.ts`. These commands are rejected:
  - `cookie-import-browser`, `connect`, `disconnect`, `focus`, `pair`, `unpair`, `inbox`
  - `restart`, which the server handles itself as a session restart
  - `stop`, which maps to ending the session
- **Paths:** every path argument is rewritten to stay inside `/data/sessions/<id>/`. This blocks escaping the folder with `..` or absolute paths.

### 4.3 Client REST API (`src/api/*`), used by `browse-remote`

| Method & path | Purpose |
|---|---|
| `POST /api/sessions` | Create a session. Body: options. Returns `{ id, status }`. |
| `GET /api/sessions/{id}?wait=30` | Session status. With `wait`, holds the request until the session is `ready` or the timeout passes. |
| `DELETE /api/sessions/{id}` | Stop the session and **permanently delete its browser profile and all its files** (§4.1). |
| `POST /api/sessions/{id}/exec` | `{ command, args[], stdin?, timeoutMs? }` → result from 4.2. |
| `POST /api/sessions/{id}/files` | Upload a file (multipart). Returns its path in the container. |
| `GET /api/sessions/{id}/files/{path}` | Download a file the browser wrote. |
| `GET /api/health` | Health check, used by Docker. |

Auth: `Authorization: Bearer <user API key>` on everything except `/api/health`. Every session route checks ownership (§4.9).

### 4.4 `browse-remote` client (`client/browse-remote`)
- A single Node script with the shebang `#!/usr/bin/env node`, installed as `browse` (no file extension) so it runs from Git Bash, macOS and Linux.
- **Install location:** `<project>/.claude/skills/gstack/browse/dist/browse`. The skills look there before `$HOME/.claude/skills/...`, so the local gstack install stays available to other projects. The spike must confirm this lookup order (see §7).
- **Config:**
  - `GSTACK_REMOTE_URL` and `GSTACK_REMOTE_KEY` (required)
  - `GSTACK_REMOTE_SESSION` (optional, pins a session)
  - these can also go in `.gstack/remote.json`
- **Session handling:**
  - The first command creates a session, prints `Starting remote browser session…` to stderr, and waits until it's ready.
  - The session ID is saved in `.gstack/remote-session.json` and reused by later commands.
  - If the server reports the session as `404`, `stopped` or `failed`, the client creates a new one once and retries the command.
  - `browse stop` ends the remote session and deletes the local record.
- **Rewriting file arguments:**
  - **Files the browser writes**: `screenshot`, `pdf`, `responsive`, `prettyscreenshot`, `archive`, `download`, `scrape --dir`, `snapshot -o`/`-a`, `state save`.
    1. The client swaps the local path for a path inside the session.
    2. It runs the command.
    3. It downloads each new file to the local path the skill asked for.
  - **Files the browser reads**: `upload`, `load-html`, `cookie-import`, `pdf --from-file`.
    1. The client uploads each local file.
    2. It swaps in the remote path, then runs the command.
  - **Commands read from stdin** (`chain`, `batch`): the client forwards stdin and applies the same path rewriting to the commands inside.
- **Exit codes and output:** the client exits with the remote exit code and writes stdout and stderr exactly as received, so skills can't tell it apart from a local run.
- **Installer:** `client/install.ps1` (Windows) and `client/install.sh`. Both copy the client into the target project and write `.gstack/remote.json`.

### 4.5 MCP server (`src/mcp/*`)
- Uses the Streamable HTTP transport at `/mcp` on `:8080`, using the same per-user API keys and session ownership rules.
- **Session tools:**
  - `browser_start(options, wait?)` → `{ sessionId, status }`
  - `browser_status(sessionId, waitSeconds?)`
  - `browser_stop(sessionId)`
  - `browser_list_sessions()`
- **Typed tools** for the commands agents use most:
  - `goto`, `snapshot`, `click`, `fill`, `type`, `press`, `select`, `hover`, `scroll`, `wait`
  - `text`, `links`, `forms`
  - `tabs`, `newtab`, `tab`, `closetab`
  - `screenshot`, which returns MCP image content
- **Generic tools:**
  - `browser_command(sessionId, command, args[])` covers every allowed command.
  - `browser_batch(sessionId, commands[][])` runs several commands in one call.
- **Files the browser writes** come back as MCP resources (`session://<id>/files/<path>`), or as base64 for small images.
- **Shared sessions:** MCP and `browse-remote` use the same sessions, so one can be handed off to the other.

### 4.6 Admin UI (`ui/` + `src/admin/*`)
- **Stack:** Vite + React, built into static files served by the Node server on `:8081`. Live updates come over a WebSocket.
- **Auth:** log in with an API key that has the admin role; the key is exchanged for an HttpOnly session cookie. SSO is added in P7 (decided). Ordinary users can also log in, and see only their own sessions.
- **Pages:**
  - **Sessions:** a live table with ID, status, owner (client or MCP), created, last activity, URL, tabs and memory. Actions: Kill, Kill idle.
  - **Session detail:**
    - live view
    - command timeline, with command, args, exit code, duration and output preview, for every call through the client or MCP
    - console and network tabs, from `console` and `network`
    - files list with downloads
- **Live view:**
  - **v1, polling:** while someone is watching, the server requests `screenshot --viewport` about every second (1–2 fps). Commands from agents go first, so polling never makes them wait.
  - **v2, CDP screencast:** the Dockerfile patches gstack so Chromium opens a DevTools port reachable only inside the container (`127.0.0.1`). `ScreencastHub` attaches with `Page.startScreencast` and sends the JPEG frames over the WebSocket, at 10–25 fps.
  - **v3 (optional):** mouse and keyboard input through CDP `Input.*` events, enough to clear a CAPTCHA by hand. Alternatively, a headed browser with Xvfb + noVNC, which would also enable gstack's `handoff`/`resume` (a human takes over, then hands control back).

### 4.7 Docker image (`docker/Dockerfile`)
- **Build stages:**
  1. **gstack:** start from ubuntu:24.04 plus Bun, following upstream's `.github/docker/Dockerfile.ci`. Clone `https://github.com/garrytan/gstack` at `GSTACK_REF`, then run `bun install && bun run build && bunx playwright install --with-deps chromium`.
     - The build produces executables that only run on the platform they were built on, so it must run on Linux.
     - The CLI starts the daemon from `server.ts`, so the **whole gstack folder plus Bun** goes into the runtime image, not just the binary.
  2. **Server:** run `npm ci && npm run build` for `src/` and `ui/`.
  3. **Runtime:** start from `mcr.microsoft.com/playwright` (Chromium system libraries already included) and add Bun.
     - Copy in the `browse` binary and Playwright's Chromium.
     - Copy in the built server and UI.
- **Runtime settings:**
  - non-root user `gstack`
  - `tini` (an `--init` process)
  - `EXPOSE 8080 8081`
  - `VOLUME /data`
  - a `HEALTHCHECK` against `/api/health`
- **Labels:** the image is labelled with `gstack.ref` and the server version.
- **How it should be run:** use the compose stack in §4.9. For a quick local try: `docker run --shm-size=1g --init -p 127.0.0.1:18080:8080 -p 127.0.0.1:18081:8081 -v ./keys.json:/config/keys.json:ro gstack-browser-mcp:<tag>`. This uses host ports 18080/18081 because 8080 is already taken on SATVADELL (§4.12).
- `docker-compose.example.yml` shows how another project would use the image.

### 4.9 Deployment: shared dev server, publicly reachable
The container runs on **one shared dev server (SATVADELL, §4.12)**. Team laptops **and cloud or external AI agents** must reach the API and MCP (decided), so they are **published to the internet** through the existing **Tailscale Funnel + nginx-proxy**. **The browser runs inside the company network, so everything in "Public exposure hardening" below is required. Nothing goes live on Funnel until that checklist passes.**

**Topology**
```
 Internet (team laptops, cloud agents)
   │ HTTPS (TLS terminated by Tailscale Funnel, *.ts.net cert)
   ▼
 tailscale-funnel ─► nginx-proxy  (existing, F:\DockerVolumes\ReverseProxy)
                       │  /gstack/api/*  /gstack/mcp  /gstack/tunnel  ONLY
                       │  rate limits · body limits · timeouts · access log
                       ▼  (docker network "gstack-edge": only nginx + our server)
                    gstack-browser-mcp :8080  (API + MCP + tunnel endpoint)
                       │  :8081 admin UI ──► host 127.0.0.1:18081 (+ optional tailnet `serve`), NEVER Funnel
                       ▼  (docker network "gstack-egress", internal: no direct route out)
                    egress-proxy (smokescreen) ──► internet (public IPs only)
```
- **Compose stack** (`deploy/docker-compose.yml`, config in `F:\DockerVolumes\GStackBrowserMCP\`):
  - **Services:** `gstack-browser-mcp` and `egress-proxy`.
  - **Networks:**
    - `gstack-edge`: shared with `nginx-proxy` only.
    - `gstack-egress`: an `internal: true` network shared with `egress-proxy` only.
    - **Not** `clarityautobuild_default` or any other project's network.
  - **Settings:** `restart: unless-stopped`, `shm_size: 2gb`, `mem_limit: 6g`, `cpus: 4`, named `data` volume.
- **Changes to the existing reverse proxy:** these are in `F:\DockerVolumes\ReverseProxy` and get reviewed in P6:
  - Add the `/gstack/` location blocks to nginx.
  - Connect `nginx-proxy`'s network to `gstack-edge`. Its network is shared with the `tailscale-funnel` container.
  - The server accepts a `BASE_PATH=/gstack` setting, so it runs under that path on the shared Funnel hostname.
  - **Decided: use the `/gstack/` path on the existing Funnel hostname**, on port 443. No separate port.
- **TLS:** Tailscale Funnel provides valid certificates automatically. HTTP traffic inside the server, nginx to container, stays on the internal Docker network.
  - `browse-remote` and MCP clients require HTTPS. `GSTACK_REMOTE_INSECURE=1` allows HTTP for local testing only.
- **Admin UI:** **never published through Funnel**.
  - Locally on SATVADELL at `http://127.0.0.1:18081`.
  - For the team, optionally through `tailscale serve`, which reaches tailnet members only.

**Public exposure hardening (required before going live)**
1. **Lock down where the browser can connect.** This is the most important step.
   - Our container has **no direct route out**: it's on an internal Docker network only.
   - All Chromium traffic goes through `BROWSE_PROXY_URL`, which points at our server's **per-session proxy** (see "Reaching apps on a developer's laptop" below).
   - That proxy sends everything except tunnel traffic to **smokescreen**. Smokescreen blocks **every private, loopback, link-local, CGNAT and Docker address** after DNS resolution. That covers:
     - `10/8`, `172.16/12`, `192.168/16`, `127/8`, `169.254/16`
     - `100.64/10` (Tailscale), `host.docker.internal`, and IPv6 ULA and link-local addresses
   - This protects VaultWarden, MSSQL, Postgres, Paperless, the router and every container on the host.
   - Allowing specific internal targets is opt-in, per user, through `EGRESS_ALLOW` (only if ever needed).
   - **Test:** from a session, `goto http://192.168.1.6:8654`, `http://host.docker.internal:5432` and `http://169.254.169.254` must all fail.
2. **Authentication:**
   - Per-user keys of 32+ random bytes, prefixed `gsk_`, stored as hashes only (below).
   - **Lockout** after 10 failed attempts per IP in 5 minutes. Rotation with `new-key.ps1 -Rotate`, and revocation by removing the key from `keys.json`, which takes effect immediately.
   - The audit log records every authentication failure.
   - **Later (decided, P7):** oauth2-proxy SSO in front of the admin UI and `/gstack/`. API keys keep working for agents.
3. **Limits at nginx:**
   - `limit_req` per IP and per key.
   - `client_max_body_size 50m`, which matches the gstack upload limit.
   - Read and send timeouts, with longer ones for the long-poll and tunnel WebSocket.
   - No directory listing, and only these paths: `/gstack/api/*`, `/gstack/mcp`, `/gstack/tunnel`.
4. **Inside the app:**
   - Every session route checks ownership.
   - The command allowlist (§4.2).
   - Path containment.
   - Auth state is encrypted, and secrets are redacted (§4.10).
   - `TRUST_PROXY` trusts `X-Forwarded-For` only from nginx's address.
5. **Exposure check (P6 exit gate):**
   - an external port scan shows only Funnel's 443
   - `/gstack/admin` returns 404 from the internet
   - the SSRF tests from step 1 pass
   - the lockout works
   - no secrets appear in logs

**Multiple users: auth, ownership and quotas**
- **One API key per developer**, instead of a single shared `API_KEY`.
  - Keys are listed in `/config/keys.json` as `{ "<sha256 of key>": { "user": "rohan", "role": "user|admin", "maxSessions": 3 } }`, so the file holds only hashes.
  - The file is reloaded automatically when it changes.
  - Script: `scripts/new-key.ps1 -User <name>` creates a key, prints it once, and adds its hash to the file.
- **Session ownership:**
  - Every session records the user who created it.
  - Ordinary users can only see and drive **their own** sessions, through both the API and MCP.
  - Admins can see and kill any session.
  - A session can be shared with someone else explicitly (`POST /api/sessions/{id}/share`), so another person's agent can pick it up.
- **Quotas:**
  - A server-wide `MAX_SESSIONS` plus a per-user `maxSessions`. When either is full, creating a session fails with `429`, and the error says whose sessions are using the slots. Community users see only a count, not names.
  - **No usage limits per key (decided).** There are no command, page-load or runtime limits. Only the session caps apply: 10 in total and 3 per user. Misuse is handled by revoking the key.
- **Admin UI login:**
  - v1: an admin-role API key, exchanged for an HttpOnly session cookie.
  - Later (decided, P7): SSO through the reverse proxy with oauth2-proxy, for example GitHub login, which suits a community project.
- **Audit log:** each command is logged with user, session, command, a redacted version of the arguments, timestamp and outcome. Logs are written as JSON lines to `/data/logs` and **kept for 30 days**. Traffic to other sites comes from SATVADELL's public IP, so we need to be able to trace any abuse back to a key.

**Reaching apps on a developer's laptop (important)**
QA skills usually test **`http://localhost:3000` on the developer's own laptop**. Callers connect over the internet from behind NAT, and private addresses are blocked on purpose. So **swapping in the laptop's IP can't work**, and the **reverse tunnel is required in v1** (phase P3b):
- **The tunnel:** `browse-remote` (and an optional `gstack-tunnel` helper for MCP users) opens an authenticated WebSocket to `/gstack/tunnel` and keeps it open for the session.
- **Per-session proxy:**
  - Each session's Chromium uses `BROWSE_PROXY_URL=http://127.0.0.1:<per-session port>`, served by our server.
  - Requests for `localhost`/`127.0.0.1:<port>` go **down that session owner's tunnel**, and the laptop forwards them to its own `localhost:<port>`.
  - Everything else goes to smokescreen.
  - **Allowed ports:** only those the developer lists (`GSTACK_TUNNEL_PORTS=3000,5173`), so the tunnel can't be used to probe the laptop.
- **Hostname kept as `localhost`:** cookies, CORS and OAuth callbacks keep working unchanged.
- **Shared environments:** testing public staging URLs always works without a tunnel.
- **P1 spike checks:** that `BROWSE_PROXY_URL` can be set per session, and that Chromium doesn't skip the proxy for `localhost`. If it does, the fix is the `--proxy-bypass-list=<-loopback>` flag.

**Network rules (summary)**
- **Network level (required):** an internal-only Docker network plus smokescreen blocks private ranges after DNS resolution. This also catches redirects, sub-resources and DNS-rebinding attacks.
- **App level (extra):** the server rejects `goto`/`newtab` URLs that point at private addresses before they reach the browser, with a clear error. `ALLOWED_URL_PATTERNS` can narrow the allowed sites further.

**Running it**
- **Capacity: `MAX_SESSIONS=10` (decided).**

  | Item | Estimate |
  |---|---|
  | One headless session (gstack daemon + Chromium) | ~300–400 MB, more on heavy pages |
  | One headed session (Xvfb display, for human takeover) | +~100 MB |
  | Node server, admin UI, base system | ~0.5–1 GB |
  | **10 sessions at once, worst case** | **~5–6 GB** |

  - **Container limits:** `mem_limit: 6g`, `shm_size: 2gb`, `cpus: 4`.
  - **The Linux side (VM or WSL2) needs at least 8 GB RAM and 4 vCPUs.** The Windows host needs 12–16 GB in total (§4.11).
  - **Before starting a session**, the server checks that free memory in the container is above 500 MB (`MIN_FREE_MEMORY_MB`). If not, it refuses with `503`, even when there are fewer than 10 sessions. This prevents the kernel from killing a Chromium in the middle of a run.
  - **Measure it:** the P1 spike records real memory per session (from `memory --json`). Update these numbers then.
- **Updates:** on the server, run `git pull && ./build-image.ps1 -SmokeTest -Deploy` (§4.8). Rollback is `-Deploy -Tag <previous>`.
  - The server waits up to 60 s for running commands to finish before shutting down, and records which sessions were active.
  - Clients see the stopped session and start a new one automatically (§4.4).
- **Backups:** not needed. Session data is temporary. Only `F:\DockerVolumes\GStackBrowserMCP\` needs keeping: `keys.json`, `.env` and `AUTH_PROFILE_KEY`. Losing `AUTH_PROFILE_KEY` makes saved auth profiles unreadable.
- **Monitoring:** `/api/health` for Docker and uptime checks. `/api/metrics` (Prometheus format) for active sessions per user, command latency, failed starts and memory.

### 4.8 `build-image.ps1`
**Decided: the image is built directly on the shared dev server.** No registry is needed. The image lives in the server's local Docker as `gstack-browser-mcp:<tag>`, and the compose stack uses it from there.
- **Two scripts:** `build-image.ps1` runs anywhere PowerShell 7 (`pwsh`) does, including Linux. `build-image.sh` is a bash version for Linux servers without `pwsh`. Both take the same options.
- **Decided: a Windows server running Linux containers only.** `build-image.ps1` is the main script. It must work in **Windows PowerShell 5.1 and PowerShell 7**, so it avoids `&&`, `??` and ternaries. `build-image.sh` stays for anyone building on Linux. How Docker is set up on the Windows host is covered in §4.11.
- **Line endings:** `.gitattributes` forces LF for `*.sh`, `client/browse-remote`, `Dockerfile` and `docker/**`. A Windows checkout with CRLF line endings would break the image build and the client.
- **Server workflow:** `git pull` the repo on the server, run `./build-image.ps1 -SmokeTest`, then `docker compose up -d`.
- **Registry later:** `-Registry`/`-Push` stay as options for when other servers or projects need the image (e.g. `ghcr.io/<org>/gstack-browser-mcp`). They aren't used in v1.

```powershell
./build-image.ps1 [-Tag <ver>] [-GstackRef <sha|branch>] [-NoCache] [-Platform linux/amd64]
                  [-SmokeTest] [-Deploy] [-Registry <host/ns> -Push]
```
1. Check that Docker is installed and running, and that buildx is available.
2. Work out the defaults:
   - `Tag` comes from `package.json` version plus the short git SHA.
   - `GstackRef` comes from the `.gstack-ref` file in the repo.
3. Run `docker buildx build --build-arg GSTACK_REF=… --platform … -t <name>:<tag> -t <name>:latest --load`.
4. With `-SmokeTest`:
   1. Start the container on random ports and wait for `/api/health`.
   2. Run `browse-remote goto https://example.com`, then `text`, which must contain "Example Domain".
   3. Run `screenshot`, which must produce a PNG on the local machine.
   4. Run MCP `browser_list_sessions`.
   5. Remove the container.
5. With `-Deploy`, update the running stack:
   - Point the compose stack at the new tag with `IMAGE_TAG` in `deploy/.env`, then run `docker compose up -d`. Running commands get up to 60 s to finish before shutdown (§4.9).
   - Remove old image tags, keeping the last 3 so you can roll back.
   - **Rollback:** `./build-image.ps1 -Deploy -Tag <previous>` switches back without rebuilding.
6. Later, with `-Registry … -Push`: push both tags to that registry.
7. Exit non-zero on any failure, so the script can run in CI.

### 4.10 Logged-in sessions (cookies + localStorage)
QA runs need sessions that are **already logged in**. gstack's QA rules say "never type passwords… sessions are pre-authenticated". Users can therefore supply an **auth state**: cookies, plus localStorage and sessionStorage for each origin. They can supply it once when a session is created, or load it into a running session.

**Format.** The server accepts a Playwright `storageState` JSON, extended with sessionStorage. Other formats are converted on upload (below).
```json
{
  "cookies": [ { "name": "sid", "value": "…", "domain": ".app.example.com", "path": "/",
                 "expires": 1767225600, "httpOnly": true, "secure": true, "sameSite": "Lax" } ],
  "origins": [ {
      "origin": "https://app.example.com",
      "localStorage":   [ { "name": "auth_token", "value": "…" } ],
      "sessionStorage": [ { "name": "tab_state",  "value": "…" } ],
      "landingPath": "/"
  } ]
}
```
- **Other formats accepted and converted:**
  - gstack's `cookie-import` JSON
  - Cookie-Editor and EditThisCookie exports (browser extensions)
  - a plain `{ "localStorage": {k: v} }` together with an `origin` argument
- **Validation:**
  - Limits: 5 MB per auth state, 200 origins, and gstack's own cookie limits.
  - Cookies with `expires` in the past are dropped, with a warning.

**How it gets into the browser**, using gstack commands only, with no patch:
1. **Cookies:** the server writes them to the session folder and runs `cookie-import <file>`.
2. **localStorage/sessionStorage:** these belong to an origin, so they can only be set from a page on that origin. For each origin, the server:
   1. runs `goto <origin><landingPath>` (default `/`)
   2. writes the values with `js` (`localStorage.setItem` / `sessionStorage.setItem` in one call per origin)
   3. runs `reload`, so the app starts up with the new state.
3. **Afterwards:** goes back to `about:blank`, or to the URL the caller asked for.
4. **Timing:**
   - The session is marked `ready` only after the auth state is applied.
   - If anything fails, the session is `failed` with the reason, e.g. "origin https://x unreachable".
5. **sessionStorage limitation:** it belongs to a single tab, so it's applied to the first tab only. This is documented as such.

The P1 spike checks whether gstack's `storage set` covers this and whether `cookie-import` keeps `httpOnly` and `sameSite`. If `storage set` is enough, it replaces `js`.

**Ways to pass it in**

| Entry point | How |
|---|---|
| REST | `POST /api/sessions` with `{ authState: {…} }` or `{ authProfile: "staging-admin" }`. `POST /api/sessions/{id}/auth-state` loads it into a running session. `GET /api/sessions/{id}/auth-state` exports the current cookies, localStorage and sessionStorage. |
| `browse-remote` | **Config:** `GSTACK_REMOTE_AUTH_STATE=./.gstack/auth/staging.json` or `GSTACK_REMOTE_AUTH_PROFILE=staging-admin` (also accepted in `.gstack/remote.json`), applied when the session is created. **Client-only commands:** `browse remote-auth import <file>`, `browse remote-auth save <profile>`, `browse remote-auth use <profile>`. **`cookie-import-browser`** gets a clear error that points to these commands. |
| MCP | `browser_start({ authState?, authProfile? })`, `browser_set_auth_state(sessionId, authState \| authProfile)`, `browser_export_auth_state(sessionId)`, `auth_profiles_list()`, `auth_profile_save(sessionId, name)`, `auth_profile_delete(name)` |
| Admin UI | On a session's page: upload an auth state, or "Save as profile". On a Profiles page: list, rename, delete, and see expiry. Values are never shown. |

**Saved auth profiles (recommended workflow).** Log in once, then reuse:
1. **v1:** upload an exported auth state (see "Getting an auth state" below). **From P8:** you can also log in by hand through **human takeover** (noVNC).
2. "Save as profile" captures cookies, localStorage and sessionStorage under a name such as `staging-admin`.
3. Every QA run starts with `authProfile: "staging-admin"`. Nobody needs a local browser and nobody pastes cookies again.

Details:
- **Scope (decided):** profiles are **strictly per user**. There's no sharing with other users or the team. Admins can only list and delete them.
- **Expiry:** each profile records the earliest cookie expiry. The UI and `auth_profiles_list` flag profiles that have expired or will expire within 24 hours.

**Getting an auth state without the remote browser**, documented in the README:
- **Cookie-Editor extension:** export to JSON, then for localStorage copy from DevTools → Application → Local Storage. A helper snippet does the localStorage part.
- **Playwright:** `npx playwright codegen --save-storage=auth.json <url>`.
- **Login scripts:** a project's existing test login script writes a `storageState`.

**Security.** This data gives full access to accounts:
- **Encrypted at rest:** profiles are encrypted with AES-256-GCM using `AUTH_PROFILE_KEY` (an env var or Docker secret). Uploaded files in session folders are deleted once applied.
- **Hidden everywhere:** cookie values and storage values **never** appear in logs, the timeline, metrics, or MCP responses, except `export_auth_state`, which only the owner can call.
- **Ownership:** only the owner, or users a profile is shared with, can use it. Admins can list and delete profiles but **can't read their contents**.
- **Cleanup:** when a session ends, its whole browser profile is deleted (§4.1). Saved auth profiles are stored separately, encrypted, outside session folders, and survive only because they were saved explicitly. `BROWSE_PERSIST_STATE` stays off.
- **Login flags must survive the import (decided requirement):** after `cookie-import`, each cookie must keep its `httpOnly`, `secure`, `sameSite`, `domain`, `path` and `expires`, and the user must actually be logged in. Tested in the P1 spike and in P3c on a real login-protected app. If gstack's `cookie-import` drops any flag, the server sets cookies through gstack's `cdp` command (`Network.setCookies`) instead.
- **Guidance:** the README recommends **test accounts only**, never personal or production admin sessions, because the dev server is shared.

### 4.11 Windows host running Linux containers
The dev server runs **Windows**, and the container is **Linux**. There are three ways to run Linux containers on a Windows host:

| Option | Fits | Pros | Cons |
|---|---|---|---|
| **A. Docker Desktop (WSL2 backend)** | Windows 10/11 Pro/Enterprise | Easiest. Ports are published to Windows automatically. | Not supported on Windows **Server**. **Only runs while a user is logged in**, so after a reboot nothing starts until someone logs in. Needs a **paid licence** for companies with more than 250 employees or more than $10M revenue. |
| **B. Docker Engine inside WSL2 (Ubuntu)** | Windows 11 / Windows Server 2022+ | Free. Close to native Linux. | Has to be started at boot with a Task Scheduler job (`wsl -d Ubuntu -u root -- service docker start`). Making ports reachable from the network needs WSL **mirrored networking** or `netsh portproxy` plus a firewall rule. |
| **C. Hyper-V Ubuntu VM with Docker Engine** (recommended for a shared server) | Windows Server or Pro with Hyper-V | Behaves like a real Linux server: systemd, `restart: unless-stopped`, starts on boot without anyone logging in, and its own IP on the LAN (external switch). Easy to resize or snapshot. | It's an extra VM to patch. |

**Recommendation:** **C** if the server is Windows Server or must keep running unattended. **A** only for a quick trial on a Windows 10/11 machine.

**Sizing on Windows.** Windows itself needs RAM too:
- **Linux side:** give the VM or WSL2 **8 GB RAM and 4 vCPUs**. For WSL2, set this in `.wslconfig` with `memory=8GB` and `processors=4`.
- **Whole host:** at least **12 GB, preferably 16 GB** in total.

**What's the same in every option:**
- **Storage:** keep `/data` (session folders and auth profiles) in a **Docker named volume** on the Linux side. Bind-mounting it from an NTFS path is slow and causes file-permission problems with Chromium. Only small read-only files are bind-mounted from Windows: `keys.json` and `.env`.
- **Inbound network:** not needed on SATVADELL. Public access goes through Tailscale Funnel's outbound connection (§4.9, §4.12).
- **Outbound network:** the browser reaches only the public internet, through smokescreen, plus developers' laptops through their reverse tunnels (§4.9). Direct LAN access is blocked on purpose.
- **After Windows Update reboots:** the containers must come back by themselves. In A this needs auto-login, in B the boot task, in C the VM's automatic start setting. The smoke test is part of the setup checklist.
- **Where to run the build:** `build-image.ps1` runs on Windows for A and B. For C, run it on Windows against the VM with `DOCKER_HOST=ssh://user@vm`, or run `build-image.sh` inside the VM.

### 4.12 Target host: `SATVADELL` (checked 2026-10-08)
**Decided: Docker Desktop (option A in §4.11) on this machine.**

| Item | Found | Effect |
|---|---|---|
| Hardware | Dell **laptop** (has a battery), i7-13650HX with 14 cores / 20 threads, **31.7 GB RAM**, Windows 11 Pro build 26200, WORKGROUP (not in a domain) | Plenty of CPU. It's a laptop, so power and lid settings matter (see the checklist). |
| Docker | Docker Desktop 29.7.2, WSL2 backend with Linux engine, buildx 0.36, Compose v5.5. The Docker VM gets **15.5 GB / 20 CPUs**; there's no `.wslconfig`, so WSL's default of half the RAM applies. | Meets every requirement. `build-image.ps1` can use buildx as is. |
| Existing load | **17 containers** already running, all `unless-stopped`: MSSQL ×2, Postgres, paperless, neptune, clarityautobuild, fcc, VaultWarden, a reverse proxy and others. Together about **3.6 GB**. | 3.6 GB plus our 6 GB cap fits in 15.5 GB. Windows only had about 6.9 GB free at the time of the check, so watch memory on the host as well. |
| Ports in use | 1433, 1437, 5432, **8080**, 8082, 8090–8092, 8095, 8099, 8654, 8787. **80 and 443 are free.** | **Don't publish 8080 on the host**, because neptune-api already uses 8080. Inside the container the API stays on 8080 and is reachable only by nginx through `gstack-edge`. The admin UI is published as `127.0.0.1:18081` only. |
| Existing proxy | `F:\DockerVolumes\ReverseProxy`: `nginx-proxy` runs inside the **`tailscale-funnel`** container's network. Tailscale Funnel exposes services to the **public internet**. | **Used for this project (decided)**, with the §4.9 hardening. Only `/gstack/api`, `/gstack/mcp` and `/gstack/tunnel` are routed, never the admin UI. Config lives in `F:\DockerVolumes\GStackBrowserMCP\`. |
| Network | Ethernet 192.168.1.6 (**DHCP**), and Windows treats the Ethernet network as **Public**. Tailscale 100.97.23.127 is signed in to a personal account. VMware and WSL adapters are also present. | Reserve the IP in the router. Set the Ethernet network to **Private** and allow inbound 443 only on Private and Tailscale. |
| Power | Sleep on AC power is **Never** ✅. The lid-close action couldn't be read. | Set lid close on AC to **Do nothing**. Keep it plugged in and on Ethernet. |
| Startup | Docker Desktop's **AutoStart is off**. | Turn on "Start Docker Desktop when you sign in". Windows must sign in by itself after reboots, via auto-login, otherwise **nothing comes back** after Windows Update. |
| Shell | Windows PowerShell **5.1** only, no `pwsh` | `build-image.ps1` must be 5.1-compatible (§4.8). Installing PowerShell 7 is optional. |
| Disk | C: 170 GB free, where Docker's data lives. D: 284 GB and F: 444 GB free. | Fine. The image is about 2–3 GB, and session data is temporary. |

**How callers reach the server (decided): public, through the existing Tailscale Funnel + nginx-proxy**, under `/gstack/` on the existing Funnel hostname. Hardened as in §4.9. No Caddy, no LAN firewall rule, and no internal CA are needed. The admin UI is reachable only on `127.0.0.1:18081`, plus optional tailnet `tailscale serve`.

**Host setup checklist** (it goes into the README as part of P6):
1. Docker Desktop: turn on start at sign-in, and set up Windows auto sign-in for this account. The licence is fine, because this is an open-source project (decided).
2. Power: never sleep on AC, lid close on AC set to Do nothing, plugged in, Ethernet.
3. Network:
   - **No** new inbound Windows Firewall rules. Funnel makes an outbound connection, so nothing needs to come in.
   - Reserve 192.168.1.6 in DHCP, and set the Ethernet profile to Private.
   - Back up `F:\DockerVolumes\ReverseProxy` before adding the `/gstack/` nginx locations and connecting the `gstack-edge` network.
   - Tailscale **stays on the current account** (decided: this is also a community project). Document in the README who owns the Funnel endpoint and how to restore it.
4. Create `F:\DockerVolumes\GStackBrowserMCP\` with `keys.json`, `.env` and the `AUTH_PROFILE_KEY` secret.
5. Optional: add `.wslconfig` with `memory=20GB` to give Docker more room, since the host has 32 GB.
6. Check that everything comes back after a reboot: Windows auto-login → Docker Desktop → all containers `unless-stopped` → smoke test.

## 5. Configuration (environment variables)

| Var | Default | Purpose |
|---|---|---|
| `KEYS_FILE` | `/config/keys.json` | One API key per user, stored as hashes, with role (`user`/`admin`) and per-user `maxSessions` (§4.9) |
| `MAX_SESSIONS` | `10` | Most sessions that can run at once across all users |
| `DEFAULT_USER_MAX_SESSIONS` | `3` | Per-user limit when a key doesn't set its own |
| `MIN_FREE_MEMORY_MB` | `500` | Refuse to start a session when free memory in the container is below this |
| `TRUST_PROXY` | nginx's address on `gstack-edge` | The only source allowed to set `X-Forwarded-For`. Used for per-IP lockout and auditing. |
| `BASE_PATH` | `/gstack` | Path prefix on the shared Funnel hostname |
| `EGRESS_PROXY_URL` | `http://egress-proxy:4750` | Where the per-session proxy sends all traffic that isn't for a tunnel (smokescreen) |
| `EGRESS_ALLOW` | (empty) | Internal CIDRs or hosts to allow, opt-in only. Normally left empty. |
| `AUTH_LOCKOUT` | `10/5m` | Failed authentication attempts per IP before a temporary block |
| `TUNNEL_MAX_PORTS` | `5` | Most laptop ports one tunnel may forward |
| `SESSION_IDLE_TIMEOUT` | `900000` (15 min) | Reaper ends sessions idle longer than this |
| `AUTH_PROFILE_KEY` | (required) | 32-byte key for encrypting saved auth profiles (§4.10). Supply as a Docker secret. |
| `AUTH_STATE_MAX_BYTES` | `5242880` | Largest auth state accepted |
| `EXEC_TIMEOUT` | `60000` | Default timeout per command |
| `ALLOWED_URL_PATTERNS` | `*` | Allowlist for `goto` and `newtab`, to stop SSRF (agents using the browser to reach internal services) |
| `LIVEVIEW_MODE` | `poll` | `poll`, `screencast` or `off` |
| `DATA_DIR` | `/data` | Where session folders live |

## 6. Security
- **Public exposure:** the API and MCP are on the **public internet** through Tailscale Funnel (decided). The required hardening is listed in §4.9: an egress lockdown with smokescreen on an internal-only network, authentication lockout, nginx limits, and an admin UI that is never public. It is a **go-live gate** in P6.
- **Keys and roles:** each user has their own key, and admin is a role on a key (§4.9).
- **Ownership:** users can only see and drive their own sessions unless a session is shared with them. Admins can see everything.
- **Container network:** the browser runs inside the company network. Deny rules plus an allowlist apply both in the server and at the network level (§4.9). Document this.
- **File access:** path arguments can't leave the session folder. Uploads are limited in size, by default the same as gstack's 50 MB `load-html` cap.
- **Untrusted page content:** pages can contain prompt injections aimed at the agent. gstack's own content-security layers stay on, so `GSTACK_SECURITY_OFF` is never set.
- **Secrets in logs:** sensitive values are redacted in the command timeline. That covers `header`, `cookie`, and `fill` on password fields.
- **License:** gstack is MIT, so packaging it in our image is allowed. Keep its LICENSE and NOTICE files in the image, and read `NOTICE.md` in P1.

## 7. Phases & Exit Criteria

| Phase | Scope | Done when |
|---|---|---|
| **P1: Spike** (½–1 day) | Build gstack in Linux Docker. Run two daemons side by side, each with its own `BROWSE_STATE_FILE`. Confirm where `/qa`, `/browse` and `/design-review` look for `$B`. Check whether the "Aside" browser option can be plugged into. Check how to patch in a DevTools port. | A short write-up in `Plans/03-spike-findings.md` (answers the open questions in 02 §5); D2 and D4 confirmed or revised. |
| **P2: Server core** | SessionManager, command runner, REST API, file endpoints, API-key auth, reaper | Integration tests: create a session, `goto`, `text`, `screenshot` download, then delete; two sessions stay isolated. |
| **P3: `browse-remote`** | Client, path rewriting, installers | `/qa` runs end to end from a developer laptop against a public staging URL, using the shared server, and screenshots end up in the report folder. Testing the laptop's own `localhost` comes in P3b. |
| **P3b: Reverse tunnel + per-session proxy** (**required for v1**) | A tunnel in `browse-remote` plus the `gstack-tunnel` helper. A per-session proxy sends `localhost` traffic down the tunnel and everything else to smokescreen (§4.9). | From a laptop on home Wi-Fi, `/qa` against `localhost:3000`, including an OAuth login callback, works through the public endpoint. Ports that weren't listed are refused. |
| **P3c: Auth state** | Accept and convert formats; apply cookies, localStorage and sessionStorage; export; encrypted profiles; `remote-auth` client commands; redaction | `/qa` on a staging app that needs login starts already logged in, from both an uploaded file and a saved profile. No cookie or token value appears in logs. |
| **P4: MCP** | Session, typed and generic tools (including the auth tools in §4.10); image and resource results | MCP Inspector plus a Claude agent complete a scripted flow. |
| **P5: Admin UI v1** | Sessions table, command timeline, kill, polling live view | Sessions and their commands appear live; Kill works. |
| **P6: Image + script + deploy + exposure** | Dockerfile, `build-image.ps1`, `deploy/` (compose stack with egress-proxy, internal networks, `keys.json` template, `new-key.ps1`), nginx `/gstack/` snippet, README with the host checklist (§4.12) | `./build-image.ps1 -SmokeTest -Deploy` works on SATVADELL. Rollback works. **Go-live gate: every item in §4.9 "Public exposure hardening" step 5 passes before the nginx routes are turned on.** Two users can't see each other's sessions. |
| **P7: Live view v2 + extra hardening** | CDP screencast, memory caps, metrics, **SSO with oauth2-proxy** in front of the admin UI and `/gstack/` (API keys still work for agents) | Screencast runs at ≥10 fps. SSO login works for the admin UI. |
| **P8: Human takeover + extras** (deferred, decided) | **Human takeover:** headed mode (gstack starts Xvfb itself) plus noVNC in the admin UI. `browse-remote` shows the viewer URL when a skill runs `handoff`. "Save as profile" after a manual login. **Extras:** input forwarding in the live view, SQLite history, and an enforcement kit (a PreToolUse hook that blocks the *global* local `browse`, plus a CLAUDE.md note). | `/qa` on a login page: `handoff` → human logs in via noVNC → `resume` → QA continues. |

## 8. Proposed Repo Layout
```
GStackBrowserMCP/
├─ Plans/
├─ src/
│  ├─ index.ts                 # starts the API/MCP server on :8080 and the admin server on :8081
│  ├─ config.ts
│  ├─ core/   sessionManager.ts, exec.ts, commandCatalog.ts, paths.ts, callLog.ts
│  ├─ api/    routes.ts, auth.ts, files.ts
│  ├─ mcp/    server.ts, tools/session.ts, tools/typed.ts, tools/generic.ts
│  └─ admin/  server.ts, ws.ts, screencastHub.ts
├─ ui/                         # Vite + React admin UI
├─ client/  browse-remote, install.ps1, install.sh
├─ docker/  Dockerfile, patches/ (gstack DevTools-port patch)
├─ tests/   integration/, client/
├─ build-image.ps1
├─ docker-compose.example.yml
├─ .gstack-ref                 # pinned gstack commit
└─ package.json
```

## 9. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A gstack update changes CLI output or flags | Skills or the client break | Pin `GSTACK_REF`, run the smoke test plus the `/qa` end-to-end test before moving the pin. |
| Skills change where they look for `$B`, or start preferring other browser options | The client is skipped | The lookup is defined in one place upstream (`scripts/resolvers/runtime-root.ts`), so watch that file when moving the pin. `GSTACK_SKIP_ASIDE=1` turns Aside off. Document an install into `$HOME/.claude/skills/...` as a fallback. |
| The client is only picked up inside a git repo and if it's executable | Skills fall back to the local browser | The installer checks `git rev-parse` and runs `chmod +x`. `browse-remote status` prints `REMOTE` so it's obvious which browser is in use. |
| Rewriting file arguments misses a command or flag | Screenshots or files go missing | Path-argument rules live in `commandCatalog.ts` with a test per command; unknown flags pass through unchanged. |
| Memory use (about 200–400 MB per session) | The container runs out of memory | `MAX_SESSIONS`, idle reaper, Docker memory limit, memory shown in the UI. |
| The DevTools-port patch breaks on a gstack update | Live view v2 stops working | Fall back to polling automatically; keep the patch small and tested in the build. |
| **Public endpoint abused:** stolen or guessed key, or an auth bug, used to drive the browser into the LAN (VaultWarden, databases, router) | **Critical:** internal data leaked through screenshots and text | Internal-only Docker network plus smokescreen blocking all private ranges after DNS resolution; authentication lockout; admin UI never public; go-live gate in P6 (§4.9). |
| Shared reverse-proxy and Funnel config is edited by several projects | One change breaks or exposes another service | Back up `F:\DockerVolumes\ReverseProxy` before each change, use a separate `gstack-edge` network, and restrict nginx to `/gstack/` paths only. |
| Tailscale is tied to a personal account (accepted: community project) | The endpoint disappears if that account changes | Keep the account. Document the Funnel setup in the README so it can be rebuilt quickly. Clients read the URL from config, so a hostname change only means updating `GSTACK_REMOTE_URL`. |
| **Community users are not trusted the way team members are** | Abuse: scraping, spam, attacks on third-party sites, all coming from **SATVADELL's own public IP** and damaging that IP's reputation | Keys are issued only by an admin and can be revoked at once. Session caps: 10 in total, 3 per user. **No usage limits, by decision.** Revoking a key is the main response. The audit log is kept 30 days. A short acceptable-use note goes with each key. Keys can be switched to "staging URLs only" if needed. |

## 10. Answered Questions (Decision Log)

| # | Question | Answer | See |
|---|---|---|---|
| A1 | Where will the container run? | A **shared dev server** | §4.9 |
| A2 | What OS is the server? | **Windows host, Linux containers only** | §4.11 |
| A3 | Which machine, and how is Docker set up? | **SATVADELL**: Windows 11 Pro, 32 GB RAM, i7-13650HX, **Docker Desktop** (WSL2) | §4.12 |
| A4 | Which build script and shell? | `build-image.ps1` as the main script, compatible with Windows PowerShell 5.1. `build-image.sh` is kept for Linux. | §4.8 |
| A5 | How do callers reach it? | **Publicly, through the existing Tailscale Funnel + nginx-proxy**, because cloud and external agents need access. Hardened as in §4.9. The admin UI is never public. | §4.9, §4.12 |
| A6 | VPN/LAN, DNS name, TLS? | Covered by Funnel: a public `*.ts.net` hostname with Tailscale TLS. Laptops reach their own apps through the reverse tunnel, which is required in v1. | §4.9 |
| A7 | Move Tailscale to a company account? | **No.** It stays on the current account, because this is a community project. | §4.12, §9 |
| A8 | Is the Docker Desktop licence OK? | **Yes.** It's an open-source project. | §4.12 |
| A9 | How many sessions at once? | **`MAX_SESSIONS=10`**, 3 per user by default. The container is limited to 6 GB RAM, 2 GB shared memory and 4 vCPU. | §4.9 |
| A10 | Do QA runs need logged-in sessions? | **Yes.** Users supply **cookies plus localStorage (and sessionStorage)**, directly or as saved, encrypted auth profiles. | §4.10 |
| A11 | Is human takeover (CAPTCHA, MFA) needed in v1? | **No, it's deferred to P8.** In v1, `handoff`/`resume` return a clear "load an auth profile or mark the step as blocked" message. | §7 |
| A12 | Image registry? | **None for v1. The image is built on the dev server.** `-Push` stays available for later. | §4.8 |
| A13 | Who uses it? | The team **and community users**, so per-key usage limits, admin-issued keys and a 30-day audit log apply. | §4.9, §9 |
| A14 | Use the original gstack repo? | **Yes, upstream and unmodified, pinned by commit SHA.** The only change is an optional live-view patch. | §2 (D1, D7, D9) |
| A15 | Run under `/gstack/` on the existing Funnel hostname, or on its own port 8443? | **`/gstack/` on the existing Funnel hostname**, on port 443 | §4.9 |
| A16 | Licence for this project? | **MIT**, the same as gstack | — |
| A17 | Do any target apps keep login state in IndexedDB? | **No.** Cookies, localStorage and sessionStorage are enough. | §4.10 |
| A18 | Can saved auth profiles be shared? | **No. They stay strictly per user.** | §4.10 |
| A19 | SSO later? | **Yes, in P7.** oauth2-proxy in front of the admin UI and `/gstack/`. API keys keep working for agents. | §4.9, §7 |
| A20 | Usage limits per key? | **None.** Only the session caps (10 in total, 3 per user) apply. Misuse is handled by revoking the key. | §4.9 |
| A21 | Are sessions isolated from each other? | **Yes. Each session gets a brand-new browser profile.** `DELETE`, the idle reaper or a server restart **permanently deletes** the profile and all its files: cookies, localStorage, sessionStorage, IndexedDB, cache and downloads. Only explicitly saved auth profiles outlive a session. | §4.1 |
| A22 | Must logins survive the import? | **Yes.** Cookie flags (`httpOnly`, `secure`, `sameSite`, `expires`, …) must survive, and the user must actually be logged in. If gstack's `cookie-import` falls short, the server sets cookies through the `cdp` command instead. | §4.10 |

## 11. Open Questions

None. Every product question is answered (A1–A22).

### Not a question for you: P1 spike checks
These are things **I** test in the first technical step (the "spike"). It's a short experiment, before writing the real code, that proves the risky parts of the design work. Results go to `Plans/03-spike-findings.md`, and the full list is in [02-research-findings.md §5](02-research-findings.md):
- **Does gstack start inside our Linux container, with a brand-new profile per session?** Two sessions must not share data, and deleting one must remove everything (A21).
- **Can each session's browser be forced through our proxy?** This is needed for blocking access to your LAN and for the tunnel to laptops.
- **Do imported cookies and localStorage keep users logged in, with all cookie flags intact?** (A22)
- **How much memory does one session really use?** This confirms the 10-session sizing.
- **Do file commands behave as expected?** Screenshots, PDFs and uploads must land in the right place.
