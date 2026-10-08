# Implementation Status

**Date:** 2026-10-08 · **Image:** `gstack-browser-mcp:0.1.0-nogit-dirty` (gstack `9a1dc81a2b`) · **Deployed on:** SATVADELL (local only, not yet published)

## Verified
- **Smoke test** (`.\build-image.ps1 -SmokeTest`): **39/39 pass**. It runs in throwaway internal Docker networks, with a tester container acting as a developer laptop:
  - basic commands, screenshot/responsive downloads, uploads
  - deny-list messages, including `handoff`
  - **LAN lockdown**: VaultWarden, the Docker host, metadata and 10/8 are all blocked
  - **laptop tunnel**, including refusing a port that wasn't shared
  - **auth import/export/profiles** with `httpOnly`
  - **isolation between users**, and delete/stop
  - **MCP**: list, start, goto, screenshot, stop
  - bad key rejected
  - **admin UI**: login, list, timeline, live view, CSRF, kill, roles
- **Unit tests** (`bun test tests/unit`): 41 pass. They cover egress IP rules, loopback routing, the deny list and redaction, and auth-state formats.
- **Type check:** `tsc --noEmit` is clean.
- **Live deployment on SATVADELL** (`.\build-image.ps1 -Deploy`): all 3 containers are healthy. A real session loaded example.com. VaultWarden and the router were refused, and the Docker host was denied by the egress proxy. The admin UI responds on `127.0.0.1:18081`.

## Phase status

| Phase | Status |
|---|---|
| P1 spike | ✅ [03-spike-findings.md](03-spike-findings.md) |
| P2 server core | ✅ Session manager (one Linux user per session, full wipe), command runner, REST API, files, keys + lockout, reaper, audit log |
| P3 `browse-remote` | ✅ Client, path rewriting, installers (`client/install.ps1`, `.sh`) |
| P3b tunnel + per-session proxy | ✅ |
| P3c auth state | ✅ Import/export, encrypted per-user profiles, `remote-auth` commands |
| P4 MCP | ✅ 30 tools (README §3) |
| P5 admin UI v1 | ✅ Sessions, timeline, live view (polling), console/network/tabs, files, kill / kill idle, profiles |
| P6 image + scripts + deploy | ✅ Built, smoke-tested and deployed locally. ⏳ **Publishing through Funnel is waiting for your go-ahead** (`deploy\connect-reverse-proxy.ps1 -Apply`). |
| P7 | ⏳ Not started: CDP screencast (smooth live view), SSO with oauth2-proxy (decision A19), metrics |
| P8 | ⏳ Not started: human takeover (noVNC + `handoff`/`resume`), input forwarding, SQLite history |

## Differences from the plan (and why)

| Plan | Built | Why |
|---|---|---|
| Node.js/TS server | **TypeScript on Bun** | Bun is already in the image for gstack, so there's no extra runtime and no build step. |
| Admin UI in Vite + React | **Plain HTML/JS** (`src/admin/ui`) | No build pipeline needed for a small internal UI. It can be swapped later. |
| smokescreen egress proxy | **Our own egress proxy** (`src/egress/egressProxy.ts`, about 130 lines) | It does the same job: resolves DNS, blocks private and reserved ranges, connects to the checked IP, and requires a shared token. It avoids a Go build. Unit-tested. |
| Caddy, then nginx only | Existing **nginx + Funnel**, plus a small **admin gateway** container | Docker doesn't publish ports for containers that are only on internal networks. The gateway exposes the admin UI on `127.0.0.1:18081` only. |
| Admin UI on the tailnet (`tailscale serve`) | **:10001 on the existing tailscale node**, routed to nginx `:8082` (not Funnel-enabled) | `:10000` is already used by the FreeClaudeCode admin. |
| `state load` for cookies | **`cookie-import` per site** | `state load` drops `localhost` cookies (spike change 1). |
| — | **One Linux user per session**, a per-session proxy that checks the connecting user, and one session file per key in the client | Found during the spike and the smoke runs. They close gaps between sessions in a shared container. |

## Open items for you
1. **Create your admin key:** `.\scripts\new-key.ps1 -User <you> -Role admin`. Then log in at http://127.0.0.1:18081.
2. **Publishing:** run `.\deploy\connect-reverse-proxy.ps1` to review the dry run, then `-Apply`. It changes the shared ReverseProxy, backs up first, and doesn't restart other services.
3. **Host checklist (§4.12):** Docker Desktop auto-start plus Windows auto sign-in, lid and power settings, and a DHCP reservation.
4. **Back up** `F:\DockerVolumes\GStackBrowserMCP\secrets\auth_profile_key`.
5. Optional: remove the spike image (`docker rmi gstack-spike:p1`, 3.8 GB) and the scratch clone of gstack.
