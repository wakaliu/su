#Requires -Version 5.1
<#
.SYNOPSIS
  Reset su UI state so startup opens the classic editor Welcome page
  instead of VS Code 1.136 Agents/Sessions ("Pitch your idea") window.

.DESCRIPTION
  vscode 1.136+ may restore lastActiveWindow pointing at
  %APPDATA%\su\User\agent-sessions.code-workspace (Sessions UI).
  su uses su-ai Chat instead of Microsoft Agents; this script clears that
  restore target and writes safe defaults.
#>
$ErrorActionPreference = 'Stop'

$suRoot = Join-Path $env:APPDATA 'su'
if (-not (Test-Path $suRoot)) {
  Write-Host "==> no user data at $suRoot (nothing to reset)"
  exit 0
}

Write-Host "==> stopping running su processes (if any)"
Get-Process -Name 'su' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Seconds 1

$storagePath = Join-Path $suRoot 'User\globalStorage\storage.json'
if (Test-Path $storagePath) {
  $raw = [System.IO.File]::ReadAllText($storagePath)
  $obj = $raw | ConvertFrom-Json
  $obj.windowsState = [pscustomobject]@{
    lastActiveWindow = $null
    openedWindows    = @()
  }
  if ($obj.backupWorkspaces -and $obj.backupWorkspaces.workspaces) {
    $kept = @($obj.backupWorkspaces.workspaces | Where-Object {
      -not ("$($_.configURIPath)" -match 'agent-sessions\.code-workspace')
    })
    $obj.backupWorkspaces.workspaces = $kept
  }
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($storagePath, ($obj | ConvertTo-Json -Depth 40), $utf8)
  Write-Host "==> cleared Agents/Sessions restore state in storage.json"
} else {
  Write-Host "==> no storage.json yet"
}

$settingsPath = Join-Path $suRoot 'User\settings.json'
$settings = [ordered]@{
  'chat.disableAIFeatures'                 = $true
  'workbench.startupEditor'                = 'welcomePage'
  'window.restoreWindows'                  = 'none'
  'workbench.commandPalette.showAskInChat' = $false
}
# Preserve unrelated user keys when settings already exist.
if (Test-Path $settingsPath) {
  try {
    $existing = Get-Content -Raw -Encoding UTF8 $settingsPath | ConvertFrom-Json
    foreach ($p in $existing.PSObject.Properties) {
      if (-not $settings.Contains($p.Name)) {
        $settings[$p.Name] = $p.Value
      }
    }
  } catch {
    Write-Host "==> warning: could not merge existing settings: $_"
  }
}
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($settingsPath, ($settings | ConvertTo-Json -Depth 20), $utf8)
Write-Host "==> wrote defaults -> $settingsPath"
Write-Host "==> done. Launch su.exe again; expect Welcome (su) + Su Chat, not Pitch your idea."
