param(
  [Parameter(Mandatory)][string]$Exe,
  [Parameter(Mandatory)][string[]]$Args,
  [Parameter(Mandatory)][string]$OutFile,
  [int]$TimeoutSec = 120,
  # This helper deletes one stale output file before writing. That deletion is
  # confined to one directory, and to .txt files inside it.
  [string]$AllowedRoot = (Join-Path $env:TEMP 'dsh-acceptance\run\logs')
)

# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI code page, which mangles non-ASCII and can eat a closing quote.
#
# Two fixes are baked in here:
#   1. $p.Handle is cached BEFORE waiting. Without it Start-Process -PassThru hands
#      back a Process whose ExitCode is never populated, so this helper used to
#      report an empty code for exit 0 and exit 3 alike - i.e. it produced no exit
#      code evidence at all, and the acceptance criteria are written in terms of
#      "exited 0".
#   2. The two output files it truncates are guarded before deletion, so a bad
#      OutFile cannot reach outside AllowedRoot.
#
# stderr is captured to a separate file rather than 2>&1 on purpose: under
# $ErrorActionPreference = 'Stop' a native command that writes to stderr makes
# 2>&1 raise a terminating error, which would abort the whole acceptance run on
# a benign DSH warning.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'stop-tree.ps1')

$root = [System.IO.Path]::GetFullPath($AllowedRoot)
$out  = [System.IO.Path]::GetFullPath($OutFile)
$err  = $out -replace '\.txt$', '.stderr.txt'

function Assert-OutputPath {
  param([string]$Path, [string]$Label)
  $full = [System.IO.Path]::GetFullPath($Path)
  if ($full -eq $root) { throw "REFUSED[$Label]: $full IS the allowed root" }
  if (-not $full.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "REFUSED[$Label]: $full is not under $root"
  }
  if (Test-Path -LiteralPath $full -PathType Container) {
    throw "REFUSED[$Label]: $full is a directory, not an output file"
  }
  if ($full -notmatch '\.txt$') { throw "REFUSED[$Label]: $full does not end in .txt" }
  return $full
}

if (-not (Test-Path -LiteralPath $root)) { New-Item -ItemType Directory -Path $root -Force | Out-Null }
$out = Assert-OutputPath -Path $out  -Label 'out'
$err = Assert-OutputPath -Path $err  -Label 'err'

foreach ($f in @($out, $err)) {
  if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force }
  $null = New-Item -ItemType File -Path $f -Force
}

$p = Start-Process -FilePath $Exe -ArgumentList $Args -NoNewWindow -PassThru `
       -RedirectStandardOutput $out -RedirectStandardError $err
$null = $p.Handle   # cache the handle so ExitCode is readable after the wait

if (-not $p.WaitForExit($TimeoutSec * 1000)) {
  # Windows PowerShell 5.1 runs on .NET Framework, which has ONLY Kill() - there
  # is no Process.Kill(bool entireProcessTree) overload. Calling $p.Kill($true)
  # raises MethodNotFoundException, and a try/catch around it swallows that, so
  # the process survives the timeout and keeps holding its port. Verified on this
  # machine: PSVersion 5.1.26100, CLR 4.0.30319, Kill() only.
  #
  # taskkill /T /F kills the tree on Windows. The kill is then VERIFIED, because
  # an unverified kill is the same silent failure as a swallowed error.
  #
  # The kill itself goes through Stop-ProcessTree. This line used to be
  # `$tree = & taskkill /PID $p.Id /T /F 2>&1`, which is the very trap the header
  # comment warns about, reached through taskkill: under $ErrorActionPreference =
  # 'Stop' the "not found" taskkill writes to stderr became a terminating error,
  # so the timeout branch - the one that exists precisely because the process
  # misbehaved - could abort the whole run instead of returning -1.
  $kill = Stop-ProcessTree -ProcessId $p.Id -Process $p -Label ($Exe + ' (timeout)') -WaitMs 15000
  if (-not $kill.stopped) {
    Write-Host ("KILL-FAILED after {0}s timeout; pid {1} is still alive" -f $TimeoutSec, $p.Id)
    Write-Host $kill.output
    return @{ code = -2; timedOut = $true; killFailed = $true; out = $out; err = $err }
  }
  Write-Host ("TIMEOUT after {0}s; process tree killed" -f $TimeoutSec)
  return @{ code = -1; timedOut = $true; killFailed = $false; out = $out; err = $err }
}

$code = $p.ExitCode
Write-Host ("exitcode: {0}" -f $code)
Write-Host "timedOut: false"
return @{ code = $code; timedOut = $false; killFailed = $false; out = $out; err = $err }
