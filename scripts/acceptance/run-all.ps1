param(
  [string]$HostsRoot = (Join-Path $env:TEMP 'dsh-acceptance\hosts'),
  [string]$RunRoot   = (Join-Path $env:TEMP 'dsh-acceptance\run'),
  [string]$Tarball,
  # Fixed ports are handed out from here, newest version first. Never 3080: that is
  # the host's own default and it collides with a running app.
  [int]$PortBase = 34800
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'   # one version failing must not stop the others

# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI code page, which mangles non-ASCII and can eat a closing quote.
#
# Driver: runs the six-stage acceptance for every release declared in the manifest,
# newest first, one at a time. Nothing here deletes anything - every Remove-Item in
# this flow lives inside run-one.ps1 and is guarded there. When the matrix is done
# the homes\ directory is left in place for inspection and removed by hand.

$runner = Join-Path $PSScriptRoot 'run-one.ps1'
if (-not (Test-Path -LiteralPath $runner)) { throw ("runner not found at " + $runner) }

# Refuse to run a runner that does not parse. A half-edited runner can fail at
# runtime, and a runtime failure can land after the first deletion already happened.
$parseErrors = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($runner, [ref]$null, [ref]$parseErrors)
if ($parseErrors -and $parseErrors.Count) {
  foreach ($e in $parseErrors) { Write-Host ("  parse error, line " + $e.Extent.StartLineNumber + ": " + $e.Message) }
  throw 'runner does not parse; refusing to run'
}

# The versions come from the manifest, not from a list written here, so this cannot
# drift away from what the package actually claims.
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json') -Raw | ConvertFrom-Json
# dshReleases is an OBJECT (version -> verdict), not an array. @($obj) wraps it in a
# one-element array, so the loop below would run once with the object itself and
# print "@{0.1.7-rc.1=compatible; ...}" as the version. Take the keys.
$versions = @($manifest.dsh.compatibility.dshReleases.PSObject.Properties.Name)
if (-not $versions.Count) { throw 'manifest declares no dshReleases' }

# Newest first, and "newest" has to mean newest. Stripping the prerelease with
# -replace '-.*$','' turns both 0.2.0-rc.1 and 0.2.0-rc.2 into the same sort key
# "0.2.0"; Sort-Object keeps ties in their original order, so rc.2 never rises
# above rc.1 and the run is not actually newest-first. Rank on the prerelease
# number too, and treat a final release as outranking its own prereleases.
function Get-VersionRank {
  param([string]$Spec)
  $m = [regex]::Match($Spec, '^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$')
  if (-not $m.Success) { throw ("declared DSH release is not a version number: " + $Spec) }
  $core = [double]$m.Groups[1].Value * 1e12 + [double]$m.Groups[2].Value * 1e8 + [double]$m.Groups[3].Value * 1e4
  $pre  = $m.Groups[4].Value
  if (-not $pre) { return $core + 9999 }
  $pm = [regex]::Match($pre, '^[A-Za-z][A-Za-z.-]*?(\d+)$')
  if (-not $pm.Success) {
    Write-Host ("  note: " + $Spec + " has an unrecognised prerelease tag '" + $pre + "'; ranking it as 0")
    return $core
  }
  return $core + [double]$pm.Groups[1].Value
}

$ordered = @($versions | Sort-Object { Get-VersionRank -Spec $_ } -Descending)
Write-Host ('versions, newest first: ' + ($ordered -join ', '))

$summary = @()
$i = 0
foreach ($v in $ordered) {
  $port = $PortBase + $i
  $i++
  Write-Host ''
  Write-Host ('################  ' + $v + '  port ' + $port + '  ################')
  $sw = [Diagnostics.Stopwatch]::StartNew()
  if ($Tarball) {
    $out = & $runner -v $v -HostsRoot $HostsRoot -RunRoot $RunRoot -Tarball $Tarball -Port $port
  } else {
    $out = & $runner -v $v -HostsRoot $HostsRoot -RunRoot $RunRoot -Port $port
  }
  $sw.Stop()
  $out | ForEach-Object { Write-Host $_ }
  $ok = @($out | Where-Object { $_ -match 'STAGE: all six steps done' }).Count -gt 0
  $summary += [pscustomobject]@{ version = $v; port = $port; completed = $ok; seconds = [int]$sw.Elapsed.TotalSeconds }
  Write-Host ('---- ' + $v + ' completed=' + $ok + ' in ' + [int]$sw.Elapsed.TotalSeconds + 's')
}

Write-Host ''
Write-Host '################  MATRIX SUMMARY  ################'
foreach ($s in $summary) {
  Write-Host ('  {0,-12} port {1}  {2,-10} {3,5}s' -f $s.version, $s.port, $s.completed, $s.seconds)
}
Write-Host ('logs under        ' + (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'logs'))
Write-Host ('profiles left in  ' + (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'homes'))