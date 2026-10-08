<#
.SYNOPSIS
  Installs browse-remote into a project so gstack skills (/qa, /browse, ...) use the remote browser.
.EXAMPLE
  .\client\install.ps1 -Project "D:\Git Repos\MyApp" -Url "https://satvadell.example.ts.net/gstack"
  Then set your key once:  [Environment]::SetEnvironmentVariable('GSTACK_REMOTE_KEY','gsk_...','User')
#>
param(
  [Parameter(Mandatory = $true)][string]$Project,
  [Parameter(Mandatory = $true)][string]$Url,
  [string]$TunnelPorts = '',
  [string]$AuthProfile = ''
)
$ErrorActionPreference = 'Stop'

$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { throw 'Node.js 22+ is required (https://nodejs.org).' }
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw "Node.js 22+ is required (found $nodeVersion)." }

$root = (& git -C $Project rev-parse --show-toplevel) 2>$null
if (-not $root) { throw "$Project is not inside a git repository. gstack skills only look for a project-level browser inside a git repo." }
$root = $root -replace '/', '\'

$dest = Join-Path $root '.claude\skills\gstack\browse\dist'
New-Item -ItemType Directory -Force -Path $dest | Out-Null
$src = Join-Path $PSScriptRoot 'browse-remote'
# Keep LF line endings: the shebang must stay "#!/usr/bin/env node" for Git Bash.
[System.IO.File]::WriteAllText((Join-Path $dest 'browse'), ([System.IO.File]::ReadAllText($src) -replace "`r`n", "`n"))

$stateDir = Join-Path $root '.gstack'
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
$cfg = [ordered]@{ url = $Url }
if ($TunnelPorts) { $cfg.tunnelPorts = $TunnelPorts }
if ($AuthProfile) { $cfg.authProfile = $AuthProfile }
# UTF-8 without BOM: browse-remote's JSON.parse must not see a BOM.
[System.IO.File]::WriteAllText((Join-Path $stateDir 'remote.json'), ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))

$gi = Join-Path $root '.gitignore'
$lines = @('.gstack/remote-session*.json', '.gstack/remote.json', '.claude/skills/gstack/browse/dist/browse')
$existing = if (Test-Path $gi) { Get-Content $gi } else { @() }
$add = $lines | Where-Object { $existing -notcontains $_ }
if ($add) { Add-Content -Path $gi -Value $add -Encoding utf8 }

Write-Host "Installed browse-remote -> $dest\browse"
Write-Host "Config     -> $stateDir\remote.json (url$(if ($TunnelPorts) {', tunnelPorts'})$(if ($AuthProfile) {', authProfile'}))"
if (-not $env:GSTACK_REMOTE_KEY) {
  Write-Host ''
  Write-Host 'Next: set your API key once (it is NOT stored in the project):' -ForegroundColor Yellow
  Write-Host "  [Environment]::SetEnvironmentVariable('GSTACK_REMOTE_KEY','gsk_...','User')"
  Write-Host 'Also set GSTACK_SKIP_ASIDE=1 the same way if you have the Aside browser installed.'
}
Write-Host ''
Write-Host "Test it from Git Bash in the project:  .claude/skills/gstack/browse/dist/browse remote-status"
