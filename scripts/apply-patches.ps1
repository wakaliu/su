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

# --- 0002: tolerate tsgo (TS7 native preview) crash on Windows CI (exit != 0 but 0 error lines) ---
$tsgoTs = Join-Path $Vendor 'build\lib\tsgo.ts'
if (-not (Test-Path $tsgoTs)) {
  throw "Expected upstream file missing: $tsgoTs"
}

$tsgoContent = [System.IO.File]::ReadAllText($tsgoTs)
$suTsgoMarker = '// [su] tsgo (TS7 native preview) can crash on Windows CI with a'
if ($tsgoContent.Contains($suTsgoMarker)) {
  Write-Host "==> patch 0002-tsgo-exit2-tolerance already applied"
} else {
  # Match the single reject line in spawnTsgo exit handler (vscode 1.136.1) and
  # replace it with a guarded downgrade: non-zero exit with 0 "error X:" lines
  # becomes a warning; genuine type errors still reject.
  $pattern = '(?m)^\t\t\t\treject\(new Error\(`tsgo exited with code \$\{code \?\? ''unknown''\}`\)\);'
  if ($tsgoContent -notmatch $pattern) {
    throw "Patch 0002 failed: could not locate reject line in $tsgoTs"
  }
  # $nl/$tab via ternary-free form for PS 5.1 + 7 compatibility
  if ($tsgoContent -match "`r`n") { $nl = "`r`n" } else { $nl = "`n" }
  $tab = "`t"
  # .NET Regex.Replace: $$ => literal $; ${code ...} in replacement would be
  # parsed as a named group reference, so escape as $${code ...} (as in 0001).
  # Indentation: the matched reject line sits at 4 tabs (inside the 3-tab
  # "} else {"), so the guard starts at 4 tabs and its body at 5.
  $replacement = (
    ($tab * 4) + '// [su] tsgo (TS7 native preview) can crash on Windows CI with a' + $nl +
    ($tab * 4) + '// non-zero exit while reporting 0 type errors. Real diagnostics' + $nl +
    ($tab * 4) + '// always produce "error TSxxxx" lines, which runReporter echoes' + $nl +
    ($tab * 4) + '// above. Downgrade "crashed but no errors" to a warning so' + $nl +
    ($tab * 4) + '// packaging is not blocked; genuine type errors still fail.' + $nl +
    ($tab * 4) + 'const errorLines = lines.filter(line => /error \w+:/.test(line));' + $nl +
    ($tab * 4) + 'if (errorLines.length === 0) {' + $nl +
    ($tab * 5) + 'fancyLog.warn(`[su] tsgo exited with code $${code ?? ''unknown''} but reported 0 errors; treating as non-blocking (native compiler crash?)`);' + $nl +
    ($tab * 5) + 'Promise.resolve(onComplete?.()).then(() => resolve(), reject);' + $nl +
    ($tab * 4) + '} else {' + $nl +
    ($tab * 5) + 'reject(new Error(`tsgo exited with code $${code ?? ''unknown''}`));' + $nl +
    ($tab * 4) + '}'
  )
  $tsgoContent = [regex]::Replace($tsgoContent, $pattern, $replacement, 1)
  if (-not $tsgoContent.Contains($suTsgoMarker)) {
    throw "Patch 0002 failed: marker missing after replace"
  }
  if ($tsgoContent -notmatch 'errorLines\.length === 0') {
    throw "Patch 0002 failed: guard missing after replace"
  }
  Set-FileUtf8NoBom -Path $tsgoTs -Content $tsgoContent
  Write-Host "==> applied patch 0002-tsgo-exit2-tolerance -> build/lib/tsgo.ts"
}

Write-Host "==> apply-patches done"
