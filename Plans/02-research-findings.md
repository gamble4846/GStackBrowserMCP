# Research Findings: gstack Browser, gstack Skills, Playwright Alternative

**Date:** 2026-10-08 · **gstack checked at:** `main` @ `9a1dc81a2b` (VERSION 1.91.54.0)
**Method:** read the upstream source over HTTP; nothing was cloned or run. Line numbers refer to that commit. Items marked *(unverified)* still need confirming in the P1 spike.

---

## 1. gstack `browse` internals

| Topic | Finding | Effect on our design |
|---|---|---|
| **License** | MIT, "Copyright (c) 2026 Garry Tan". `NOTICE.md` not yet read. | We may package the **original upstream repo** in our image. We must keep the copyright notice and read `NOTICE.md`. |
| **How the CLI talks to the daemon** | `POST http://127.0.0.1:<port>/command`, Bearer token, body `{command, args[], tabId?}`. On success the CLI **prints the body as is**. On error it prints `{error, hint}` to stderr and exits 1. (`cli.ts:991-1110`) | The CLI adds almost nothing on top of the daemon, so running it inside the container gives exactly the output a local run gives. |
| **Daemon address** | Every CLI call is hardcoded to `127.0.0.1`. There is **no `BROWSE_HOST` or `BROWSE_URL` option**. | The upstream CLI **cannot** talk to a remote daemon, so we need our own client (`browse-remote`). |
| **Network binding** | The daemon listens on `127.0.0.1` only (`server.ts:1982`). | Good for us: daemons stay private inside the container and only our server is exposed. **Never** forward a daemon port straight out, because that would expose the full root-token API. |
| **Fixed port and token** | `BROWSE_PORT`, `AUTH_TOKEN` (at least 16 characters), `BROWSE_STATE_FILE`, `BROWSE_PARENT_PID=0`, `BROWSE_IDLE_TIMEOUT`, `BROWSE_NO_AUTOSTART`, `BROWSE_PERSIST_STATE` | Our session manager picks each session's port and token itself. It can then also reach `/health` and `/activity/stream` directly. |
| **Built-in remote mode (pair-agent/tunnel)** | Needs ngrok, and remote callers can use only 29 commands. `/batch`, `/file` and `--out` are blocked. Meant for "a remote agent drives my local browser". | **Not usable** for our goal, and we won't use it. |
| **Files** | The daemon writes files to **its own disk**. Output paths must be under a temp dir or the daemon's working directory (`path-security.ts`). `--base64` returns a data URL instead, up to 10 MB. `GET /file` works locally only. | Our server sets each session's working directory to its session folder, so all files land there. Our server serves them to `browse-remote`. |
| **Linux and containers** | `--no-sandbox` is added automatically when `CI` or `CONTAINER` is set or when running as root. Headed mode starts **Xvfb** automatically when there's no display. The CI Dockerfile (`.github/docker/Dockerfile.ci`) is ubuntu:24.04 with `playwright install-deps chromium`. | We'll build on the CI Dockerfile and set `CONTAINER=1`. Headed mode plus noVNC (for human takeover) is cheaper than expected. |
| **Build output** | `bun run build` produces Bun single-file executables that only run on the platform they were built on. The CLI starts the daemon by running `server.ts`, **so the source tree and Bun are needed at runtime** *(inferred)*. | Build inside the Linux image and copy the whole gstack folder in, not only the binary. |
| **DevTools access / live view** | No `--remote-debugging-port`. `cdp-bridge.ts` uses Playwright's internal DevTools channel and allows only listed methods. No screencast. There **is** an `/activity/stream` feed of command events (Server-Sent Events, not video). | A smooth live view needs a small patch to how gstack launches Chromium. Without a patch, the live view polls `screenshot --base64`. The activity feed can drive the UI's command timeline. |
| **Releases** | No tags or GitHub releases, and several commits a day. | **Pin by commit SHA** (`.gstack-ref`) and test before moving the pin. |

## 2. How gstack skills use the browser

- **Skill files are generated.** Every `SKILL.md` is built from a `.tmpl` file by `scripts/gen-skill-docs.ts`, which substitutes placeholders such as `{{ASIDE_SETUP}}`, `{{BROWSE_FALLBACK}}` and `{{BROWSE_SETUP}}`.
- **How skills find `$B`** (`scripts/resolvers/runtime-root.ts:66-82`):
  ```bash
  _ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  [ -x "$_ROOT/.claude/skills/gstack/browse/dist/browse" ] && B="$_ROOT/..."   # project first
  [ -z "$B" ] && B="$HOME/.claude/skills/gstack/browse/dist/browse"           # then global
  ```
  - **No environment variable overrides this.**
  - The project path is checked **only inside a git repo** and only if the file is executable.
  - ✅ This confirms plan decision D4: put `browse-remote` at `<repo>/.claude/skills/gstack/browse/dist/browse`.
- **Aside comes first.** Browser skills try **Aside** before `$B`. Aside is a third-party AI browser app for macOS 15+ that the skills drive through its `aside` CLI. If it isn't installed or isn't running, they fall back to `$B`. `GSTACK_SKIP_ASIDE=1` turns Aside off. We'll set this so `$B` is always used. On Windows and Linux, Aside doesn't exist anyway.
- **Browser choice is fixed.** The two browsers (Aside and `$B`) are hardcoded, with no browser setting in `gstack-config`. `browse-remote` standing in for `$B` is the only way in that doesn't change the skills.
- **Skills that drive the browser:**
  - `qa`, `qa-only`, `browse`, `benchmark`, `canary`
  - `design-review`, `design-consultation`, `devex-review`
  - `land-and-deploy`, `scrape`
  - `open-gstack-browser`, `pair-agent`, `setup-browser-cookies`
  - `review`, `ship`: report-only, through the QA sections
- **Most-used commands, which `browse-remote` must handle perfectly:**
  - `js`, `eval <file>` (**uploads a local file**)
  - `goto`, `snapshot -i`, `snapshot -D`, `snapshot -i -a -o <path>` (**downloads a file**)
  - `click @eN`, `fill`, `text`, `links`
  - `screenshot <path>` (**downloads a file**), `responsive <prefix>` (**several files**), `pdf <out>` (**downloads a file**)
  - `perf`, `console --errors`, `closetab`, `status`
  - **`handoff` / `resume`, used 13 and 12 times.** The skills hand control to a human for logins, CAPTCHAs and MFA. In a container that only works if the human can see the browser, which needs a headed browser plus noVNC (see plan P8).
- **Screenshots.** After `$B screenshot <path>`, the skill expects the file on local disk at that path. It copies it into `$REPORT_DIR/screenshots/` and reads it with the Read tool. `browse-remote` must therefore have **finished downloading** the file before it exits.

## 3. Alternative considered: Playwright MCP plus "tell the AI to use our MCP"

### 3.1 What the Playwright route offers
- **`@playwright/mcp`** (Microsoft, Apache-2.0):
  - Accessibility snapshots with element refs.
  - Streamable HTTP at `/mcp`.
  - Docker image `mcr.microsoft.com/playwright/mcp`.
  - Each MCP client gets its own browser context.
- **What it lacks:** named, durable sessions; listing or reattaching sessions; and a live view. We would build those ourselves either way.
- **Off-the-shelf pools** (none fits):
  - Steel: self-hosted is about one session.
  - Browserless: SSPL license; MCP and live streaming are paid.
  - browser-use-mcp: limited.
  - Hyperbrowser and Anchor: cloud only.

### 3.2 Can we make gstack skills use our MCP instead of `$B`?
- **A skill or CLAUDE.md instruction alone won't do it reliably.** Claude Code's docs say CLAUDE.md is *"context, not enforced configuration"*. When instructions conflict, *"Claude may pick one arbitrarily."* The gstack skills explicitly say "run `$B …`", so our instruction would compete with theirs. A project skill also can't override a gstack skill with the same name in `~/.claude/skills`, because personal skills take precedence.
- **It can be enforced:**
  1. A `PreToolUse` hook on `Bash` that denies any command containing the gstack browse binary, with the reason *"Use mcp__gstack-remote__* tools instead"*. Claude then switches tools.
  2. `permissions.deny` rules for the browse binary. These are a weaker backstop, because the docs call Bash argument matching "fragile".
  3. `skillOverrides` set to `"off"` for gstack skills we don't want at all.
- **What enforcement can't fix:** the skill's steps are still written for `$B`. Claude would have to translate every step to MCP tools on the fly, mid-skill. The skills also check for exact output markers (`URL=`, `CONSOLE_ERRORS=`, `DIFF_START/END`, `GSTACK_STEP_OK`, the screenshot paths). So:
  - results would vary from run to run
  - QA reports would come out weaker
  - every gstack update could break it without warning
- **Verdict:** **possible, but not recommended** as the way to run gstack skills. This MCP plus hook approach suits **our own skills**, written against our MCP tools. It doesn't suit **gstack's skills**.

## 4. Recommendation (changes to [01-initial-plan.md](01-initial-plan.md))

1. **Use the original upstream gstack repo, unmodified,** cloned at a pinned SHA inside the image. The only change is an *optional* build-time patch that opens a DevTools port for the smooth live view. If that patch ever fails to apply, the live view falls back to polling.
2. **gstack skills use `browse-remote`**, a drop-in `$B` at the project path, plus `GSTACK_SKIP_ASIDE=1`. No skill edits, no hooks, and results match local gstack.
3. **Other agents use our MCP server.** It shares the same sessions and calls the same gstack daemons.
4. **Optional "enforcement kit"** for projects that must never start a local browser:
   - a `PreToolUse` hook that blocks the *global* `~/.claude/skills/gstack/browse/dist/browse`
   - a CLAUDE.md note pointing at the MCP tools
   - Because `browse-remote` sits at the project path, the skills pick it up anyway. The kit is only a safety net.
5. **Server design details:**
   - Set each session's working directory to its session folder (needed by gstack's path rules), and set `CONTAINER=1`.
   - Assign `BROWSE_PORT` and `AUTH_TOKEN` per session.
   - Read `/activity/stream` to fill the command timeline.
6. **Move "human takeover" (headed browser + Xvfb + noVNC) earlier.** Skills use `handoff`/`resume` a lot, and gstack already starts Xvfb itself, so this costs less than first estimated.

## 5. Questions for the P1 spike
- Can the `browse` CLI start the daemon from the copied source tree in the image (`BROWSE_SERVER_SCRIPT`)? Does Bun launch Chromium on Linux?
- Does `/command` return JSON or text for `newtab --json`, `tabs` and `snapshot`?
- Does `browse-remote` installed in Git Bash on Windows pass `[ -x … ]`? (A file with a shebang should.)
- Does `eval <file>` read the file on the daemon's side, so it needs an upload first?
- What are the exact rules for path arguments: `responsive <prefix>`, `snapshot -o`, `scrape --dir`?
- How small can the DevTools-port patch be? Is there an existing Chromium launch-args hook in `browser-manager.ts`?
- What's in `NOTICE.md`?
- **Auth state:**
  - Does `storage set <k> <v>` write localStorage only, or sessionStorage too, and on the current origin?
  - Does `cookie-import` keep `httpOnly`, `sameSite` and `expires`?
  - Does `js` return values that can be used to export localStorage and sessionStorage?
