# One bounded kill for every process these acceptance scripts have to stop.
#
# DOT-SOURCE it; it defines one function and deliberately does nothing else:
#
#   . (Join-Path $PSScriptRoot 'stop-tree.ps1')
#
# Why a helper at all. With $ErrorActionPreference = 'Stop', calling a native
# command with 2>&1 raises a TERMINATING error the moment that command writes to
# stderr. `taskkill /PID <pid>` against an already dead pid ALWAYS writes
# "ERROR: The process with PID ... could not be terminated." to stderr, so the
# cleanup threw exactly when it was needed most, and it threw BEFORE the useful
# output was printed:
#   * start-acceptance.ps1 killed the process after a dsh boot that never printed
#     a url - the single most common failure - so the boot output and stderr
#     printed just below the taskkill were swallowed on every such failure.
#   * run-one.ps1 had the server kill at the end of the probe block with no outer
#     catch, so the same throw skipped it entirely: the booted server survived
#     holding its port, and stages 5 and 6 produced no evidence.
# That is the same trap invoke-bounded.ps1 exists to keep out of the dsh calls,
# reached again one layer down through taskkill.
#
# Two rules this function keeps, and both of them are load-bearing:
#   1. stderr goes to a FILE. There is no 2>&1 anywhere on the path, so no native
#      stderr line can become a terminating error on either 5.1 or 7.
#   2. "already gone" is swallowed ON PURPOSE and reported as alreadyGone, and the
#      kill is VERIFIED afterwards. An unverified kill is the same silent failure
#      as a swallowed error: the process keeps the port, which is the entire
#      reason this function exists.
#
# taskkill /T /F, never $Process.Kill($true): Windows PowerShell 5.1 runs on .NET
# Framework, which has ONLY Kill(); there is no Kill(bool entireProcessTree)
# overload. A try/catch around it swallows the MethodNotFoundException and the
# process survives the timeout still holding its port.
#
# The two taskkill transcript files are written under %TEMP% and left there on
# purpose. Deleting them would put a Remove-Item into three scripts that have none
# today, and two short files per killed PID is not worth new delete surface in a
# folder where an unguarded Remove-Item once cost a user their home directory.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the
# system ANSI code page, which mangles non-ASCII and can eat a closing quote.

function Stop-ProcessTree {
  param(
    [Parameter(Mandatory)][int]$ProcessId,
    # Optional System.Diagnostics.Process, for the callers that started the
    # process themselves. Verification then uses the handle rather than re-reading
    # the PID, which is exact instead of best-effort.
    $Process,
    [string]$Label = 'process',
    [int]$WaitMs = 15000
  )

  $result = @{ processId = $ProcessId; label = $Label; stopped = $false; alreadyGone = $false; output = '' }

  if ($ProcessId -le 0) {
    $result.alreadyGone = $true
    $result.stopped     = $true
    return $result
  }

  # Decide "is it still running" BEFORE calling taskkill. On every failure path
  # here the process has usually exited on its own and the cleanup runs anyway,
  # so this is the common case - and it is precisely the one taskkill turns into
  # a terminating error. Checked explicitly rather than caught.
  $alive = @(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue).Count -gt 0
  if ($Process) {
    try { $alive = -not $Process.HasExited } catch { }
  }
  if (-not $alive) {
    $result.alreadyGone = $true
    $result.stopped     = $true
    return $result
  }

  $stem    = [IO.Path]::Combine([IO.Path]::GetTempPath(), ('dsh-acceptance-kill-' + $ProcessId))
  $outFile = $stem + '.txt'
  $errFile = $stem + '.stderr.txt'
  try {
    # Start-Process with a redirected stderr, not `& taskkill ... 2>&1`. The
    # redirection is the whole fix; the file is only read back as evidence.
    $null = Start-Process -FilePath 'taskkill.exe' `
              -ArgumentList @('/PID', $ProcessId, '/T', '/F') `
              -NoNewWindow -Wait -PassThru `
              -RedirectStandardOutput $outFile -RedirectStandardError $errFile
  } catch {
    $result.output = 'taskkill could not be started: ' + $_.Exception.Message
    return $result
  }

  $lines = @()
  foreach ($f in @($outFile, $errFile)) {
    if (Test-Path -LiteralPath $f) {
      $t = Get-Content -LiteralPath $f -Raw -ErrorAction SilentlyContinue
      if ($null -ne $t -and $t.Length -gt 0) { $lines += $t.Trim() }
    }
  }
  $result.output = $lines -join ' | '

  # VERIFY. The handle is exact when the caller passed the process object; the PID
  # poll is the fallback for a process this script did not start.
  $gone = $false
  if ($Process) {
    try { $null = $Process.WaitForExit($WaitMs); $gone = $Process.HasExited } catch { $gone = $false }
  }
  if (-not $gone) {
    $until = (Get-Date).AddMilliseconds($WaitMs)
    while ((Get-Date) -lt $until) {
      if (@(Get-Process -Id $ProcessId -ErrorAction SilentlyContinue).Count -eq 0) { $gone = $true; break }
      Start-Sleep -Milliseconds 250
    }
  }
  $result.stopped = $gone
  return $result
}