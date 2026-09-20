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

function Get-Utf8NoBomText {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.File]::ReadAllText($Path)
}

function Set-Utf8NoBomText {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Text
  )
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Text, $utf8)
}

<#
  Reads branding version and normalizes to major.minor.patch for vsce.
  Avoid ConvertFrom-Json/ConvertTo-Json — they can coerce 0.1.0 → number 0.1
  and mangle non-ASCII in package.json.
#>
function Resolve-SuSemver {
  param([Parameter(Mandatory = $true)][string]$VersionFile)
  $raw = Get-Utf8NoBomText -Path $VersionFile
  $m = [regex]::Match($raw, '"version"\s*:\s*"([^"]+)"')
  if (-not $m.Success) {
    throw "branding/version.json missing string field `"version`""
  }
  $ver = $m.Groups[1].Value.Trim().TrimStart('v', 'V')
  # 0.1 → 0.1.0 ; keep pre-release suffix after patch when present
  if ($ver -match '^(\d+)\.(\d+)$') {
    $ver = "$ver.0"
  }
  if ($ver -notmatch '^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$') {
    throw "Invalid semver for extension package.json: '$ver' (vsce requires major.minor.patch)"
  }
  return $ver
}

function Set-PackageJsonVersion {
  param(
    [Parameter(Mandatory = $true)][string]$PackageJsonPath,
    [Parameter(Mandatory = $true)][string]$Version
  )
  $text = Get-Utf8NoBomText -Path $PackageJsonPath
  $updated = [regex]::Replace(
    $text,
    '"version"\s*:\s*"[^"]*"',
    ('"version": "' + $Version + '"'),
    1
  )
  if ($updated -eq $text -and $text -notmatch ('"version"\s*:\s*"' + [regex]::Escape($Version) + '"')) {
    throw "Failed to stamp version into $PackageJsonPath"
  }
  Set-Utf8NoBomText -Path $PackageJsonPath -Text $updated
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

# Stamp product version into the built-in extension for update checks / vsce.
$VersionFile = Join-Path $Root 'branding\version.json'
if (Test-Path $VersionFile) {
  Copy-Item -Force $VersionFile (Join-Path $Dst 'version.json')
  Copy-Item -Force $VersionFile (Join-Path $Src 'version.json')
  $ver = Resolve-SuSemver -VersionFile $VersionFile
  Set-PackageJsonVersion -PackageJsonPath (Join-Path $Dst 'package.json') -Version $ver
  Write-Host "==> stamped su-ai version $ver"
} else {
  Write-Host "==> warning: missing branding/version.json"
}

Write-Host "==> su-ai injected"
