#Requires -Version 5.1
<#
.SYNOPSIS
  Dev-run su via Code-OSS scripts/code.bat after bootstrap + compile.
  Faster path for v0.1 acceptance when full gulp packaging is still running.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'

if (-not (Test-Path $Vendor)) {
  & (Join-Path $PSScriptRoot 'bootstrap.ps1')
}

Push-Location $Vendor
try {
  & (Join-Path $PSScriptRoot 'apply-branding.ps1')
  & (Join-Path $PSScriptRoot 'inject-extension.ps1')

  if (-not (Test-Path 'node_modules')) {
    if (Test-Path 'package-lock.json') { npm ci } else { npm install }
  }

  Write-Host "==> compile (dev)"
  npm run compile

  Write-Host "==> launching scripts\code.bat (product name should be su)"
  cmd /c "scripts\code.bat"
} finally {
  Pop-Location
}
