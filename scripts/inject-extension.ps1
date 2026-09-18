#Requires -Version 5.1
<#
.SYNOPSIS
  Copy extensions/su-ai into vendor/vscode/extensions/su-ai for built-in shipping.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root 'extensions\su-ai'
$Dst = Join-Path $Root 'vendor\vscode\extensions\su-ai'

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

if (-not (Test-Path (Join-Path $Root 'vendor\vscode\extensions'))) {
  throw "vendor/vscode missing — run bootstrap.ps1 first"
}
if (-not (Test-Path $Src)) {
  throw "Missing $Src"
}

Write-Host "==> inject su-ai -> $Dst"
if (Test-Path $Dst) {
  Remove-Item -Recurse -Force $Dst
}
New-Item -ItemType Directory -Force -Path $Dst | Out-Null

Get-ChildItem -Path $Src -Force | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $Dst $_.Name) -Recurse -Force
}

Push-Location $Src
if (-not (Test-Path 'node_modules')) {
  Invoke-Native npm install
}
Invoke-Native npm run compile
Pop-Location

$OutSrc = Join-Path $Src 'out'
$OutDst = Join-Path $Dst 'out'
if (Test-Path $OutSrc) {
  if (Test-Path $OutDst) { Remove-Item -Recurse -Force $OutDst }
  Copy-Item -Path $OutSrc -Destination $OutDst -Recurse -Force
}

# Stamp product version into the built-in extension for update checks.
$VersionFile = Join-Path $Root 'branding\version.json'
if (Test-Path $VersionFile) {
  Copy-Item -Force $VersionFile (Join-Path $Dst 'version.json')
  Copy-Item -Force $VersionFile (Join-Path $Src 'version.json')
  try {
    $ver = (Get-Content -Raw -Encoding UTF8 $VersionFile | ConvertFrom-Json).version
    if ($ver) {
      $pkgPath = Join-Path $Dst 'package.json'
      $pkg = Get-Content -Raw -Encoding UTF8 $pkgPath | ConvertFrom-Json
      $pkg.version = "$ver"
      $json = $pkg | ConvertTo-Json -Depth 100
      [System.IO.File]::WriteAllText($pkgPath, $json)
      Write-Host "==> stamped su-ai version $ver"
    }
  } catch {
    Write-Host "==> warning: failed to stamp package.json version: $_"
  }
} else {
  Write-Host "==> warning: missing branding/version.json"
}

Write-Host "==> su-ai injected"
