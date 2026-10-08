<#
.SYNOPSIS
  Build the gstack-browser-mcp Docker image (Linux container), optionally smoke-test it and
  deploy/roll back the compose stack. Works in Windows PowerShell 5.1 and PowerShell 7.
.EXAMPLE
  .\build-image.ps1                              # build gstack-browser-mcp:<version>-<sha> and :latest
  .\build-image.ps1 -SmokeTest                   # build, then run the end-to-end smoke test in isolated networks
  .\build-image.ps1 -SmokeTest -Deploy           # ...and switch the running stack to the new image
  .\build-image.ps1 -Deploy -Tag 0.1.0-abc1234   # roll back / switch to an existing tag, no build
  .\build-image.ps1 -Registry ghcr.io/me -Push   # (later) push both tags to a registry
#>
param(
  [string]$Tag = '',
  [string]$GstackRef = '',
  [switch]$NoCache,
  [string]$Platform = 'linux/amd64',
  [switch]$SmokeTest,
  [switch]$Deploy,
  [string]$Registry = '',
  [switch]$Push,
  [string]$ConfigDir = 'F:\DockerVolumes\GStackBrowserMCP',
  [string]$LanTarget = 'http://192.168.1.6:8654',
  [int]$KeepTags = 3
)
$ErrorActionPreference = 'Stop'
$Name = 'gstack-browser-mcp'
$Root = $PSScriptRoot

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
# Windows PowerShell 5.1 turns a native program's stderr into a terminating error under
# ErrorActionPreference=Stop, even with 2>$null. Probes that may legitimately fail go through this.
function Try-Native([scriptblock]$Block) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $Block 2>$null; return [pscustomobject]@{ Ok = ($LASTEXITCODE -eq 0); Out = $out } }
  catch { return [pscustomobject]@{ Ok = $false; Out = $null } }
  finally { $ErrorActionPreference = $prev }
}
function Invoke-Docker {
  # Plain (non-advanced) function on purpose: docker flags like -e must not bind to -ErrorAction.
  $DockerArgs = $args
  # docker writes progress to stderr; under 5.1 + Stop that would abort, so judge by exit code only.
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & docker @DockerArgs 2>&1 | ForEach-Object { if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message } else { $_ } } }
  finally { $ErrorActionPreference = $prev }
  if ($LASTEXITCODE -ne 0) { throw "docker $($DockerArgs -join ' ') failed with exit code $LASTEXITCODE" }
}

# ---- 1. prerequisites ----
Step 'Checking Docker'
$dv = Try-Native { docker version --format '{{.Server.Os}}' }
if (-not $dv.Ok) { throw 'Docker is not running. Start Docker Desktop and try again.' }
$os = ($dv.Out | Select-Object -Last 1).Trim()
if ($os -ne 'linux') { throw "Docker is in '$os' containers mode. Switch Docker Desktop to Linux containers." }
if (-not (Try-Native { docker buildx version }).Ok) { throw 'docker buildx is not available.' }

# ---- 2. defaults ----
$pkg = Get-Content (Join-Path $Root 'package.json') -Raw | ConvertFrom-Json
if (-not $GstackRef) { $GstackRef = (Get-Content (Join-Path $Root '.gstack-ref') -Raw).Trim() }
$buildNeeded = -not ($Deploy -and $Tag -and -not $SmokeTest -and -not $Push)
if (-not $Tag) {
  $g = Try-Native { git -C $Root rev-parse --short HEAD }
  $sha = 'nogit'
  if ($g.Ok -and $g.Out) { $sha = [string]($g.Out | Select-Object -Last 1) }
  $dirty = (Try-Native { git -C $Root status --porcelain }).Out
  $suffix = ''
  if ($dirty) { $suffix = '-dirty' }
  $Tag = "$($pkg.version)-$($sha.Trim())$suffix"
}
$image = "${Name}:$Tag"

# ---- 3. build ----
if ($buildNeeded) {
  Step "Building $image (gstack $($GstackRef.Substring(0, 10)))"
  $buildArgs = @('buildx', 'build', '-f', (Join-Path $Root 'docker\Dockerfile'), '--platform', $Platform,
    '--build-arg', "GSTACK_REF=$GstackRef", '--build-arg', "APP_VERSION=$Tag",
    '-t', $image, '-t', "${Name}:latest", '--load')
  if ($NoCache) { $buildArgs += '--no-cache' }
  $buildArgs += $Root
  Invoke-Docker @buildArgs
}

# ---- 4. smoke test ----
function Invoke-SmokeTest([string]$img) {
  $p = 'gstack-smoke-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
  $tmp = Join-Path ([IO.Path]::GetTempPath()) $p
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $utf8 = New-Object System.Text.UTF8Encoding($false)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $sha = [System.Security.Cryptography.SHA256]::Create()
  function New-Key { $b = New-Object byte[] 32; $rng.GetBytes($b); 'gsk_' + [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
  function HashOf($k) { -join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($k)) | ForEach-Object { $_.ToString('x2') }) }
  $k1 = New-Key; $k2 = New-Key; $egressTok = New-Key; $profileKey = New-Key
  $keys = '{ "keys": { "' + (HashOf $k1) + '": { "user": "smoke-a", "role": "admin" }, "' + (HashOf $k2) + '": { "user": "smoke-b", "role": "user" } } }'
  [IO.File]::WriteAllText((Join-Path $tmp 'keys.json'), $keys, $utf8)
  $ok = $false
  try {
    Step "Smoke test: isolated networks $p-int (internal) / $p-out"
    Invoke-Docker network create --internal "$p-int" | Out-Null
    Invoke-Docker network create "$p-out" | Out-Null
    Invoke-Docker run -d --name "$p-egress" --network "$p-int" --network-alias egress-proxy -e "EGRESS_TOKEN=$egressTok" `
      --cap-drop ALL --user 65534:65534 $img bun src/egress/egressProxy.ts | Out-Null
    Invoke-Docker network connect "$p-out" "$p-egress"
    Invoke-Docker run -d --name "$p-app" --network "$p-int" --network-alias gstack-browser-mcp --init --shm-size 1g `
      --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add SETUID --cap-add SETGID --cap-add KILL `
      --security-opt no-new-privileges:true -e "EGRESS_TOKEN=$egressTok" -e "AUTH_PROFILE_KEY=$profileKey" -e MAX_SESSIONS=4 `
      -v "$(Join-Path $tmp 'keys.json'):/config/keys.json:ro" $img | Out-Null
    $healthy = $false
    for ($i = 0; $i -lt 60; $i++) {
      if ((Try-Native { docker exec "$p-app" curl -fsS http://127.0.0.1:8080/api/health }).Ok) { $healthy = $true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'server did not become healthy within 60 s' }
    Step 'Running tests/smoke/smoke.sh in a tester container'
    $prevEap = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
    & docker run --rm --name "$p-tester" --network "$p-int" `
      -e "GSTACK_REMOTE_URL=http://gstack-browser-mcp:8080/gstack" -e "GSTACK_REMOTE_KEY=$k1" -e "KEY2=$k2" -e "LAN_TARGET=$LanTarget" `
      -v "$(Join-Path $Root 'client'):/client:ro" -v "$(Join-Path $Root 'tests'):/tests:ro" $img bash /tests/smoke/smoke.sh
    $ok = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prevEap
    if (-not $ok) {
      Write-Host '--- server log (last 60 lines) ---' -ForegroundColor Yellow
      & docker logs --tail 60 "$p-app"
      Write-Host '--- egress log (last 30 lines) ---' -ForegroundColor Yellow
      & docker logs --tail 30 "$p-egress"
    }
  } finally {
    $ErrorActionPreference = 'Continue'
    & docker rm -f "$p-app" "$p-egress" "$p-tester" 2>$null | Out-Null
    & docker network rm "$p-int" "$p-out" 2>$null | Out-Null
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
  if (-not $ok) { throw 'Smoke test FAILED' }
  Step 'Smoke test passed'
}
if ($SmokeTest) { Invoke-SmokeTest $image }

# ---- 5. deploy / rollback ----
if ($Deploy) {
  if (-not (Try-Native { docker image inspect $image }).Ok) { throw "Image $image does not exist locally." }
  $envFile = Join-Path $ConfigDir '.env'
  if (-not (Test-Path $envFile)) { throw "$envFile not found. Run deploy\setup-host.ps1 first." }
  Step "Deploying $image"
  $lines = Get-Content $envFile | Where-Object { $_ -notmatch '^IMAGE_TAG=' }
  $lines += "IMAGE_TAG=$Tag"
  [IO.File]::WriteAllText($envFile, ($lines -join "`n") + "`n", (New-Object System.Text.UTF8Encoding($false)))
  Invoke-Docker compose --env-file $envFile -f (Join-Path $Root 'deploy\docker-compose.yml') up -d --remove-orphans
  Step 'Waiting for health'
  $healthy = $false
  for ($i = 0; $i -lt 90; $i++) {
    $state = [string]((Try-Native { docker inspect -f '{{.State.Health.Status}}' gstack-browser-mcp }).Out)
    if ($state -eq 'healthy') { $healthy = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $healthy) { throw "gstack-browser-mcp is not healthy. Check: docker logs gstack-browser-mcp. Roll back with: .\build-image.ps1 -Deploy -Tag <previous>" }
  Step "Deployed $image"

  # keep the newest $KeepTags versioned tags (+ latest + the deployed one)
  $tags = & docker images $Name --format '{{.Tag}} {{.CreatedAt}}' | Where-Object { $_ -notmatch '^(latest|<none>) ' } |
    Sort-Object { $_.Split(' ', 2)[1] } -Descending | ForEach-Object { $_.Split(' ')[0] }
  $tags | Select-Object -Skip $KeepTags | Where-Object { $_ -ne $Tag } | ForEach-Object {
    $null = Try-Native { docker rmi "${Name}:$_" }
    Write-Host "   removed old tag $_"
  }
}

# ---- 6. push (later) ----
if ($Push) {
  if (-not $Registry) { throw '-Push needs -Registry (e.g. ghcr.io/<org>)' }
  foreach ($t in @($Tag, 'latest')) {
    Invoke-Docker tag "${Name}:$t" "$Registry/${Name}:$t"
    Invoke-Docker push "$Registry/${Name}:$t"
  }
}
Step "Done: $image"
