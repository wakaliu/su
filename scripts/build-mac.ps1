#Requires -Version 7.0
<#
.SYNOPSIS
  Build su IDE for macOS (darwin-arm64 or darwin-x64) from vendor/vscode.

.NOTES
  Must run on macOS. Set SU_DARWIN_ARCH=arm64|x64 (default: host arch).
  Produces unsigned app under ../VSCode-darwin-<arch> relative to vendor.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor/vscode'

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

function Invoke-Gulp {
  param(
    [Parameter(Mandatory = $true)][string[]]$Tasks
  )
  $heapMb = if ($env:SU_NODE_HEAP_MB) { $env:SU_NODE_HEAP_MB } else { '8192' }
  Write-Host "==> gulp ($($Tasks -join ' ')) heap=${heapMb}MB"
  Invoke-Native node --experimental-strip-types "--max-old-space-size=$heapMb" ./node_modules/gulp/bin/gulp.js @Tasks
}

function Ensure-DarwinIcns {
  $icns = Join-Path $Root 'branding/icons/darwin/code.icns'
  if (Test-Path $icns) {
    return
  }
  $png = Join-Path $Root 'branding/icons/darwin/su-1024.png'
  if (-not (Test-Path $png)) {
    $png = Join-Path $Root 'branding/icons/png/su-1024.png'
  }
  if (-not (Test-Path $png)) {
    Write-Host "==> no PNG for darwin icns; packaging will use upstream icon"
    return
  }
  if (-not (Get-Command iconutil -ErrorAction SilentlyContinue)) {
    Write-Host "==> iconutil missing; skip generating code.icns"
    return
  }

  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("su-iconset-" + [guid]::NewGuid().ToString('N'))
  $iconset = Join-Path $tmp 'code.iconset'
  New-Item -ItemType Directory -Force -Path $iconset | Out-Null
  try {
    $sizes = @(16, 32, 64, 128, 256, 512, 1024)
    foreach ($s in $sizes) {
      # iconutil expects exact pixel sizes; sips resizes from master PNG.
      $out1 = Join-Path $iconset "icon_${s}x${s}.png"
      Invoke-Native sips -z $s $s $png --out $out1
      if ($s -le 512) {
        $out2 = Join-Path $iconset "icon_${s}x${s}@2x.png"
        $px = $s * 2
        Invoke-Native sips -z $px $px $png --out $out2
      }
    }
    $darwinDir = Join-Path $Root 'branding/icons/darwin'
    New-Item -ItemType Directory -Force -Path $darwinDir | Out-Null
    Invoke-Native iconutil -c icns $iconset -o $icns
    Write-Host "==> generated $icns"
  } finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  }
}

if (-not $IsMacOS) {
  throw "build-mac.ps1 must run on macOS (GitHub Actions macos-* or a Mac host)."
}

$Arch = if ($env:SU_DARWIN_ARCH) { $env:SU_DARWIN_ARCH.Trim().ToLowerInvariant() } else { '' }
if (-not $Arch) {
  $Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -match 'Arm') { 'arm64' } else { 'x64' }
}
if ($Arch -notin @('arm64', 'x64')) {
  throw "SU_DARWIN_ARCH must be arm64 or x64 (got '$Arch')"
}

if (-not (Test-Path $Vendor)) {
  throw "Run ./scripts/bootstrap.ps1 first"
}

$UseEsbuild = -not ($env:SU_BUILD_LEGACY -eq '1')
Write-Host "==> build-mac arch=$Arch esbuild=$UseEsbuild"

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCmd) {
  $nodeDir = Split-Path -Parent $nodeCmd.Source
  $env:PATH = "$nodeDir$([IO.Path]::PathSeparator)$env:PATH"
  Write-Host "==> prepend node dir to PATH: $nodeDir"
} else {
  throw "node not found on PATH before npm ci"
}

if ($env:PythonLocation) {
  $py = Join-Path $env:PythonLocation 'bin/python3'
  if (Test-Path $py) {
    $env:npm_config_python = $py
    Write-Host "==> npm_config_python=$env:npm_config_python"
  }
}

Ensure-DarwinIcns

Push-Location $Vendor
try {
  $depsOk = (Test-Path 'node_modules/.bin/npm-run-all2') -or (Test-Path 'node_modules/.bin/gulp')
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
  & (Join-Path $PSScriptRoot 'apply-patches.ps1')

  $gulpTask = "vscode-darwin-$Arch"
  if ($UseEsbuild) {
    Write-Host "==> gulp $gulpTask (esbuild)"
    Invoke-Gulp $gulpTask
  } else {
    Invoke-Gulp compile-build-without-mangling
    Invoke-Gulp compile-extensions-build
    Invoke-Gulp compile-extension-media
    Invoke-Gulp bundle-vscode
    Write-Host "==> gulp ${gulpTask}-ci"
    Invoke-Gulp "${gulpTask}-ci"
  }
} finally {
  Pop-Location
}

Write-Host "==> build-mac finished. Next: ./scripts/package-mac.ps1 (SU_DARWIN_ARCH=$Arch)"
