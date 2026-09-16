#Requires -Version 5.1
<#
.SYNOPSIS
  Collect Windows build output into out/win32-x64 zip for acceptance.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'
$OutDir = Join-Path $Root 'out\win32-x64'
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$ZipPath = Join-Path $Root "out\su-win32-x64-$Stamp.zip"

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

New-Item -ItemType Directory -Force -Path (Split-Path $ZipPath) | Out-Null
if (Test-Path $ZipPath) { Remove-Item -Force $ZipPath }
Compress-Archive -Path (Join-Path $OutDir '*') -DestinationPath $ZipPath -Force

Write-Host "==> packaged: $ZipPath"
Write-Host "    folder:  $OutDir"
