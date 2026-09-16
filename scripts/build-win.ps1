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
# Bypass MSB8040 when Spectre libs are not installed (personal/dev machines)
$spectreProps = Join-Path $PSScriptRoot 'disable-spectre.props'
if (Test-Path $spectreProps) {
  $env:ForceImportBeforeCppTargets = $spectreProps
  Write-Host "==> ForceImportBeforeCppTargets=$spectreProps (SpectreMitigation=false)"
}

Push-Location $Vendor
try {
  # Prefer .bin shim — package folder alone can exist after a broken/partial install
  $depsOk = (Test-Path 'node_modules\.bin\npm-run-all2.cmd') -or (Test-Path 'node_modules\.bin\npm-run-all2')
  if (-not $depsOk) {
    Write-Host "==> npm ci (full vscode deps; may take 10-40+ minutes)"
    if (Test-Path 'package-lock.json') {
      Invoke-Native npm ci
    } else {
      Invoke-Native npm install
    }
  } else {
    Write-Host "==> node_modules looks complete; skip npm ci"
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
