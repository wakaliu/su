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

Write-Host "==> su-ai injected"
