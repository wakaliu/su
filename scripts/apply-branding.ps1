#Requires -Version 5.1
<#
.SYNOPSIS
  Deep-merge branding/product.overlay.json into vendor/vscode/product.json
#>
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$ProductPath = Join-Path $Root 'vendor\vscode\product.json'
$OverlayPath = Join-Path $Root 'branding\product.overlay.json'

if (-not (Test-Path $ProductPath)) {
  throw "Missing $ProductPath — run bootstrap.ps1 first"
}
if (-not (Test-Path $OverlayPath)) {
  throw "Missing $OverlayPath"
}

function ConvertTo-Hashtable($Object) {
  if ($null -eq $Object) { return $null }
  if ($Object -is [string] -or $Object -is [ValueType]) { return $Object }
  if ($Object -is [System.Collections.IDictionary]) {
    $h = @{}
    foreach ($k in $Object.Keys) { $h["$k"] = ConvertTo-Hashtable $Object[$k] }
    return $h
  }
  if ($Object -is [System.Management.Automation.PSCustomObject]) {
    $h = @{}
    foreach ($p in $Object.PSObject.Properties) {
      $h[$p.Name] = ConvertTo-Hashtable $p.Value
    }
    return $h
  }
  if ($Object -is [System.Collections.IEnumerable]) {
    $arr = [System.Collections.ArrayList]@()
    foreach ($item in $Object) { [void]$arr.Add((ConvertTo-Hashtable $item)) }
    return @($arr)
  }
  return $Object
}

function Merge-Hashtable([hashtable]$Target, [hashtable]$Source) {
  foreach ($key in $Source.Keys) {
    if ($Target.ContainsKey($key) -and $Target[$key] -is [hashtable] -and $Source[$key] -is [hashtable]) {
      Merge-Hashtable $Target[$key] $Source[$key]
    } else {
      $Target[$key] = $Source[$key]
    }
  }
}

Write-Host "==> apply branding overlay"
$product = ConvertTo-Hashtable (Get-Content -Raw -Encoding UTF8 $ProductPath | ConvertFrom-Json)
$overlay = ConvertTo-Hashtable (Get-Content -Raw -Encoding UTF8 $OverlayPath | ConvertFrom-Json)
Merge-Hashtable $product $overlay

$product['nameShort'] = 'su'
$product['nameLong'] = 'su'
$product['applicationName'] = 'su'
$product['win32DirName'] = 'su'
$product['win32NameVersion'] = 'su'
$product['win32RegValueName'] = 'su'
$product['win32AppUserModelId'] = 'Su.su'
$product['win32ShellNameShort'] = 'su'
$product['darwinBundleIdentifier'] = 'com.su.editor'
$product['linuxIconName'] = 'su'

$json = $product | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($ProductPath, $json)
Write-Host "==> branding applied -> $ProductPath"

# Replace Windows packaging icons when a custom pack is present.
$IconSrc = Join-Path $Root 'branding\icons\win32'
$IconDst = Join-Path $Root 'vendor\vscode\resources\win32'
if ((Test-Path (Join-Path $IconSrc 'code.ico')) -and (Test-Path $IconDst)) {
  Write-Host "==> apply win32 icons -> $IconDst"
  Copy-Item -Force (Join-Path $IconSrc 'code.ico') (Join-Path $IconDst 'code.ico')
  foreach ($name in @('code_150x150.png', 'code_70x70.png')) {
    $src = Join-Path $IconSrc $name
    if (Test-Path $src) {
      Copy-Item -Force $src (Join-Path $IconDst $name)
    }
  }
} elseif (-not (Test-Path (Join-Path $IconSrc 'code.ico'))) {
  Write-Host "==> skip win32 icons (missing branding/icons/win32/code.ico)"
} else {
  Write-Host "==> skip win32 icons (vendor resources/win32 missing)"
}
