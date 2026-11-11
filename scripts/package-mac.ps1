#Requires -Version 7.0
<#
.SYNOPSIS
  Wrap the darwin build folder into an unsigned DMG for internal distribution.

.NOTES
  Requires macOS + hdiutil. Set SU_DARWIN_ARCH=arm64|x64 to match build-mac.ps1.
  Upstream gulp writes to <dirname(vendor/vscode)>/VSCode-darwin-<arch> i.e. vendor/VSCode-darwin-*.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor/vscode'

if (-not $IsMacOS) {
  throw "package-mac.ps1 must run on macOS."
}

$Arch = if ($env:SU_DARWIN_ARCH) { $env:SU_DARWIN_ARCH.Trim().ToLowerInvariant() } else { '' }
if (-not $Arch) {
  $Arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -match 'Arm') { 'arm64' } else { 'x64' }
}
if ($Arch -notin @('arm64', 'x64')) {
  throw "SU_DARWIN_ARCH must be arm64 or x64 (got '$Arch')"
}

$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Version = '0.0.0'
$VersionFile = Join-Path $Root 'branding/version.json'
if (Test-Path $VersionFile) {
  try {
    $Version = (Get-Content -Raw -Encoding UTF8 $VersionFile | ConvertFrom-Json).version
  } catch { }
}

$OutDir = Join-Path $Root "out/darwin-$Arch"
$DmgName = "su-darwin-$Arch-$Version-$Stamp.dmg"
$DmgPath = Join-Path $Root "out/$DmgName"
$ReadmePath = Join-Path $OutDir 'INSTALL-INTERNAL.txt'

function Get-FullPathSafe([string]$Path) {
  if (-not $Path) { return $null }
  try {
    return [System.IO.Path]::GetFullPath($Path)
  } catch {
    return $null
  }
}

function Find-AppBundle([string]$Dir) {
  if (-not $Dir -or -not (Test-Path -LiteralPath $Dir)) {
    return $null
  }
  # .app is a directory bundle; avoid -Filter/-Directory quirks on macOS PS.
  $direct = Get-ChildItem -LiteralPath $Dir -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.PSIsContainer -and $_.Name -like '*.app' } |
    Select-Object -First 1
  if ($direct) {
    return $direct
  }
  return Get-ChildItem -LiteralPath $Dir -Recurse -Depth 2 -Force -ErrorAction SilentlyContinue |
    Where-Object { $_.PSIsContainer -and $_.Name -like '*.app' } |
    Select-Object -First 1
}

# gulpfile.vscode.ts: buildRoot = dirname(vscodeRoot) => vendor/VSCode-darwin-<arch>
$CandidatePaths = @(
  (Join-Path $Root "vendor/VSCode-darwin-$Arch"),
  (Join-Path $Root "VSCode-darwin-$Arch"),
  (Get-FullPathSafe (Join-Path $Vendor "..\VSCode-darwin-$Arch")),
  (Get-FullPathSafe (Join-Path $Vendor "../VSCode-darwin-$Arch")),
  (Join-Path $Vendor ".build/electron/darwin-$Arch"),
  (Join-Path $Vendor ".build/darwin-$Arch")
) | ForEach-Object { Get-FullPathSafe $_ } | Where-Object { $_ } | Select-Object -Unique

Write-Host "==> looking for VSCode-darwin-$Arch under:"
foreach ($p in $CandidatePaths) {
  $exists = Test-Path -LiteralPath $p
  Write-Host "    [$exists] $p"
}

$Source = $null
$App = $null
foreach ($p in $CandidatePaths) {
  if (-not (Test-Path -LiteralPath $p)) {
    continue
  }
  $found = Find-AppBundle $p
  if ($found) {
    $Source = $p
    $App = $found
    break
  }
}

if (-not $Source -or -not $App) {
  $hintDirs = @(
    (Join-Path $Root 'vendor'),
    $Root
  )
  foreach ($d in $hintDirs) {
    if (Test-Path -LiteralPath $d) {
      Write-Host "==> listing $d"
      Get-ChildItem -LiteralPath $d -Force -ErrorAction SilentlyContinue |
        Select-Object -First 40 Name, Mode |
        ForEach-Object { Write-Host ("    {0} {1}" -f $_.Mode, $_.Name) }
    }
  }
  throw @"
No .app bundle found for darwin-$Arch.
Expected gulp output at: vendor/VSCode-darwin-$Arch/*.app
Run ./scripts/build-mac.ps1 with SU_DARWIN_ARCH=$Arch first.
"@
}

Write-Host "==> packaging from $Source"
Write-Host "==> app: $($App.FullName)"

if (Test-Path -LiteralPath $OutDir) { Remove-Item -Recurse -Force -LiteralPath $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $DmgPath) | Out-Null

$Stage = Join-Path $OutDir 'stage'
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item -LiteralPath $App.FullName -Destination (Join-Path $Stage $App.Name) -Recurse -Force

$InstallText = @"
su macOS — 内部未签名包（darwin-$Arch）

版本: $Version
架构: $Arch
应用: $($App.Name)

首次打开若被 Gatekeeper 拦截：
1. 将 $($App.Name) 拖到「应用程序」
2. 右键点击应用 →「打开」→ 仍要打开
   或在终端执行：
   xattr -cr "/Applications/$($App.Name)"

本包未做 Apple 公证，仅供内部分发。
"@
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($ReadmePath, $InstallText, $utf8)
Copy-Item -Force -LiteralPath $ReadmePath -Destination (Join-Path $Stage 'INSTALL-INTERNAL.txt')

$TmpDmg = Join-Path $OutDir "tmp-$Arch.dmg"
if (Test-Path -LiteralPath $TmpDmg) { Remove-Item -Force -LiteralPath $TmpDmg }
if (Test-Path -LiteralPath $DmgPath) { Remove-Item -Force -LiteralPath $DmgPath }

$VolName = "su-$Arch"
& hdiutil create -volname $VolName -srcfolder $Stage -ov -format UDRW $TmpDmg
if ($LASTEXITCODE -ne 0) {
  throw "hdiutil create failed ($LASTEXITCODE)"
}

& hdiutil convert $TmpDmg -format UDZO -imagekey zlib-level=9 -o $DmgPath
if ($LASTEXITCODE -ne 0) {
  throw "hdiutil convert failed ($LASTEXITCODE)"
}

Remove-Item -Force -LiteralPath $TmpDmg -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force -LiteralPath $Stage -ErrorAction SilentlyContinue

Write-Host "==> packaged: $DmgPath"
Write-Host "    notes:   $ReadmePath"
