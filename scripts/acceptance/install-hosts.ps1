param(
  [string]$HostsRoot = (Join-Path $env:TEMP 'dsh-acceptance\hosts'),
  [string]$RunRoot   = (Join-Path $env:TEMP 'dsh-acceptance\run')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI code page, which mangles non-ASCII and can eat a closing quote.
#
# Puts one copy of every DSH release the manifest declares under $HostsRoot, so a
# matrix run can use that release's OWN CLI rather than whichever one happens to be
# on PATH. npm --prefix installs into <dir>\node_modules without needing the
# directory to be a project.
#
# This script contains NO Remove-Item at all. If a stale build ever needs to be
# removed, do it by hand; do not add a delete here. The only deletes in this folder
# live in run-one.ps1 and are confined to <RunRoot>\homes and <RunRoot>\logs.

$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json') -Raw | ConvertFrom-Json
$versions = @($manifest.dsh.compatibility.dshReleases)
if (-not $versions.Count) { throw 'manifest declares no dshReleases' }

$hostsRoot = [System.IO.Path]::GetFullPath($HostsRoot)
if (-not (Test-Path -LiteralPath $hostsRoot)) {
  New-Item -ItemType Directory -Path $hostsRoot -Force | Out-Null
}

foreach ($v in $versions) {
  $prefix = Join-Path $hostsRoot $v
  $exe    = Join-Path $prefix 'node_modules\.bin\dsh.cmd'
  if (Test-Path -LiteralPath $exe) {
    Write-Host ('    already present: ' + $v)
    continue
  }
  Write-Host ('=== installing @deepseek-ai/dsh@' + $v + ' ===')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $out = & npm install --prefix $prefix --no-save --loglevel=error "@deepseek-ai/dsh@$v" 2>&1
  $code = $LASTEXITCODE
  $sw.Stop()
  if ($code -ne 0) {
    Write-Host ('    FAILED exit=' + $code)
    $out | Select-Object -First 8 | ForEach-Object { Write-Host ('      ' + $_) }
    continue
  }
  $reported = if (Test-Path -LiteralPath $exe) { ((& $exe --version) -join '') } else { 'no .bin\dsh.cmd' }
  Write-Host ('    OK  {0:n1}s  reported: {1}' -f $sw.Elapsed.TotalSeconds, $reported)
}

Write-Host ('hosts root: ' + $hostsRoot)