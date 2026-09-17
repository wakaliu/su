#Requires -Version 5.1
<#
.SYNOPSIS
  Apply su patches under patches/ onto vendor/vscode (idempotent).
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Vendor = Join-Path $Root 'vendor\vscode'

if (-not (Test-Path (Join-Path $Vendor '.git'))) {
  throw "vendor/vscode missing; run .\scripts\bootstrap.ps1 first"
}

function Set-FileUtf8NoBom {
  param([string]$Path, [string]$Content)
  $utf8 = New-Object System.Text.UTF8Encoding $false
  [System.IO.File]::WriteAllText($Path, $Content, $utf8)
}

# --- 0001: skip Copilot ripgrep shim when Copilot is not packaged (OSS) ---
$copilotTs = Join-Path $Vendor 'build\lib\copilot.ts'
if (-not (Test-Path $copilotTs)) {
  throw "Expected upstream file missing: $copilotTs"
}

$copilotContent = [System.IO.File]::ReadAllText($copilotTs)
$suMarker = '// [su] OSS builds omit Microsoft Copilot'
if ($copilotContent.Contains($suMarker)) {
  Write-Host "==> patch 0001-skip-copilot-shim already applied"
} else {
  # Match the throw branch in prepareBuiltInCopilotRipgrepShim (vscode 1.136.1).
  $pattern = '(?m)(\tif \(!fs\.existsSync\(copilotSdkBase\)\) \{\r?\n\t\t)throw new Error\(`\[prepareBuiltInCopilotRipgrepShim\] Copilot SDK directory not found at \$\{copilotSdkBase\}`\);(\r?\n\t\})'
  if ($copilotContent -notmatch $pattern) {
    throw "Patch 0001 failed: could not locate prepareBuiltInCopilotRipgrepShim throw in $copilotTs"
  }
  $nl = if ($copilotContent -match "`r`n") { "`r`n" } else { "`n" }
  $tab = "`t"
  # .NET Regex.Replace: $$ => literal $; ${1}/${2} are groups.
  # Desired TS source: console.log(`... ${copilotSdkBase}`);
  $skipLog = $tab + $tab + 'console.log(`[prepareBuiltInCopilotRipgrepShim] skip: Copilot SDK not found at $${copilotSdkBase}`);'
  $skipReturn = $tab + $tab + 'return;'
  $replacement = (
    '${1}' +
    '// [su] OSS builds omit Microsoft Copilot; packaging must not fail when it is absent.' + $nl +
    $skipLog + $nl +
    $skipReturn +
    '${2}'
  )
  $copilotContent = [regex]::Replace($copilotContent, $pattern, $replacement, 1)
  if (-not $copilotContent.Contains($suMarker)) {
    throw "Patch 0001 failed: marker missing after replace"
  }
  if ($copilotContent -notmatch 'skip: Copilot SDK not found at \$\{copilotSdkBase\}') {
    throw "Patch 0001 failed: template literal ${copilotSdkBase} mangled after replace"
  }
  Set-FileUtf8NoBom -Path $copilotTs -Content $copilotContent
  Write-Host "==> applied patch 0001-skip-copilot-shim -> build/lib/copilot.ts"
}

Write-Host "==> apply-patches done"
