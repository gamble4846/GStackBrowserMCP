<#
.SYNOPSIS
  Create, rotate, disable or list API keys for GStack Browser MCP.
  keys.json only stores SHA-256 hashes; the key itself is printed ONCE.
.EXAMPLE
  .\scripts\new-key.ps1 -User rohan -Role admin
  .\scripts\new-key.ps1 -User alice -MaxSessions 2
  .\scripts\new-key.ps1 -User alice -Rotate        # disables alice's old keys, prints a new one
  .\scripts\new-key.ps1 -User alice -Disable       # disables all of alice's keys
  .\scripts\new-key.ps1 -List
#>
param(
  [string]$User,
  [ValidateSet('user', 'admin')][string]$Role = 'user',
  [int]$MaxSessions = 0,
  [switch]$Rotate,
  [switch]$Disable,
  [switch]$List,
  [string]$KeysFile = 'F:\DockerVolumes\GStackBrowserMCP\keys.json'
)
$ErrorActionPreference = 'Stop'

function Read-Keys {
  if (-not (Test-Path $KeysFile)) { return [pscustomobject]@{ keys = [pscustomobject]@{} } }
  $text = [System.IO.File]::ReadAllText($KeysFile).TrimStart([char]0xFEFF)
  $obj = $text | ConvertFrom-Json
  if (-not $obj.keys) { $obj | Add-Member -NotePropertyName keys -NotePropertyValue ([pscustomobject]@{}) -Force }
  return $obj
}
function Write-Keys($obj) {
  $dir = Split-Path $KeysFile
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
  # UTF-8 without BOM: the server's JSON parser must not see a BOM.
  [System.IO.File]::WriteAllText($KeysFile, ($obj | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
}

$data = Read-Keys

if ($List) {
  foreach ($p in $data.keys.PSObject.Properties) {
    $e = $p.Value
    $state = 'active'
    if ($e.disabled) { $state = 'DISABLED' }
    '{0}  {1,-16} {2,-6} max={3} created={4} {5}' -f $p.Name.Substring(0, 8), $e.user, $e.role, $e.maxSessions, $e.created, $state
  }
  return
}
if (-not $User) { throw '-User is required (or use -List).' }
if ($User -notmatch '^[A-Za-z0-9][A-Za-z0-9_.@-]{0,63}$') { throw 'User: letters, digits, _ . @ - (max 64).' }

if ($Rotate -or $Disable) {
  $n = 0
  foreach ($p in $data.keys.PSObject.Properties) {
    if ($p.Value.user -eq $User -and -not $p.Value.disabled) {
      $p.Value | Add-Member -NotePropertyName disabled -NotePropertyValue $true -Force
      $n++
    }
  }
  Write-Host "Disabled $n key(s) for $User."
  if ($Disable) { Write-Keys $data; return }
}

$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$key = 'gsk_' + ([Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_'))
$sha = [System.Security.Cryptography.SHA256]::Create()
$hash = -join ($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($key)) | ForEach-Object { $_.ToString('x2') })

$entry = [ordered]@{ user = $User; role = $Role; created = (Get-Date).ToString('yyyy-MM-dd') }
if ($MaxSessions -gt 0) { $entry.maxSessions = $MaxSessions }
$data.keys | Add-Member -NotePropertyName $hash -NotePropertyValue ([pscustomobject]$entry) -Force
Write-Keys $data

Write-Host ''
Write-Host "New $Role key for ${User} (shown once, store it safely):" -ForegroundColor Yellow
Write-Host "  $key"
Write-Host ''
Write-Host 'The server picks up keys.json changes within 5 seconds.'
Write-Host 'Acceptable use: test and QA your own apps only; no scraping, spam or attacks. Keys are revoked on misuse.'
