<#
.SYNOPSIS
  Move the pinned gstack version (.gstack-ref) to a newer upstream commit, show what changed,
  and optionally build + smoke-test + deploy it. Restores the old pin if the smoke test fails.
.EXAMPLE
  .\scripts\update-gstack.ps1                      # show what's new on gstack main (no changes)
  .\scripts\update-gstack.ps1 -Apply               # pin latest main, build, smoke-test (does not deploy)
  .\scripts\update-gstack.ps1 -Apply -Deploy       # ...and deploy if the smoke test passes
  .\scripts\update-gstack.ps1 -Ref 1a2b3c4 -Apply  # pin a specific commit
#>
param(
  [string]$Ref = 'main',
  [switch]$Apply,
  [switch]$Deploy
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Root = Split-Path $PSScriptRoot
$refFile = Join-Path $Root '.gstack-ref'
$repo = 'garrytan/gstack'
$current = (Get-Content $refFile -Raw).Trim()

# Resolve the target commit
if ($Ref -match '^[0-9a-f]{40}$') { $target = $Ref }
else {
  $c = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/commits/$Ref" -Headers @{ 'User-Agent' = 'gstack-browser-mcp' }
  $target = $c.sha
}
Write-Host "current pin: $current"
Write-Host "target:      $target ($Ref)"
if ($target -eq $current) { Write-Host 'Already up to date.' -ForegroundColor Green; return }

# What changed upstream
$cmp = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/compare/$current...$target" -Headers @{ 'User-Agent' = 'gstack-browser-mcp' }
Write-Host ''
Write-Host "$($cmp.ahead_by) new commit(s) upstream ($($cmp.status)). Latest:" -ForegroundColor Cyan
$cmp.commits | Select-Object -Last 15 | ForEach-Object { '  {0}  {1}' -f $_.sha.Substring(0, 8), ($_.commit.message -split "`n")[0] }

# Files that matter to us (plan §9 risks): the browse CLI/daemon and how skills find $B
$watch = @(
  @{ Pattern = '^browse/src/(cli|server|config|path-security|browser-manager|write-commands|read-commands|meta-commands|session-persist)\.ts$'; Why = 'browse CLI / daemon behaviour (commands, paths, cookies)' },
  @{ Pattern = '^scripts/resolvers/(runtime-root|browse|aside)\.ts$'; Why = 'how skills locate $B / choose a browser (browse-remote install path)' },
  @{ Pattern = '^(package\.json|bun\.lock|patches/)'; Why = 'dependencies (Playwright/Chromium version)' }
)
$hits = @()
foreach ($f in $cmp.files) {
  foreach ($w in $watch) { if ($f.filename -match $w.Pattern) { $hits += ('  {0,-55} {1}' -f $f.filename, $w.Why) } }
}
Write-Host ''
if ($hits) {
  Write-Host 'Changed files that affect this project (review before deploying):' -ForegroundColor Yellow
  $hits | Sort-Object -Unique | ForEach-Object { Write-Host $_ }
} else { Write-Host 'No changes to the browse CLI/daemon or the $B lookup.' -ForegroundColor Green }
if ($cmp.files.Count -ge 300) { Write-Host '(GitHub lists at most 300 files; the list above may be incomplete.)' }

if (-not $Apply) { Write-Host ''; Write-Host 'Dry run. Re-run with -Apply to pin it, build and smoke-test.' -ForegroundColor Yellow; return }

[IO.File]::WriteAllText($refFile, "$target`n", (New-Object System.Text.UTF8Encoding($false)))
Write-Host "pinned .gstack-ref -> $target"
$buildArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Root 'build-image.ps1'), '-SmokeTest')
if ($Deploy) { $buildArgs += '-Deploy' }
& powershell @buildArgs
if ($LASTEXITCODE -ne 0) {
  [IO.File]::WriteAllText($refFile, "$current`n", (New-Object System.Text.UTF8Encoding($false)))
  Write-Host "Build or smoke test FAILED: restored .gstack-ref to $current. The running stack was not changed." -ForegroundColor Red
  exit 1
}
Write-Host "gstack updated to $($target.Substring(0, 10))$(if ($Deploy) { ' and deployed' } else { '. Deploy with: .\build-image.ps1 -Deploy' })" -ForegroundColor Green
