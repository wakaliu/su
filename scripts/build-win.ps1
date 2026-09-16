#Requires -Version 5.1
<#
.SYNOPSIS
  Build su IDE for Windows x64 from vendor/vscode.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'

if (-not (Test-Path $Vendor)) {
  throw "Run .\scripts\bootstrap.ps1 first"
}

Write-Host "==> build-win (this can take a long time)"
Push-Location $Vendor
try {
  if (-not (Test-Path 'node_modules')) {
    Write-Host "==> npm ci / npm install"
    if (Test-Path 'package-lock.json') {
      npm ci
    } else {
      npm install
    }
  }

  # Ensure branding + extension are current
  & (Join-Path $PSScriptRoot 'apply-branding.ps1')
  & (Join-Path $PSScriptRoot 'inject-extension.ps1')

  Write-Host "==> compile client + extensions build pipeline"
  npm run compile
  npm run gulp -- compile-build-without-mangling
  npm run gulp -- compile-extensions-build
  npm run gulp -- compile-extension-media

  Write-Host "==> gulp vscode-win32-x64-min-ci"
  npm run gulp -- vscode-win32-x64-min-ci
} finally {
  Pop-Location
}

Write-Host "==> build-win finished. Next: .\scripts\package-win.ps1"
