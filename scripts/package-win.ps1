#Requires -Version 5.1
<#
.SYNOPSIS
  Collect Windows build into out/win32-x64 zip + Inno User Setup (fixed install path).

.NOTES
  User Setup defaults to %LOCALAPPDATA%\Programs\su (same pattern as VS Code User installer).
  Set SU_SKIP_SETUP=1 to only produce the portable zip.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'
$OutDir = Join-Path $Root 'out\win32-x64'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Version = '0.0.0'
$VersionFile = Join-Path $Root 'branding\version.json'
if (Test-Path $VersionFile) {
  try {
    $Version = (Get-Content -Raw -Encoding UTF8 $VersionFile | ConvertFrom-Json).version
  } catch { }
}
$ZipPath = Join-Path $Root "out\su-win32-x64-$Version-$Stamp.zip"
$SetupOutName = "su-win32-x64-$Version-UserSetup.exe"
$SetupDest = Join-Path $Root "out\$SetupOutName"

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
  Invoke-Native node --experimental-strip-types "--max-old-space-size=$heapMb" .\node_modules\gulp\bin\gulp.js @Tasks
}

# Upstream gulp typically writes to .build/ or ../VSCode-win32-x64 relative to vscode
$Candidates = @(
  (Join-Path $Root 'VSCode-win32-x64'),
  (Join-Path $Vendor '..\VSCode-win32-x64' | Resolve-Path -ErrorAction SilentlyContinue),
  (Join-Path $Vendor '.build\win32-x64'),
  (Join-Path $Vendor '..\su-win32-x64' | Resolve-Path -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path $_) }

if (-not $Candidates -or $Candidates.Count -eq 0) {
  throw @"
No Windows build folder found.
Expected one of: VSCode-win32-x64 next to vendor, or gulp output under vendor/.build
Run .\scripts\build-win.ps1 successfully first.
"@
}

$Source = $Candidates[0].ToString()
Write-Host "==> packaging from $Source"

if (Test-Path $OutDir) { Remove-Item -Recurse -Force $OutDir }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
Copy-Item -Path (Join-Path $Source '*') -Destination $OutDir -Recurse -Force

$InstallText = @"
su Windows 包说明
================

1) 推荐：UserSetup 安装器（固定路径）
   - 运行 out\su-win32-x64-*-UserSetup.exe
   - 默认安装到：%LOCALAPPDATA%\Programs\su
     即 C:\Users\<你>\AppData\Local\Programs\su
   - 升级覆盖同一目录，便于安全软件加白名单（避免每次解压到带时间戳的新文件夹）

2) 便携 zip（可选）
   - 解压 out\su-win32-x64-*-*.zip 后运行 su.exe
   - 若使用便携包，建议始终解压到同一固定目录，不要每次换文件夹名

3) 360 等安全软件
   - 可将「%LOCALAPPDATA%\Programs\su」整目录加入信任区
   - native-keymap 等 .node 为 Electron/Code-OSS 正常依赖，不是木马
"@
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText((Join-Path $OutDir 'INSTALL-WINDOWS.txt'), $InstallText, $utf8)

New-Item -ItemType Directory -Force -Path (Split-Path $ZipPath) | Out-Null
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $ZipPath -Force
Write-Host "==> packaged zip: $ZipPath"
Write-Host "    folder:       $OutDir"

$SkipSetup = $env:SU_SKIP_SETUP -eq '1'
if ($SkipSetup) {
  Write-Host '==> SU_SKIP_SETUP=1; skip Inno User Setup'
  return
}

# Inno User Setup → DefaultDirName={userpf}\su → %LOCALAPPDATA%\Programs\su
Push-Location $Vendor
try {
  if (-not (Test-Path 'node_modules\gulp\bin\gulp.js')) {
    throw 'vendor/vscode node_modules missing gulp; run build-win.ps1 / npm ci first'
  }
  if (-not (Test-Path 'node_modules\innosetup')) {
    throw 'innosetup npm package missing under vendor/vscode; run npm ci in vendor/vscode'
  }

  Write-Host '==> gulp vscode-win32-x64-inno-updater'
  Invoke-Gulp 'vscode-win32-x64-inno-updater'

  Write-Host '==> gulp vscode-win32-x64-user-setup (fixed path: %LOCALAPPDATA%\Programs\su)'
  Invoke-Gulp 'vscode-win32-x64-user-setup'
} finally {
  Pop-Location
}

$SetupCandidates = @(
  (Join-Path $Vendor '.build\win32-x64\user-setup\VSCodeSetup.exe'),
  (Join-Path $Vendor '.build\win32-x64\user-setup\suSetup.exe')
) | Where-Object { Test-Path $_ }

if (-not $SetupCandidates -or $SetupCandidates.Count -eq 0) {
  Get-ChildItem -Path (Join-Path $Vendor '.build\win32-x64') -Recurse -Filter '*.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 20 FullName |
    ForEach-Object { Write-Host "  found: $($_.FullName)" }
  throw 'Inno User Setup exe not found under vendor/vscode/.build/win32-x64/user-setup/'
}

$SetupSrc = $SetupCandidates[0]
if (Test-Path $SetupDest) { Remove-Item -Force $SetupDest }
Copy-Item -Force $SetupSrc $SetupDest
Write-Host "==> packaged setup: $SetupDest"
Write-Host '    default install dir: %LOCALAPPDATA%\Programs\su'
