#!/usr/bin/env bash
# Installs browse-remote into a project so gstack skills (/qa, /browse, ...) use the remote browser.
#   ./client/install.sh <project-dir> <server-url> [tunnel-ports] [auth-profile]
#   ./client/install.sh ~/code/myapp https://satvadell.example.ts.net/gstack 3000
set -euo pipefail
project=${1:?project dir}; url=${2:?server url}; ports=${3:-}; profile=${4:-}
command -v node >/dev/null || { echo "Node.js 22+ is required" >&2; exit 1; }
major=$(node -p 'process.versions.node.split(".")[0]')
[ "$major" -ge 22 ] || { echo "Node.js 22+ is required (found $(node --version))" >&2; exit 1; }
root=$(git -C "$project" rev-parse --show-toplevel 2>/dev/null) || { echo "$project is not in a git repo" >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

dest="$root/.claude/skills/gstack/browse/dist"
mkdir -p "$dest" "$root/.gstack"
tr -d '\r' < "$here/browse-remote" > "$dest/browse"
chmod +x "$dest/browse"

node -e '
const [url, ports, profile] = process.argv.slice(1);
const cfg = { url }; if (ports) cfg.tunnelPorts = ports; if (profile) cfg.authProfile = profile;
require("fs").writeFileSync(process.argv[4], JSON.stringify(cfg, null, 2) + "\n");
' "$url" "$ports" "$profile" "$root/.gstack/remote.json"

for line in '.gstack/remote-session*.json' '.gstack/remote.json' '.claude/skills/gstack/browse/dist/browse'; do
  grep -qxF "$line" "$root/.gitignore" 2>/dev/null || echo "$line" >> "$root/.gitignore"
done
echo "Installed browse-remote -> $dest/browse"
echo "Config -> $root/.gstack/remote.json"
[ -n "${GSTACK_REMOTE_KEY:-}" ] || echo "Next: export GSTACK_REMOTE_KEY=gsk_... (and GSTACK_SKIP_ASIDE=1) in your shell profile."
echo "Test: $dest/browse remote-status"
