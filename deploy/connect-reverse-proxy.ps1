<#
.SYNOPSIS
  Publishes GStack Browser MCP through the existing Tailscale Funnel + nginx-proxy
  (F:\DockerVolumes\ReverseProxy), following that folder's conventions.
  Without -Apply it only PRINTS what it would change.

  With -Apply it:
    1. backs up nginx.conf, docker-compose.yml and tailscale-config\serve.json (timestamped)
    2. nginx.conf: adds limit_req_zone "gstack", the public /gstack/ location (API + MCP + tunnel;
       /gstack/admin returns 404) and a tailnet-only admin server on :8082
    3. serve.json: adds port 10001 -> nginx :8082, NOT in AllowFunnel (tailnet only)
    4. docker-compose.yml: tailscale-funnel joins the external network gstack-edge
    5. connects the running tailscale-funnel container to gstack-edge (no restart of other services)
    6. runs `nginx -t` inside nginx-proxy; reloads on success, restores the backup on failure
  Run it only after the go-live checks pass (plan §4.9 step 5): .\build-image.ps1 -SmokeTest
#>
param(
  [string]$ProxyDir = 'F:\DockerVolumes\ReverseProxy',
  [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
$nginxFile = Join-Path $ProxyDir 'nginx.conf'
$composeFile = Join-Path $ProxyDir 'docker-compose.yml'
$serveFile = Join-Path $ProxyDir 'tailscale-config\serve.json'
foreach ($f in @($nginxFile, $composeFile, $serveFile)) { if (-not (Test-Path $f)) { throw "$f not found" } }

$nginx = [IO.File]::ReadAllText($nginxFile)
$compose = [IO.File]::ReadAllText($composeFile)
$serve = [IO.File]::ReadAllText($serveFile)
$nl = "`n"
if ($nginx.Contains("`r`n")) { $nl = "`r`n" }

$zone = '    limit_req_zone $client_ip zone=gstack:10m rate=30r/s;'
$publicLocations = @'
        # ---- GStack Browser: API + MCP + laptop tunnel (public via Funnel) ----
        # The admin UI is deliberately NOT routed here (tailnet-only server on :8082).
        location = /gstack { return 301 /gstack/; }
        location /gstack/admin { return 404; }
        location /gstack/ {
            resolver 127.0.0.11 valid=30s ipv6=off;
            set $gstack_upstream gstack-browser-mcp:8080;
            limit_req zone=gstack burst=120 nodelay;
            client_max_body_size 50m;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $client_ip;
            proxy_set_header X-Forwarded-Proto https;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_read_timeout 600s;
            proxy_send_timeout 600s;
            proxy_pass http://$gstack_upstream;
        }

'@
$adminServer = @'
    # ---- GStack Browser admin UI: tailnet only (serve.json :10001, no AllowFunnel) ----
    server {
        listen 8082;
        server_name _;
        location / {
            resolver 127.0.0.11 valid=30s ipv6=off;
            set $gstack_admin gstack-browser-mcp:8081;
            proxy_http_version 1.1;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For $client_ip;
            proxy_set_header X-Forwarded-Proto https;
            proxy_buffering off;
            proxy_read_timeout 1h;
            proxy_pass http://$gstack_admin;
        }
    }

'@
$publicLocations = $publicLocations -replace "`r?`n", $nl
$adminServer = $adminServer -replace "`r?`n", $nl

$changes = @()
# --- nginx.conf ---
if ($nginx -match 'gstack-browser-mcp') { Write-Host 'nginx.conf: already contains gstack routes (skip)' }
else {
  $m = [regex]::Match($nginx, '(?m)^\s*limit_req_zone .*$')
  if (-not $m.Success) { throw 'nginx.conf: no limit_req_zone line found; add deploy/nginx-gstack.conf by hand.' }
  $nginx = $nginx.Insert($m.Index + $m.Length, $nl + $zone)
  $m = [regex]::Match($nginx, '(?m)^\s*listen 80;\s*$\s*^\s*server_name [^;]+;\s*$')
  if (-not $m.Success) { throw 'nginx.conf: public "listen 80;" server not found; add deploy/nginx-gstack.conf by hand.' }
  $nginx = $nginx.Insert($m.Index + $m.Length + 1, $nl + $publicLocations)
  $m = [regex]::Match($nginx, '(?m)^\}\s*$\s*^stream\s*\{')
  if (-not $m.Success) { $m = [regex]::Match($nginx, '(?m)^\}\s*\z') }
  if (-not $m.Success) { throw 'nginx.conf: end of the http block not found; add deploy/nginx-gstack.conf by hand.' }
  $nginx = $nginx.Insert($m.Index, $adminServer)
  $changes += 'nginx.conf: limit_req_zone gstack + public /gstack/ location + tailnet-only admin server :8082'
}
# --- serve.json ---
$sj = $serve | ConvertFrom-Json
if ($sj.TCP.PSObject.Properties.Name -contains '10001') { Write-Host 'serve.json: port 10001 already present (skip)' }
else {
  $sj.TCP | Add-Member -NotePropertyName '10001' -NotePropertyValue ([pscustomobject]@{ HTTPS = $true })
  $handler = [pscustomobject]@{ Handlers = [pscustomobject]@{ '/' = [pscustomobject]@{ Proxy = 'http://127.0.0.1:8082' } } }
  $sj.Web | Add-Member -NotePropertyName '${TS_CERT_DOMAIN}:10001' -NotePropertyValue $handler
  $serve = $sj | ConvertTo-Json -Depth 10
  $changes += 'serve.json: :10001 -> nginx :8082 (tailnet only; NOT added to AllowFunnel)'
}
# --- docker-compose.yml ---
if ($compose -match 'gstack-edge') { Write-Host 'docker-compose.yml: gstack-edge already present (skip)' }
else {
  $m = [regex]::Match($compose, '(?ms)tailscale-funnel:.*?^    networks:\s*$((?:\r?\n      - [^\r\n]+)+)')
  if (-not $m.Success) { throw 'docker-compose.yml: tailscale-funnel networks list not found; add gstack-edge by hand.' }
  $g = $m.Groups[1]
  $compose = $compose.Insert($g.Index + $g.Length, $nl + '      - gstack-edge')
  $compose = $compose.TrimEnd() + $nl + $nl + '  gstack-edge:' + $nl + '    external: true' + $nl
  $changes += 'docker-compose.yml: tailscale-funnel joins external network gstack-edge'
}

if (-not $changes) { Write-Host 'Nothing to change.'; return }
Write-Host 'Planned changes:' -ForegroundColor Cyan
$changes | ForEach-Object { Write-Host "  - $_" }
Write-Host '  - docker network connect gstack-edge tailscale-funnel   (live, no restart)'
Write-Host '  - nginx -t, then nginx -s reload inside nginx-proxy'
if (-not $Apply) { Write-Host ''; Write-Host 'Dry run only. Re-run with -Apply to make these changes.' -ForegroundColor Yellow; return }

$null = & docker network inspect gstack-edge 2>$null
if ($LASTEXITCODE -ne 0) { throw 'Network gstack-edge does not exist yet. Deploy the stack first: .\build-image.ps1 -Deploy' }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
foreach ($f in @($nginxFile, $composeFile, $serveFile)) { Copy-Item $f "$f.bak-$stamp-pregstack"; Write-Host "backup $f.bak-$stamp-pregstack" }
[IO.File]::WriteAllText($nginxFile, $nginx, $utf8)
[IO.File]::WriteAllText($serveFile, $serve, $utf8)
[IO.File]::WriteAllText($composeFile, $compose, $utf8)

$connected = (& docker inspect -f '{{json .NetworkSettings.Networks}}' tailscale-funnel) -match 'gstack-edge'
if (-not $connected) { & docker network connect gstack-edge tailscale-funnel; if ($LASTEXITCODE -ne 0) { throw 'docker network connect failed' } }

& docker exec nginx-proxy nginx -t
if ($LASTEXITCODE -ne 0) {
  Write-Host 'nginx -t FAILED: restoring nginx.conf from backup' -ForegroundColor Red
  Copy-Item "$nginxFile.bak-$stamp-pregstack" $nginxFile -Force
  throw 'nginx config test failed; nothing was reloaded.'
}
& docker exec nginx-proxy nginx -s reload
Write-Host ''
Write-Host 'Published:' -ForegroundColor Green
Write-Host '  API + MCP (public):   https://<TS_CERT_DOMAIN>/gstack/api/health   and   /gstack/mcp'
Write-Host '  Admin UI (tailnet):   https://<TS_CERT_DOMAIN>:10001/'
Write-Host 'serve.json changes are picked up by the tailscale container automatically; if :10001 does not answer, restart it with: docker restart tailscale-funnel'
