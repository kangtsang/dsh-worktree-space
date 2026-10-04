<#
.SYNOPSIS
  Build, install and serve this plugin for a hand-driven acceptance run.

.DESCRIPTION
  One command that gets a browser to a working instance of the current working
  tree: pack the tarball, install it into a throwaway profile, boot a web
  instance on a free port, and hold it open until the timeout or Ctrl-C.

  It stops at the page. Nothing here decides whether a feature works - that is
  what the human at the browser is for. What it removes is the four things that
  are retyped every time: which tarball, which DSH build, which port, and the
  cleanup of the last run's home.

  This is deliberately NOT scripts/acceptance/ in the code repository. Those
  scripts produce the release matrix in docs/store-evidence.md: they install
  every declared DSH version, run six phases unattended, and their output is
  evidence. This one is a loop for one person and one browser, and its output is
  a running process. Merging them would make the matrix script carry a
  hold-open-until-timeout loop it has no use for.

.PARAMETER CaseRoot
  The acceptance root. Everything this script creates lives under it: the DSH
  home, the logs, the fixture repositories and the task container. Wiped and
  rebuilt on every run, so a run never inherits the previous run's state.

.PARAMETER Port
  Port to serve on. Must be free; the script refuses rather than picking another,
  because the URL has to be written down to be checked later. Never use 3080 -
  that is the desktop instance's default and holding it makes webserver
  activation fail.

.PARAMETER DshVersion
  Which installed DSH to serve. Must already be installed by
  scripts/acceptance/install-hosts.ps1.

.PARAMETER SkipPack
  Reuse the tarball already in the case root instead of building a new one. For
  driving the page when only the profile config changed.

.PARAMETER FixtureRepos
  How many git repositories the fixture source root holds. More than one is what
  makes a task space show its per-repository worktrees side by side.

.PARAMETER PluginRepo
  The repository to pack. It is not this script's own directory - npm pack reads
  package.json from the working directory, so without this the pack would look
  for one next to this script and fail with ENOENT.

.PARAMETER HoldSeconds
  How long to keep serving after the URL is printed. Ctrl-C ends it sooner.

.EXAMPLE
  .\start-acceptance.ps1 -Port 34822

.EXAMPLE
  .\start-acceptance.ps1 -Port 34822 -SkipPack -HoldSeconds 7200

.NOTES
  ASCII-only body on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as
  the system ANSI code page, which mangles non-ASCII and eats the closing quote,
  producing a parser error far from the real cause.
#>
[CmdletBinding()]
param(
  [string]$CaseRoot = 'D:\dsh-acceptance\case',
  [string]$DshVersion = '0.2.0-rc.2',
  [string]$HostsRoot = 'D:\dsh-acceptance\hosts',
  [int]$Port = 34822,
  [int]$HoldSeconds = 3600,
  [switch]$SkipPack,
  [switch]$SkipBuildCheck,
  [int]$FixtureRepos = 2,
  [string]$PluginRepo = 'E:\workspace\public\dsh-worktree-space'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0

# ---------------------------------------------------------------------------
# Delete guard.
#
# There is exactly one recursive delete in this script: the previous run's DSH
# home, under the case root. Everything else is created, never removed. The
# checks below are the reason it is safe - the repository once lost a user
# directory to an unguarded Remove-Item, and $home being a read-only automatic
# variable meant the path was never what it looked like.
# ---------------------------------------------------------------------------

function Assert-SafeDelete {
  <#
    Refuses anything that is not a named direct child of a named root and has
    no reparse point on the way. Remove-Item -Recurse follows junctions on
    Windows, so a link under the root can redirect the delete anywhere on the
    disk; the walk is what stops that.
  #>
  param([string]$Path, [string]$MustBeUnder, [string]$ExpectLeaf, [string]$Label)

  $full = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetFullPath($MustBeUnder)
  if ($full -eq $root) { throw ("REFUSED[{0}]: path IS the root" -f $Label) }
  if (-not $full.StartsWith($root.TrimEnd('\') + '\')) {
    throw ("REFUSED[{0}]: {1} is not under {2}" -f $Label, $full, $root)
  }
  if ((Split-Path $full -Parent) -ne $root) {
    throw ("REFUSED[{0}]: {1} is not a direct child of {2}" -f $Label, $full, $root)
  }
  if ((Split-Path $full -Leaf) -ne $ExpectLeaf) {
    throw ("REFUSED[{0}]: leaf is not '{1}'" -f $Label, $ExpectLeaf)
  }

  $cur = $full
  while ($cur.Length -ge $root.Length) {
    $item = Get-Item -LiteralPath $cur -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw ("REFUSED[{0}]: reparse point at {1}" -f $Label, $cur)
    }
    if ($cur -eq $root) { break }
    $cur = Split-Path $cur -Parent
  }
  return $full
}

function Invoke-Checked {
  <#
    Runs a native command, fails loudly, and never truncates its output.

    Under $ErrorActionPreference = 'Stop' a native command writing to stderr
    makes 2>&1 raise a TERMINATING error, so one benign warning would abort a
    run whose real error never got printed. Redirect to a file instead: no
    2>&1, no pipeline, the text is on disk either way.
  #>
  param([string]$Exe, [string[]]$CmdArgs, [string]$What, [string]$CaptureTo, [string]$WorkingDir)

  $outFile = if ($CaptureTo) { $CaptureTo } else { Join-Path $logDir ($What + '.txt') }
  $errFile = [System.IO.Path]::ChangeExtension($outFile, '.stderr.txt')
  # Start-Process takes a working directory rather than inheriting one, so a
  # command that reads package.json from the CWD has to be told where it is.
  # Passing '' is not the same as passing nothing - it resolves against the
  # process CWD and can fail - so the argument is only supplied when there is
  # somewhere to run it in.
  $start = @{
    FilePath = $Exe
    ArgumentList = $CmdArgs
    NoNewWindow = $true
    PassThru = $true
    Wait = $true
    RedirectStandardOutput = $outFile
    RedirectStandardError = $errFile
  }
  if ($WorkingDir) { $start['WorkingDirectory'] = $WorkingDir }
  $p = Start-Process @start
  if ($p.ExitCode -ne 0) {
    $err = ''
    if (Test-Path -LiteralPath $errFile) { $err = (Get-Content -LiteralPath $errFile -Raw) }
    if ([string]::IsNullOrWhiteSpace($err)) { $err = '(no stderr)' }
    throw ("{0} failed with exit {1}: {2}" -f $What, $p.ExitCode, (($err -replace '\s+', ' ').Trim()))
  }
  return $outFile
}

function Assert-BundleIsCurrent {
  <#
    Refuses to pack a bundle that is older than the source it was built from.

    This script does not build. It packs whatever is sitting in lib\ and client\,
    which is a trap this repository has now walked into three times: edit a source
    file, run this, and the page serves the previous build. Nothing in the result
    says so. A stale bundle and a fresh one are identical by every signal a
    browser or a timestamp on the installed package can give - npm restamps
    package.json at install time, so even "when was it installed" answers the
    wrong question. The only thing that distinguishes them is comparing the bundle
    against the source it came from, which is what this does.

    Failing is the useful outcome. A run that stops here costs a keystroke; a run
    that serves the old bundle costs an afternoon of debugging a fix that is
    already in the working tree and already correct.

    Not a guard against anything destructive - it reads timestamps and throws.
  #>
  param([string]$RepoPath)

  $bundles = @('lib\index.js', 'client\client.js')
  $bundleTimes = @()
  foreach ($relative in $bundles) {
    $full = Join-Path $RepoPath $relative
    if (-not (Test-Path -LiteralPath $full)) {
      throw ("{0} has no {1}. Run the build (node build.mjs) before accepting." -f $RepoPath, $relative)
    }
    $bundleTimes += (Get-Item -LiteralPath $full).LastWriteTime
  }
  $built = ($bundleTimes | Sort-Object -Descending | Select-Object -First 1)

  # src\ holds everything the host is built from; client\ holds everything the
  # bundle is built from except the bundle. node_modules is never walked: it is not
  # source, it is large, and recursing into it is its own kind of slow.
  $newest = [datetime]::MinValue
  $newestPath = ''
  foreach ($dir in @('src', 'client')) {
    $full = Join-Path $RepoPath $dir
    if (-not (Test-Path -LiteralPath $full)) { continue }
    foreach ($item in (Get-ChildItem -LiteralPath $full -Recurse -File)) {
      if ($item.FullName -eq (Join-Path $RepoPath 'client\client.js')) { continue }
      if ($item.LastWriteTime -gt $newest) {
        $newest = $item.LastWriteTime
        $newestPath = $item.FullName
      }
    }
  }

  if ($newest -gt $built) {
    throw (@"
The bundle is older than the source it was built from, so packing now would serve the previous build:
  newest source : {0}  ({1})
  built at      : {2}

That is the trap this check exists for: the page would look entirely normal and
serve yesterday's code. Build first:

  node build.mjs

If the source edit is deliberately not part of this run, pass -SkipBuildCheck.
"@ -f $newestPath, $newest.ToString('yyyy-MM-dd HH:mm:ss'), $built.ToString('yyyy-MM-dd HH:mm:ss'))
  }
  Write-Host ('bundle   : current (built ' + $built.ToString('yyyy-MM-dd HH:mm:ss') + ')')
}

function Wait-ForUrl {
  <#
    Boots dsh in the background and returns the url it printed.

    Printing a url IS the proof the webserver plugin activated - the plugin
    binds the port and only then logs where to reach it - so waiting for that
    line is the readiness signal, and there is nothing better to poll.
  #>
  param([string[]]$DshArgs, [string]$OutFile, [string]$ErrFile, [int]$TimeoutSec, [string]$What)

  $proc = Start-Process -FilePath 'node' -ArgumentList $DshArgs -NoNewWindow -PassThru `
            -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile
  # Holding the handle keeps the process object alive so HasExited stays useful.
  $null = $proc.Handle

  $url = $null
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline -and -not $url) {
    if ($proc.HasExited) { break }
    if (Test-Path -LiteralPath $OutFile) {
      $txt = Get-Content -LiteralPath $OutFile -Raw
      if (-not [string]::IsNullOrEmpty($txt)) {
        $m = [regex]::Match($txt, 'http://[^\s]+')
        if ($m.Success) { $url = $m.Value }
      }
    }
    if (-not $url) { Start-Sleep -Milliseconds 800 }
  }

  if (-not $url) {
    $raw = ''
    if (Test-Path -LiteralPath $OutFile) { $raw = Get-Content -LiteralPath $OutFile -Raw }
    $err = ''
    if (Test-Path -LiteralPath $ErrFile) { $err = Get-Content -LiteralPath $ErrFile -Raw }
    $null = & taskkill /PID $proc.Id /T /F 2>&1
    if (-not [string]::IsNullOrEmpty($raw)) {
      Write-Host ("{0} output: " -f $What)
      Write-Host ("  " + (($raw -replace '\s+', ' ').Trim()))
    }
    if (-not [string]::IsNullOrEmpty($err)) {
      Write-Host ("{0} stderr: " -f $What)
      Write-Host ("  " + (($err -replace '\s+', ' ').Trim()))
    }
    throw ("{0} never printed a url within {1}s" -f $What, $TimeoutSec)
  }

  return @{ Url = $url; Process = $proc }
}

# ---------------------------------------------------------------------------

$caseRoot = [System.IO.Path]::GetFullPath($CaseRoot)
$dshHome = Join-Path $caseRoot 'home'
$logDir = Join-Path $caseRoot 'log'
$pluginRoot = Join-Path $caseRoot 'fixture'
$binJs = Join-Path $HostsRoot ($DshVersion + '\node_modules\@deepseek-ai\dsh\lib\bin.js')
$repo = [System.IO.Path]::GetFullPath($PluginRepo)
$tarball = Join-Path $caseRoot 'dsh-worktree-space-under-test.tgz'
$profileName = 'accept'

if ($Port -eq 3080) { throw 'REFUSED: 3080 is the desktop instance default; pick another port' }
if (-not (Test-Path -LiteralPath (Join-Path $repo 'package.json'))) {
  throw ("no package.json under {0} - point -PluginRepo at the plugin repository" -f $repo)
}
if (-not (Test-Path -LiteralPath $binJs)) {
  throw ("no DSH build at {0} - run scripts/acceptance/install-hosts.ps1 first" -f $binJs)
}

# The port is checked before anything is created or removed, not merely before the
# server starts. This run used to check it after the home wipe, so a port still held
# by the previous run's server was discovered only once the profile it was serving
# from had been deleted - leaving a live server whose every plugin 404s, which looks
# like a working page because the page itself still answers. Failing here costs a
# keystroke; failing there costs the environment the last good run was using.
#
# The PID is named because the process holding the port is usually a server this
# script started and nobody stopped. Nothing has been touched when this throws, so
# killing that PID by hand and starting again is safe.
$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  $holders = (($busy | Select-Object -ExpandProperty OwningProcess) -join ',')
  throw ("REFUSED: port {0} is in use by PID {1}. Nothing was changed - stop that process (it is usually the previous run's server) and start again." -f $Port, $holders)
}

foreach ($d in @($caseRoot, $logDir, $pluginRoot)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# --- pack ------------------------------------------------------------------

if ($SkipPack -and (Test-Path -LiteralPath $tarball)) {
  Write-Host ('tarball  : reusing ' + $tarball)
} else {
  # Before the pack, not after: `npm pack` reads lib\ as it is, so a check placed
  # afterwards would be reporting on a tarball that is already wrong.
  if (-not $SkipBuildCheck) { Assert-BundleIsCurrent -RepoPath $PluginRepo }
  Write-Host 'tarball  : packing'
  # `npm pack`, not `pnpm pack`: pnpm exits 0 with no tarball when its own store
  # is in a state it does not want to write to, and the failure surfaces later
  # as a confusing install error rather than as a pack error.
  $null = Invoke-Checked -Exe 'npm.cmd' -CmdArgs @('pack', '--pack-destination', $caseRoot) `
            -What 'npm-pack' -CaptureTo (Join-Path $logDir 'pack.txt') -WorkingDir $repo
  $packed = Get-ChildItem -LiteralPath $caseRoot -Filter '*.tgz' |
              Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $packed) { throw "npm pack produced no tarball in $caseRoot" }
  if ($packed.Name -ne (Split-Path $tarball -Leaf)) {
    $tarball = $packed.FullName
  }
  Write-Host ('           ' + (Split-Path $tarball -Leaf))
}

# --- reset the previous run -----------------------------------------------
#
# The one delete. A home left over from an aborted run holds a booted server's
# own files open and cannot be removed, so its stray node processes are killed
# first - by PID, scoped to this case root, never by image name.

$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and $_.CommandLine -like ('*' + $caseRoot + '*') }
foreach ($s in $stray) { $null = & taskkill /PID $s.ProcessId /T /F 2>&1 }
if ($stray) { Start-Sleep -Seconds 2 }

$safeHome = Assert-SafeDelete -Path $dshHome -MustBeUnder $caseRoot -ExpectLeaf 'home' -Label 'dshHome'
if (Test-Path -LiteralPath $safeHome) { Remove-Item -LiteralPath $safeHome -Recurse -Force }
New-Item -ItemType Directory -Path $safeHome | Out-Null

$env:DSH_HOME = $safeHome
if ([System.IO.Path]::GetFullPath($env:DSH_HOME) -eq [Environment]::GetFolderPath('UserProfile')) {
  throw 'REFUSED: DSH_HOME resolved to the user profile'
}

# The fixture repositories sit beside the home, not inside it, so the home wipe
# cannot reach them - and the container root is derived from them.
$fixtureRoot = Join-Path $pluginRoot 'source'
if (-not (Test-Path -LiteralPath $fixtureRoot)) { New-Item -ItemType Directory -Path $fixtureRoot -Force | Out-Null }

Write-Host ('DSH_HOME : ' + $safeHome)
Write-Host ('dsh      : ' + $DshVersion)
Write-Host ('tarball  : ' + $tarball)

# --- profile ---------------------------------------------------------------
#
# --from-default-profile verifies the new profile by BOOTING it, and a booted
# web server waits for a browser forever - so this one step cannot go through a
# bounded runner. It is started in the background, waited for until it prints a
# url, then killed. The url is the proof the webserver plugin activated.
#
# --port is the same port this run will serve on, and it is free by now: the
# verification boot would otherwise try 3080, which a desktop instance holds,
# and fail with "2 required plugins did not activate".

$profDir = Join-Path $safeHome ('profiles\' + $profileName)
if (Test-Path -LiteralPath (Join-Path $profDir 'package.json')) {
  Write-Host ('profile  : reusing ' + $profileName)
} else {
  Write-Host ('profile  : creating ' + $profileName)
  $mk = Wait-ForUrl `
    -DshArgs @($binJs, '--profile', $profileName, '--from-default-profile', 'web', '--no-open', '--port', "$Port") `
    -OutFile (Join-Path $logDir '01-profile.txt') `
    -ErrFile (Join-Path $logDir '01-profile.stderr.txt') `
    -TimeoutSec 180 -What 'profile boot'
  $null = & taskkill /PID $mk.Process.Id /T /F 2>&1
  $null = $mk.Process.WaitForExit(15000)
}

# --- install ---------------------------------------------------------------
#
# `dsh plugin --profile X add <tarball>`, NOT `pnpm add`. DSH loads only what
# the profile's `dsh.profile.bundles` array names; pnpm add puts the package in
# node_modules and writes nothing there, so the profile boots without the plugin
# and the run looks like a broken feature.

$profPkgPath = Join-Path $profDir 'package.json'
$pkgPath = Join-Path $profDir 'node_modules\dsh-worktree-space\package.json'
$listed = $false
if (Test-Path -LiteralPath $profPkgPath) {
  $listed = @((Get-Content -LiteralPath $profPkgPath -Raw | ConvertFrom-Json).dsh.profile.bundles) -contains 'dsh-worktree-space'
}
if ($listed -and (Test-Path -LiteralPath $pkgPath)) {
  Write-Host ('install  : already present')
} else {
  $null = Invoke-Checked -Exe 'node' `
    -CmdArgs @($binJs, 'plugin', '--profile', $profileName, 'add', $tarball) `
    -What 'plugin-add' -CaptureTo (Join-Path $logDir '02-add.txt')
  if (-not (Test-Path -LiteralPath $pkgPath)) { throw 'plugin add reported success but nothing landed in node_modules' }
  Write-Host ('install  : ' + (Get-Content -LiteralPath $pkgPath -Raw | ConvertFrom-Json).version)
}

$bundles = @((Get-Content -LiteralPath $profPkgPath -Raw | ConvertFrom-Json).dsh.profile.bundles)
if ($bundles -notcontains 'dsh-worktree-space') {
  throw ("profile does not list the plugin in bundles: " + ($bundles -join ', '))
}

# --- fixture ---------------------------------------------------------------
#
# Real repositories, because task.create runs git against them. One is enough to
# prove the flow; two make a task space show its worktrees side by side, which is
# how a per-repository bug shows up.

$repos = @()
for ($i = 1; $i -le $FixtureRepos; $i++) {
  $r = Join-Path $fixtureRoot ('repo-' + $i)
  if (-not (Test-Path -LiteralPath (Join-Path $r '.git'))) {
    New-Item -ItemType Directory -Path $r -Force | Out-Null
    $g = @('-C', $r, '-c', 'user.email=accept@example.invalid', '-c', 'user.name=Accept',
           '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false')
    $null = & git @g init --quiet 2>&1
    Set-Content -LiteralPath (Join-Path $r 'README.md') -Value ('fixture repository ' + $i) -Encoding ASCII
    $null = & git @g add README.md 2>&1
    $null = & git @g commit --quiet -m 'fixture' 2>&1
    # A second branch, so a task's own branch is visibly distinct from the
    # source's and picking a base that is not HEAD is possible.
    $null = & git @g branch feature-x 2>&1
  }
  $repos += $r
}
Write-Host ('fixture  : ' + $repos.Count + ' repositories under ' + $fixtureRoot)

# --- serve -----------------------------------------------------------------

$boot = Wait-ForUrl `
  -DshArgs @($binJs, '--profile', $profileName, '--no-open', '--port', "$Port") `
  -OutFile (Join-Path $logDir 'boot.txt') `
  -ErrFile (Join-Path $logDir 'boot.stderr.txt') `
  -TimeoutSec 180 -What 'server boot'

# Where the plugin will put the task container, worked out the way it works it
# out: the source root's own first directory below its volume root, plus
# "worktree-space". See firstDirectoryBelowRoot in src/host/task/paths.js - the
# parent is that directory so the container shares a real prefix with the source
# tree without either being widened to the volume root.
#
# Note where this lands. For a case root of D:\dsh-acceptance\case the container
# goes to D:\dsh-acceptance\worktree-space - ONE LEVEL ABOVE the case root, and
# therefore outside everything the home wipe reaches. A stale container from an
# earlier run therefore survives the reset, and the next create finds its
# branch already taken. That is what happened once and it looks like a broken
# plugin rather than a stale directory.
#
# The fixture is placed one level deeper on purpose so the container root is a
# sibling of the case root rather than the case root itself: a container root
# equal to the case root would put the log next to case.env, and one above it
# would escape the disk this whole run is confined to.
$volumeRoot = [System.IO.Path]::GetPathRoot($fixtureRoot)
$firstBelow = (Split-Path $fixtureRoot -Parent) -replace [regex]::Escape($volumeRoot), ''
$firstBelow = $firstBelow.Split('\')[0]
$containerRoot = if ($firstBelow) { Join-Path ($volumeRoot + $firstBelow) 'worktree-space' } else { Join-Path $pluginRoot 'worktree-space' }
$containerOutside = -not ([System.IO.Path]::GetFullPath($containerRoot)).StartsWith($caseRoot.TrimEnd('\') + '\')

Set-Content -LiteralPath (Join-Path $caseRoot 'case.env') -Encoding ASCII -Value @(
  "DSH_HOME=$safeHome"
  "FIXTURE=$fixtureRoot"
  "REPOS=$($repos -join ';')"
  "CONTAINER_ROOT=$containerRoot"
  "AUDIT_LOG=$(Join-Path $containerRoot 'worktree-space-log.jsonl')"
  "PORT=$Port"
  "URL=$($boot.Url)"
  "PID=$($boot.Process.Id)"
  "LOGS=$logDir"
)

Write-Host ''
Write-Host ('  URL      : ' + $boot.Url)
Write-Host ('  DSH_HOME : ' + $safeHome)
Write-Host ('  fixture  : ' + $fixtureRoot)
Write-Host ('  log file : ' + (Join-Path $containerRoot 'worktree-space-log.jsonl'))
Write-Host ('  case.env : ' + (Join-Path $caseRoot 'case.env'))
if ($containerOutside) {
  Write-Host ''
  Write-Host '  NOTE: the container root is ABOVE the case root, so this run''s reset'
  Write-Host '        does not clear it. A leftover from an earlier run keeps its'
  Write-Host '        branches, and a create on one of those names fails on the branch.'
  Write-Host '        Remove it by hand if a run before this one left one behind:'
  Write-Host ('          ' + $containerRoot)
}
Write-Host ''
Write-Host ('  Serving for ' + $HoldSeconds + 's. Drive the page, then Ctrl-C or wait.')
Write-Host ''

$hold = (Get-Date).AddSeconds($HoldSeconds)
try {
  while ((Get-Date) -lt $hold) {
    Start-Sleep -Seconds 5
    if ($boot.Process.HasExited) {
      Write-Host ('server exited on its own with code ' + $boot.Process.ExitCode)
      Write-Host ('  see ' + (Join-Path $logDir 'boot.txt') + ' and boot.stderr.txt')
      $hold = Get-Date
    }
  }
}
finally {
  if (-not $boot.Process.HasExited) {
    $null = & taskkill /PID $boot.Process.Id /T /F 2>&1
    $null = $boot.Process.WaitForExit(15000)
  }
  Write-Host ('server stopped: ' + $boot.Process.HasExited)
  Write-Host ('logs kept at ' + $logDir)
}
