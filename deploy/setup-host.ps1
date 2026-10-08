<#
.SYNOPSIS
  One-time host setup for GStack Browser MCP on SATVADELL (plan §4.12).
  Creates the config folder, secrets and keys.json, and an admin key.
  Does NOT touch the ReverseProxy (see connect-reverse-proxy.ps1) or any other container.
#>
param(
  [string]$ConfigDir = 'F:\DockerVolumes\GStackBrowserMCP',
  [string]$AdminUser = $env:USERNAME,
  [switch]$SkipKey      # create an empty keys.json; make keys later with scripts\new-key.ps1
)
$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)

function New-Secret {
  $b = New-Object byte[] 32
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b)
}

New-Item -ItemType Directory -Force -Path (Join-Path $ConfigDir 'secrets') | Out-Null

foreach ($name in @('egress_token', 'auth_profile_key')) {
  $f = Join-Path $ConfigDir "secrets\$name"
  if (Test-Path $f) { Write-Host "keep   $f" }
  else { [System.IO.File]::WriteAllText($f, (New-Secret), $utf8); Write-Host "create $f" }
}
Write-Host ''
Write-Host 'IMPORTANT: back up secrets\auth_profile_key. Without it, saved auth profiles cannot be decrypted.' -ForegroundColor Yellow

$envFile = Join-Path $ConfigDir '.env'
if (-not (Test-Path $envFile)) {
  $lines = @(
    "CONFIG_DIR=$($ConfigDir -replace '\\','/')",
    'IMAGE_TAG=latest',
    'MAX_SESSIONS=10',
    'DEFAULT_USER_MAX_SESSIONS=3',
    'ADMIN_PORT=18081',
    '# Comma-separated host:port or IP exceptions the browser may reach on the private network (normally empty)',
    'EGRESS_ALLOW=',
    '# Optional site allow-list for goto/newtab, e.g. https://*.example.com/*',
    'ALLOWED_URL_PATTERNS='
  )
  [System.IO.File]::WriteAllText($envFile, ($lines -join "`n") + "`n", $utf8)
  Write-Host "create $envFile"
} else { Write-Host "keep   $envFile" }

$keys = Join-Path $ConfigDir 'keys.json'
if (-not (Test-Path $keys)) {
  [System.IO.File]::WriteAllText($keys, '{ "keys": {} }', $utf8)
  Write-Host "create $keys"
  if ($SkipKey) { Write-Host '       (no keys yet: run scripts\new-key.ps1 -User <you> -Role admin)' }
  else { & (Join-Path $PSScriptRoot '..\scripts\new-key.ps1') -User $AdminUser -Role admin -KeysFile $keys }
} else { Write-Host "keep   $keys" }

Write-Host ''
Write-Host 'Host checklist (plan 4.12):'
Write-Host '  1. Docker Desktop > Settings > General: "Start Docker Desktop when you sign in" ON; Windows auto sign-in for this account.'
Write-Host '  2. Power: never sleep on AC; lid close on AC = Do nothing; keep plugged in + Ethernet.'
Write-Host '  3. Router: reserve 192.168.1.6 for this machine.'
Write-Host '  4. Build + start:   .\build-image.ps1 -SmokeTest -Deploy'
Write-Host '  5. Publish:         .\deploy\connect-reverse-proxy.ps1   (backs up the ReverseProxy first)'
