#Requires -Version 5.1
<#
.SYNOPSIS
  Dev-run su via Code-OSS scripts/code.bat after bootstrap + compile.
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
  & (Join-Path $PSScriptRoot 'bootstrap.ps1')
}

Push-Location $Vendor
try {
  & (Join-Path $PSScriptRoot 'apply-branding.ps1')
  & (Join-Path $PSScriptRoot 'inject-extension.ps1')

  if (-not (Test-Path 'node_modules')) {
    if (Test-Path 'package-lock.json') { Invoke-Native npm ci } else { Invoke-Native npm install }
  }

  Write-Host "==> compile (dev)"
  Invoke-Native npm run compile

  Write-Host "==> launching scripts\code.bat (product name should be su)"
  cmd /c "scripts\code.bat"
} finally {
  Pop-Location
}
