#Requires -Version 5.1
<#
.SYNOPSIS
  Build su IDE for Windows x64 from vendor/vscode.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'

function Invoke-Native {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$ArgumentList
  )
  # npm/node often write warnings to stderr; do not treat as terminating under Stop
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $FilePath @ArgumentList
    if ($LASTEXITCODE -ne 0) {
      throw "Command failed ($LASTEXITCODE): $FilePath $($ArgumentList -join ' ')"
    }
  } finally {
    $ErrorActionPreference = $prev
  }
}

if (-not (Test-Path $Vendor)) {
  throw "Run .\scripts\bootstrap.ps1 first"
}

Write-Host "==> build-win (this can take a long time)"
Push-Location $Vendor
try {
  if (-not (Test-Path 'node_modules')) {
    Write-Host "==> npm ci / npm install"
    if (Test-Path 'package-lock.json') {
      Invoke-Native npm ci
    } else {
      Invoke-Native npm install
    }
  }

  & (Join-Path $PSScriptRoot 'apply-branding.ps1')
  & (Join-Path $PSScriptRoot 'inject-extension.ps1')

  Write-Host "==> compile client + extensions build pipeline"
  Invoke-Native npm run compile
  Invoke-Native npm run gulp -- compile-build-without-mangling
  Invoke-Native npm run gulp -- compile-extensions-build
  Invoke-Native npm run gulp -- compile-extension-media

  Write-Host "==> gulp vscode-win32-x64-min-ci"
  Invoke-Native npm run gulp -- vscode-win32-x64-min-ci
} finally {
  Pop-Location
}

Write-Host "==> build-win finished. Next: .\scripts\package-win.ps1"
