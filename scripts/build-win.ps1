#Requires -Version 5.1
<#
.SYNOPSIS
  Build su IDE for Windows x64 from vendor/vscode.
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'

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

function Import-VcVars64 {
  $candidates = New-Object System.Collections.Generic.List[string]

  $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path $vswhere) {
    $installPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null
    if ($installPath) {
      $candidates.Add((Join-Path $installPath 'VC\Auxiliary\Build\vcvars64.bat'))
    }
  }

  @(
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat",
    "${env:ProgramFiles}\Microsoft Visual Studio\18\Enterprise\VC\Auxiliary\Build\vcvars64.bat",
    'G:\6\VS2019\Community\VC\Auxiliary\Build\vcvars64.bat',
    "${env:ProgramFiles(x86)}\Microsoft Visual Studio\2019\Community\VC\Auxiliary\Build\vcvars64.bat"
  ) | ForEach-Object { [void]$candidates.Add($_) }

  $vcvars = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $vcvars) {
    Write-Host "==> vcvars64.bat not found; relying on existing PATH / msvc-dev-cmd"
    return
  }

  Write-Host "==> import $vcvars"
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  cmd /c "`"$vcvars`" && set" | ForEach-Object {
    if ($_ -match '^(.*?)=(.*)$') {
      Set-Item -Path "env:$($matches[1])" -Value $matches[2]
    }
  }
  $ErrorActionPreference = $prev

  if (-not $env:VCINSTALLDIR) {
    Write-Host "==> warning: VCINSTALLDIR still empty after vcvars"
  } else {
    Write-Host "==> VCINSTALLDIR=$env:VCINSTALLDIR"
  }
}

if (-not (Test-Path $Vendor)) {
  throw "Run .\scripts\bootstrap.ps1 first"
}

Write-Host "==> build-win (this can take a long time)"
Import-VcVars64

# Help node-gyp on newer VS (e.g. VS 18 / 2022) when version probing is flaky
if (-not $env:npm_config_msvs_version) {
  $env:npm_config_msvs_version = '2022'
}
if ($env:PythonLocation) {
  $env:npm_config_python = (Join-Path $env:PythonLocation 'python.exe')
  Write-Host "==> npm_config_python=$env:npm_config_python"
}

$spectreLibCandidates = @(
  'G:\6\VS2019\Community\VC\Tools\MSVC\14.29.30133\lib\spectre\x64'
)
if ($env:VCINSTALLDIR) {
  Get-ChildItem (Join-Path $env:VCINSTALLDIR 'Tools\MSVC') -Directory -ErrorAction SilentlyContinue |
    ForEach-Object { $spectreLibCandidates += (Join-Path $_.FullName 'lib\spectre\x64') }
}
$hasSpectre = $false
foreach ($p in $spectreLibCandidates) {
  if ($p -and (Test-Path $p)) { $hasSpectre = $true; Write-Host "==> Spectre libs found at $p"; break }
}
if (-not $hasSpectre) {
  $spectreProps = Join-Path $PSScriptRoot 'disable-spectre.props'
  if (Test-Path $spectreProps) {
    $env:ForceImportBeforeCppTargets = $spectreProps
    Write-Host "==> Spectre libs missing; using $spectreProps"
  }
} else {
  Remove-Item Env:ForceImportBeforeCppTargets -ErrorAction SilentlyContinue
}

Push-Location $Vendor
try {
  $depsOk = (Test-Path 'node_modules\.bin\npm-run-all2.cmd') -or (Test-Path 'node_modules\.bin\npm-run-all2')
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

  # Skip compile-copilot (Microsoft-only chat extension) for OSS packaging
  Write-Host "==> compile-client (skip compile-copilot)"
  Invoke-Native npm run compile-client
  Invoke-Native npm run gulp -- compile-build-without-mangling
  Invoke-Native npm run gulp -- compile-extensions-build
  Invoke-Native npm run gulp -- compile-extension-media

  Write-Host "==> gulp vscode-win32-x64-min-ci"
  Invoke-Native npm run gulp -- vscode-win32-x64-min-ci
} finally {
  Pop-Location
}

Write-Host "==> build-win finished. Next: .\scripts\package-win.ps1"
