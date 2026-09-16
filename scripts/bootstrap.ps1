#Requires -Version 5.1
<#
.SYNOPSIS
  Clone pinned microsoft/vscode, apply branding, inject su-ai.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'
$Tag = '1.136.1'
$Repo = 'https://github.com/microsoft/vscode.git'

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

Write-Host "==> su bootstrap (tag $Tag)"

if (-not (Test-Path (Join-Path $Vendor '.git'))) {
  New-Item -ItemType Directory -Force -Path (Split-Path $Vendor) | Out-Null
  if (Test-Path $Vendor) {
    Remove-Item -Recurse -Force $Vendor
  }
  Write-Host "==> cloning $Repo @ $Tag (shallow)"
  Invoke-Native git clone --depth 1 --branch $Tag $Repo $Vendor
} else {
  Push-Location $Vendor
  $current = (git describe --tags --exact-match 2>$null)
  if ($LASTEXITCODE -ne 0) { $current = (git rev-parse --abbrev-ref HEAD) }
  Pop-Location
  Write-Host "==> vendor exists ($current); skip clone. Delete vendor/vscode to re-clone."
}

& (Join-Path $PSScriptRoot 'apply-branding.ps1')
& (Join-Path $PSScriptRoot 'inject-extension.ps1')

Write-Host "==> bootstrap done"
