# P1 Spike Findings

**Date:** 2026-10-08 · **Machine:** SATVADELL (Docker Desktop 29.7.2, WSL2) · **gstack:** `9a1dc81a2b` (1.91.54.0)
**What ran:** `spike/Dockerfile` (ubuntu:24.04 + Bun 1.4.2 + upstream gstack + Playwright Chromium), then `spike/test.sh` and `spike/test2.sh` inside the container. Raw output is in `spike/out/` (not committed).

## Result: the design works ✅ (four changes to the plan)

| # | Check | Result |
|---|---|---|
| 1 | gstack starts in our Linux container; **each session gets a brand-new profile**; two sessions running at once can't see each other's cookies or localStorage; **delete removes everything** | ✅ All pass. A cold start plus the first `goto` takes about **1 s**. After a delete: 0 processes, the folder is gone, and the session's `/tmp` files are gone. A new session on the same site starts logged out. |
| 2 | The browser is **forced through our proxy**, and private addresses are blocked | ✅ Every request, **including `localhost`/`127.0.0.1`**, went through the proxy (Chromium doesn't bypass loopback). Blocked: `192.168.1.6:8654` (VaultWarden), `host.docker.internal:5432`, `169.254.169.254`, `10.0.0.1`, `172.17.0.1`. Public HTTPS (`example.com`) worked. ⚠️ **Without the proxy, a session opened VaultWarden (HTTP 200)**, which proves the lockdown is needed. |
| 3 | Imported cookies and localStorage keep the user logged in, with cookie flags intact | ✅ with `cookie-import` (see change 1). `httpOnly`, `secure`, `sameSite`, `expires` and the value all survive. The site saw the user as logged in, and page scripts couldn't read the `httpOnly` cookie. localStorage and sessionStorage set through `js` survive a reload. Export through `state save` keeps the full values and flags. |
| 4 | Memory per session | ✅ **About 290 MB per session**: container cgroup at 1,430 MB with 5 sessions, each with Wikipedia loaded. Ten sessions should fit comfortably in the 6 GB limit. (Per-process RSS shows 660–700 MB, but that counts shared libraries more than once.) |
| 5 | Files: screenshots, PDF, responsive, annotated snapshot, upload | ✅ Everything lands in the session folder (the working directory). `--base64` returns a data URL. Writing outside the session folder or `/tmp` is refused by gstack. `upload` attaches files from the session folder. |

## Changes to the plan

1. **Import cookies with `cookie-import`, not `state load`.**
   - `state load` drops cookies for `localhost`, loopback and private addresses (gstack's `filterSessionCookies` → `isInternalCookieDomain`). Those are exactly the cookies the laptop tunnel needs.
   - `cookie-import` keeps every flag, but it requires the current page to be on the cookie's domain.
   - **New import sequence, per site:**
     1. `goto <origin><landingPath>`
     2. `cookie-import <file>` (only that site's cookies)
     3. `js` to set localStorage and sessionStorage
     4. `reload`
   - **Export:** `state save` (full values and flags) for cookies, and `js "JSON.stringify({...localStorage})"` for storage.
   - **Don't use** gstack's `cookies` or `storage` commands for export. They **redact** values that look like secrets (by design).
2. **Each session runs as its own Linux user.**
   - **The problem:** gstack lets every session read and write `/tmp`, which all sessions share inside one container.
   - **The fix:** run each session's daemon and Chromium as a separate user (`gsess01…gsess32`, created in the image) with `umask 077`. Another session then gets `EACCES` when it tries to read those files, which was verified with `eval /tmp/<other session's file>`.
   - **On delete:** kill all of that user's processes, delete its files in `/tmp` and `/dev/shm`, then delete the session folder.
   - This means the server runs as root inside the container. Browsers never do.
3. **Set `HOME` and `TMPDIR` per session** (in addition to `BROWSE_STATE_FILE` and the working directory). gstack writes some files under `$HOME/.gstack`, so all gstack state stays inside the session folder. Telemetry is off (`GSTACK_TELEMETRY_OFF=1`).
4. **The tunnel is selected by hostname, not by IP.** The test proxy resolved `localhost` to `::1` and blocked it. The real per-session proxy must recognise `localhost` / `127.0.0.1` / `[::1]` **by name** and route them to the user's tunnel *before* any DNS resolution or private-address check.

## Other observations
- **Network locking needs internal-only Docker networks.** Docker Desktop doesn't publish ports for containers that are only on `internal: true` networks. So the admin UI is reached through a small TCP gateway container, or through Tailscale `serve` (tailnet only). See the updated compose design in the README.
- **`handoff` in headless mode** reports "Off-screen Xvfb; a separate remote desktop is required". We deny it in v1 with the friendly message (decision A11).
- **`status` starts the daemon** if it isn't running, so it's used to start sessions. `newtab --json` returns `{"tabId":N,"url":…}`.
- **Every page-content output** is wrapped in `--- BEGIN/END UNTRUSTED EXTERNAL CONTENT ---` markers, gstack's prompt-injection guard. We pass it through unchanged.
- **Build time:** `bun install` took about 10 minutes on this network. The production Dockerfile caches that layer, so it only reruns when the gstack pin changes.
- **Image size:** the spike image is 3.8 GB, mostly the Playwright system dependencies and the Node toolchain. A multi-stage production image should be noticeably smaller.
- **`NOTICE.md`:** gstack is MIT, and some design files are derived from Apache-2.0 works (`licenses/Apache-2.0.txt`). We ship the gstack folder with its `LICENSE`, `NOTICE.md` and `licenses/` unchanged.
