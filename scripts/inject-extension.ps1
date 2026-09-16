#Requires -Version 5.1
<#
.SYNOPSIS
  Copy extensions/su-ai into vendor/vscode/extensions/su-ai for built-in shipping.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Src = Join-Path $Root 'extensions\su-ai'
$Dst = Join-Path $Root 'vendor\vscode\extensions\su-ai'

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

# Copy sources and package metadata; skip node_modules
Get-ChildItem -Path $Src -Force | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object {
  Copy-Item -Path $_.FullName -Destination (Join-Path $Dst $_.Name) -Recurse -Force
}

# Compile extension if tsc available after npm install in extension dir
Push-Location $Src
if (-not (Test-Path 'node_modules')) {
  npm install
}
npm run compile
Pop-Location

# Refresh out/ into vendor copy
$OutSrc = Join-Path $Src 'out'
$OutDst = Join-Path $Dst 'out'
if (Test-Path $OutSrc) {
  if (Test-Path $OutDst) { Remove-Item -Recurse -Force $OutDst }
  Copy-Item -Path $OutSrc -Destination $OutDst -Recurse -Force
}

Write-Host "==> su-ai injected"
