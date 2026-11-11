#Requires -Version 7.0
<#
.SYNOPSIS
  Wrap the darwin build folder into an unsigned DMG for internal distribution.

.NOTES
  Requires macOS + hdiutil. Set SU_DARWIN_ARCH=arm64|x64 to match build-mac.ps1.
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

$Candidates = @(
  (Join-Path $Root "VSCode-darwin-$Arch"),
  (Join-Path $Vendor "../VSCode-darwin-$Arch"),
  (Join-Path $Vendor ".build/darwin-$Arch")
) | ForEach-Object {
  try { (Resolve-Path $_ -ErrorAction Stop).Path } catch { $null }
} | Where-Object { $_ -and (Test-Path $_) }

if (-not $Candidates -or $Candidates.Count -eq 0) {
  throw @"
No macOS build folder found for darwin-$Arch.
Expected VSCode-darwin-$Arch next to the repo root (sibling of vendor/).
Run ./scripts/build-mac.ps1 with SU_DARWIN_ARCH=$Arch first.
"@
}

$Source = $Candidates[0]
Write-Host "==> packaging from $Source"

$App = Get-ChildItem -Path $Source -Filter '*.app' -Directory -ErrorAction SilentlyContinue |
  Select-Object -First 1
if (-not $App) {
  throw "No .app bundle found under $Source"
}

Write-Host "==> app: $($App.FullName)"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
New-Item -ItemType Directory -Force -Path (Split-Path $DmgPath) | Out-Null

$Stage = Join-Path $OutDir 'stage'
New-Item -ItemType Directory -Force -Path $Stage | Out-Null
Copy-Item -Path $App.FullName -Destination (Join-Path $Stage $App.Name) -Recurse -Force

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
Copy-Item -Force $ReadmePath (Join-Path $Stage 'INSTALL-INTERNAL.txt')

# Create a temporary read/write UDRW image, then convert to compressed UDZO.
$TmpDmg = Join-Path $OutDir "tmp-$Arch.dmg"
if (Test-Path $TmpDmg) { Remove-Item -Force $TmpDmg }
if (Test-Path $DmgPath) { Remove-Item -Force $DmgPath }

$VolName = "su-$Arch"
& hdiutil create -volname $VolName -srcfolder $Stage -ov -format UDRW $TmpDmg
if ($LASTEXITCODE -ne 0) {
  throw "hdiutil create failed ($LASTEXITCODE)"
}

& hdiutil convert $TmpDmg -format UDZO -imagekey zlib-level=9 -o $DmgPath
if ($LASTEXITCODE -ne 0) {
  throw "hdiutil convert failed ($LASTEXITCODE)"
}

Remove-Item -Force $TmpDmg -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $Stage -ErrorAction SilentlyContinue

Write-Host "==> packaged: $DmgPath"
Write-Host "    notes:   $ReadmePath"
