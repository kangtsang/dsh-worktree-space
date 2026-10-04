param(
  [string]$HostsRoot = (Join-Path $env:TEMP 'dsh-acceptance\hosts'),
  [string]$RunRoot   = (Join-Path $env:TEMP 'dsh-acceptance\run'),
  [string]$Tarball,
  # Fixed ports are handed out from here, newest version first. Never 3080: that is
  # the host's own default and it collides with a running app.
  [int]$PortBase = 34800,
  # Where to write the run report. Defaults under the run root, which is scratch:
  # a report that lands in the repository on every run turns the diff into noise.
  # Point it at docs\ when a release is being recorded, and that one gets committed.
  [string]$ReportPath,
  # Also emit <name>.json next to the markdown. The markdown is for a human reading
  # a release note; the json is for a gate that has to decide without reading prose.
  [switch]$Json
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
#
# Each field goes into its own FIXED-WIDTH, zero-padded slot, and the whole key is
# one string. Fixed width is what makes the ordering total: a numeric scheme has
# to guess a bound for the widest field and is wrong the moment a version exceeds
# it, and that is not a hypothetical - an earlier attempt here put a final release
# at core+100000 while rc.N outranked it as soon as N reached five digits, because
# family*1e4 + 99999 = 119999. With padded strings there is nothing to overflow and
# nothing to spill into the next slot.
#
# Two ways ranking a prerelease on its number alone was wrong, both currently
# harmless because the manifest only declares rc.N - and both are landmines the
# day it does not:
#   * rc.1 and beta.1 got the SAME rank, so which sorted first was decided by the
#     order the manifest happened to list its keys in. Family first, then number:
#     alpha < beta < rc < final.
#   * a final release was core + 9999, which 0.2.0-rc.99999 outranks - a final
#     sorting below its own release candidate.
function Get-VersionRank {
  param([string]$Spec)
  $m = [regex]::Match($Spec, '^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$')
  if (-not $m.Success) { throw ("declared DSH release is not a version number: " + $Spec) }

  # 10 digits each for major/minor/patch; [long] normalises a leading zero.
  $core = '{0:D10}{1:D10}{2:D10}' -f [long]$m.Groups[1].Value, [long]$m.Groups[2].Value, [long]$m.Groups[3].Value
  $pre  = $m.Groups[4].Value

  # Final slot is 3, above every prerelease family, so 0.2.0 outranks 0.2.0-rc.N
  # for any N, however many digits N has.
  if (-not $pre) { return ($core + '3' + ('{0:D18}' -f [long]0)) }

  $pm = [regex]::Match($pre, '^([A-Za-z][A-Za-z.-]*?)\.?([0-9]+)$')
  if (-not $pm.Success) {
    Write-Host ("  note: " + $Spec + " has an unrecognised prerelease tag '" + $pre + "'; ranking it with alpha.0")
    return ($core + '0' + ('{0:D18}' -f [long]0))
  }
  $family = $pm.Groups[1].Value.ToLowerInvariant()

  # Family first, then number. An unrecognised family is ranked WITH alpha and
  # announced, rather than silently sharing a slot with one of the known three.
  $familySlot = '0'
  switch ($family) {
    'alpha' { $familySlot = '0' }
    'beta'  { $familySlot = '1' }
    'rc'    { $familySlot = '2' }
    default {
      Write-Host ("  note: " + $Spec + " has an unknown prerelease family '" + $family + "'; ranking it with alpha")
    }
  }
  return ($core + $familySlot + ('{0:D18}' -f [long]$pm.Groups[2].Value))
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
  # The runner reports through Write-Host, which this host does not put on the
  # output stream, so $out arrives empty - reading it answered "incomplete" for
  # every version whatever actually happened. The per-version summary.txt holds
  # the same lines, written by the same calls to disk, so that is what is read.
  #
  # run-one.ps1 clears that directory before anything that can throw, so a file
  # here was written by this run: a version that failed before booting leaves it
  # absent, and one that failed part-way leaves it short of the final line.
  $ok = $false
  $stage = 'never booted'
  $verdictFile = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'logs') ('log-' + $v + '\summary.txt')
  if (Test-Path -LiteralPath $verdictFile) {
    $ok = @(Select-String -LiteralPath $verdictFile -Pattern 'STAGE: all six steps done').Count -gt 0
    # "completed=false" on its own says a version failed but not where, and the six
    # stages differ so much that the report is close to useless without it. The last
    # STAGE line is the step reached, so read that instead of guessing from the logs.
    $stages = @(Select-String -LiteralPath $verdictFile -Pattern '^STAGE: (.+)$')
    if ($stages.Count) {
      $stage = $stages[$stages.Count - 1].Matches[0].Groups[1].Value.Trim()
    } else {
      $stage = 'no stage line recorded'
    }
  }
  $summary += [pscustomobject]@{
    version  = $v
    port     = $port
    completed = $ok
    stage    = $stage
    seconds  = [int]$sw.Elapsed.TotalSeconds
  }
  Write-Host ('---- ' + $v + ' completed=' + $ok + ' in ' + [int]$sw.Elapsed.TotalSeconds + 's')
}

Write-Host ''
Write-Host '################  MATRIX SUMMARY  ################'
foreach ($s in $summary) {
  Write-Host ('  {0,-12} port {1}  {2,-10} {3,5}s  {4}' -f $s.version, $s.port, $s.completed, $s.seconds, $s.stage)
}
Write-Host ('logs under        ' + (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'logs'))
Write-Host ('profiles left in  ' + (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'homes'))

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
# The table above dies with the console window. A compatibility claim outlives
# the run that produced it, so the run has to leave something behind that names
# what was tested and what came back, and a release note can quote it.
#
# What goes in it is read from this run, not from the working tree: the version
# from the manifest, the commit actually installed, and per version the verdict
# plus the last stage that was reached. A report that omitted the commit would
# still be quotable against a later build, which is the one thing a compatibility
# report must not be.

$passed = @($summary | Where-Object { $_.completed }).Count
$failed = @($summary | Where-Object { -not $_.completed }).Count
$verdict = if ($failed -eq 0) { 'PASS' } else { 'FAIL' }

$manifestPath = Join-Path $PSScriptRoot '..\..\package.json'
$pluginVersion = (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json).version
$commit = 'unknown'
try {
  $commit = (& git -C (Join-Path $PSScriptRoot '..\..') rev-parse --short HEAD 2>$null) -join ''
  if (-not $commit) { $commit = 'unknown' }
} catch {
  $commit = 'unknown'
}
$when = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss zzz')

if (-not $ReportPath) {
  $ReportPath = Join-Path (Join-Path ([System.IO.Path]::GetFullPath($RunRoot)) 'logs') 'matrix-report.md'
}
$reportDir = Split-Path -Parent ([System.IO.Path]::GetFullPath($ReportPath))
if (-not (Test-Path -LiteralPath $reportDir)) {
  New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
}

$lines = @()
$lines += ('# Compatibility matrix: ' + $pluginVersion)
$lines += ''
$lines += ('- Verdict: **' + $verdict + '** (' + $passed + ' passed, ' + $failed + ' failed)')
$lines += ('- Run at: ' + $when)
$lines += ('- Plugin version: ' + $pluginVersion)
$lines += ('- Commit: ' + $commit)
$lines += ('- Hosts root: ' + $HostsRoot)
$lines += ''
$lines += '| DSH release | Verdict | Last stage reached | Port | Seconds |'
$lines += '| --- | --- | --- | --- | --- |'
foreach ($s in $summary) {
  $mark = if ($s.completed) { 'pass' } else { 'FAIL' }
  # The stage is free text lifted from a log line; a pipe in it would break the row.
  $safeStage = $s.stage -replace '\|', '\|'
  $lines += ('| ' + $s.version + ' | ' + $mark + ' | ' + $safeStage + ' | ' + $s.port + ' | ' + $s.seconds + ' |')
}
$lines += ''
$lines += ('Total: ' + [int](($summary | Measure-Object -Property seconds -Sum).Sum) + 's across ' + $summary.Count + ' versions.')
if ($failed) {
  $lines += ''
  $lines += '## Failed versions'
  foreach ($s in $summary | Where-Object { -not $_.completed }) {
    $lines += ('- ' + $s.version + ': stopped at "' + $s.stage + '". Per-version log: `logs\log-' + $s.version + '\`.')
  }
}
$lines += ''
$lines += 'Profiles are left under `homes\` for inspection and removed by hand; nothing here deletes them.'

# Written through .NET rather than `Set-Content -Encoding utf8`, which emits a BOM
# on Windows PowerShell 5.1 and not on 7 - so the report this produces is readable
# by one of the two shells and not the other. PowerShell's own ConvertFrom-Json
# tolerates the BOM; node's JSON.parse does not, and the reason the json twin
# exists is a gate that decides without reading prose. Measured on 5.1: the
# Set-Content form starts EF BB BF and JSON.parse rejects it on the first token.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($ReportPath, [string[]]$lines, $utf8NoBom)
Write-Host ('report written to ' + $ReportPath)

if ($Json) {
  $jsonPath = [System.IO.Path]::ChangeExtension($ReportPath, '.json')
  $doc = [ordered]@{
    verdict        = $verdict
    pluginVersion  = $pluginVersion
    commit         = $commit
    runAt          = $when
    hostsRoot      = $HostsRoot
    portBase       = $PortBase
    passed         = $passed
    failed         = $failed
    versions       = @($summary | ForEach-Object {
      [ordered]@{
        version   = $_.version
        verdict   = $(if ($_.completed) { 'pass' } else { 'fail' })
        lastStage = $_.stage
        port      = $_.port
        seconds   = $_.seconds
      }
    })
  }
  [System.IO.File]::WriteAllText($jsonPath, [string]($doc | ConvertTo-Json -Depth 6), $utf8NoBom)
  Write-Host ('report written to ' + $jsonPath)
}

# A gate that cannot fail is not a gate. This driver used to end without an
# explicit exit, so a run where every single version failed still reported
# success to whatever was watching the exit code.
if ($failed) {
  Write-Host ('MATRIX FAILED: ' + $failed + ' of ' + $summary.Count + ' versions did not complete')
  exit 1
}
exit 0