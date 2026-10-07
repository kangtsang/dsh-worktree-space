param(
  # One acceptance root for every plugin repository on this machine. The hosts
  # live directly under it and are SHARED by every project and by both entry
  # points (the matrix and the hand-driven instance): they are 1.8 GB of DSH
  # builds, and installing a second copy per project is what produced two
  # identical hosts roots on this machine.
  #
  # $ProjectName is the repository directory's own name, which is also the name
  # the plugin uses for the project layer inside the task container. Deriving it
  # rather than hardcoding it is what lets the same script serve any plugin repo.
  #
  # These defaults used to point at $env:TEMP, while start-acceptance.ps1 pointed
  # at D:\dsh-acceptance. Two defaults for one thing is how a second full DSH
  # install appears without anyone deciding to make one.
  [string]$AcceptanceRoot = 'D:\dsh-acceptance',
  [string]$ProjectName = (Split-Path (Join-Path $PSScriptRoot '..\..') -Leaf),
  [string]$HostsRoot = (Join-Path $AcceptanceRoot 'hosts')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stop-tree.ps1')

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
# dshReleases is an OBJECT (version -> verdict), not an array. @($obj) wraps it in a
# one-element array, and interpolating that yields the whole object, so the install
# line reads "@deepseek-ai/dsh@@{0.1.7-rc.1=compatible; ...}". Take the keys.
$versions = @($manifest.dsh.compatibility.dshReleases.PSObject.Properties.Name)
if (-not $versions.Count) { throw 'manifest declares no dshReleases' }
Write-Host ('declared releases: ' + ($versions -join ', '))

$hostsRoot = [System.IO.Path]::GetFullPath($HostsRoot)
if (-not (Test-Path -LiteralPath $hostsRoot)) {
  New-Item -ItemType Directory -Path $hostsRoot -Force | Out-Null
}

$logDir = Join-Path $hostsRoot '_install-logs'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

$failed = @()
foreach ($v in $versions) {
  $prefix = Join-Path $hostsRoot $v
  $exe    = Join-Path $prefix 'node_modules\.bin\dsh.cmd'
  if (Test-Path -LiteralPath $exe) {
    Write-Host ('    already present: ' + $v)
    continue
  }
  Write-Host ('=== installing @deepseek-ai/dsh@' + $v + ' ===')
  $sw = [Diagnostics.Stopwatch]::StartNew()

  # Do NOT use `& npm ... 2>&1` here. Under $ErrorActionPreference = 'Stop' a
  # native command that writes to stderr raises a TERMINATING error, so one npm
  # warning would abort the whole install sweep before the remaining versions were
  # attempted. Redirect to files and read the exit code instead. This is the same
  # trap invoke-bounded.ps1 exists to avoid; reintroducing it here is what this
  # comment is for.
  $o = Join-Path $logDir ("$v.out.txt")
  $e = Join-Path $logDir ("$v.err.txt")
  $p = Start-Process -FilePath 'npm.cmd' -NoNewWindow -PassThru `
            -ArgumentList @('install', '--prefix', $prefix, '--no-save', '--loglevel=error', "@deepseek-ai/dsh@$v") `
            -RedirectStandardOutput $o -RedirectStandardError $e
  $null = $p.Handle

  # WaitForExit(timeout) returns FALSE on timeout and does NOT throw, so the
  # result used to be discarded and $p.ExitCode read afterwards came back empty:
  # the report said "FAILED exit=" with no code at all, and the npm install tree
  # kept running in the background. When that leaked tree finally finished it
  # dropped .bin\dsh.cmd into place, and the NEXT run of this script found the
  # file and reported "already present" - a half-installed or bad version reading
  # as a good one, which is the outcome this whole script exists to prevent.
  # Handled the way invoke-bounded.ps1 handles it: kill the tree, then re-check.
  $waited = $p.WaitForExit(900000)
  $sw.Stop()

  if (-not $waited) {
    $kill = Stop-ProcessTree -ProcessId $p.Id -Process $p -Label ('npm install ' + $v) -WaitMs 15000
    $failed += $v
    Write-Host ('    FAILED timeout=900s; process tree ' + $(if ($kill.stopped) { 'killed' } else { 'STILL RUNNING, pid ' + $p.Id }))
    if (Test-Path -LiteralPath $exe) {
      # Said out loud, because this is the trap: a partial install can leave a
      # usable-looking .bin\dsh.cmd behind and the next run would call it present.
      # This script has no Remove-Item, by design, so the prefix has to go by hand.
      Write-Host ('    WARNING: ' + $exe + ' exists after a killed install.')
      Write-Host ('             Remove ' + $prefix + ' by hand and re-run, or the next')
      Write-Host ('             run will report this version as already present.')
    }
    if ($kill.output) { Write-Host ('      ' + $kill.output) }
    foreach ($f in @($e, $o)) {
      if (Test-Path -LiteralPath $f) {
        @(Get-Content -LiteralPath $f -TotalCount 6) | ForEach-Object { Write-Host ('      ' + $_) }
      }
    }
    continue
  }

  $code = $p.ExitCode

  if ($code -ne 0) {
    $failed += $v
    Write-Host ('    FAILED exit=' + $code + '   logs: ' + $o)
    foreach ($f in @($e, $o)) {
      if (Test-Path -LiteralPath $f) {
        @(Get-Content -LiteralPath $f -TotalCount 6) | ForEach-Object { Write-Host ('      ' + $_) }
      }
    }
    continue
  }
  $reported = if (Test-Path -LiteralPath $exe) { ((& $exe --version) -join '') } else { 'no .bin\dsh.cmd' }
  Write-Host ('    OK  {0:n1}s  reported: {1}' -f $sw.Elapsed.TotalSeconds, $reported)
}

Write-Host ('hosts root: ' + $hostsRoot)
if ($failed.Count) {
  Write-Host ('FAILED for: ' + ($failed -join ', '))
  exit 1
}