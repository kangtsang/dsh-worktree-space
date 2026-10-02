param(
  [Parameter(Mandatory)][string]$v,
  # Where the DSH builds live: <HostsRoot>\<version>\node_modules\@deepseek-ai\dsh\lib\bin.js
  [string]$HostsRoot = (Join-Path $env:TEMP 'dsh-acceptance\hosts'),
  # The run area. Every disposable path below is inside it and nowhere else.
  [string]$RunRoot   = (Join-Path $env:TEMP 'dsh-acceptance\run'),
  # The tarball under test. Defaults to the file install-tarball.ps1 produced.
  [string]$Tarball,
  # A fixed port, never the host's default 3080 (which collides with a running
  # app) and never 0 (which hides the port from the evidence record).
  [int]$Port = 34800,
  # Seconds to keep the server up after arming the rollback probe, so the create
  # dialog can be driven in a browser while the probe samples. 0 tears down at
  # once, which is what a matrix run wants: it has no page to drive.
  [int]$HoldSeconds = 0
)

# =============================================================================
# Acceptance run for one DSH version.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI code page, which mangles non-ASCII and can eat a closing quote - that is an
# independent trap that has already bitten this script family once.
#
# Safety contract, enforced in code rather than by convention:
#   1. No automatic-variable names. $home, $pid, $input, $error, $args, $matches
#      are all read-only in PowerShell and variable names are case-insensitive.
#   2. Set-StrictMode + ErrorActionPreference = Stop, so a failed assignment
#      aborts the run instead of silently flowing into the next statement.
#   3. THE ONLY PATHS THIS SCRIPT EVER DELETES ARE one direct child of
#      $disposableRoot named home-<semver> and one direct child of $logRoot named
#      log-<semver>. Everything else - the DSH builds under $HostsRoot, the logs,
#      the tarball, the run root itself - is structurally undeletable here.
#   4. Before any recursive delete: the resolved path must be under the designated
#      root, must not BE it, must be a DIRECT child, must carry the exact expected
#      leaf name, and must have no reparse point (junction/symlink) anywhere on it,
#      because Remove-Item -Recurse follows those on Windows PowerShell.
#   5. Every dsh invocation goes through invoke-bounded.ps1. Calling dsh with
#      2>&1 under ErrorActionPreference = Stop turns any benign stderr line into
#      a terminating error and would abort the run mid-matrix. invoke-bounded also
#      uses taskkill /T /F rather than $p.Kill($true): that overload does not exist
#      on .NET Framework, and swallowing the error leaves the server on its port.
#   6. After setting it, DSH_HOME is re-asserted: isolation must be live before
#      any dsh command runs, and the user profile is refused outright.
# =============================================================================

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$global:LASTEXITCODE = 0   # StrictMode would otherwise fail on the first native call

$hostsRoot      = [System.IO.Path]::GetFullPath($HostsRoot)
$runRoot        = [System.IO.Path]::GetFullPath($RunRoot)
$evidenceRoot   = Split-Path $runRoot -Parent
$disposableRoot = Join-Path $runRoot 'homes'
$logRoot        = Join-Path $runRoot 'logs'
$invoker        = Join-Path $PSScriptRoot 'invoke-bounded.ps1'

if (-not $Tarball) {
  $manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\..\package.json') -Raw | ConvertFrom-Json
  $Tarball = Join-Path $runRoot ("dsh-worktree-space-$($manifest.version).tgz")
}
$tarball = [System.IO.Path]::GetFullPath($Tarball)

$binJs   = Join-Path $hostsRoot ("$v\node_modules\@deepseek-ai\dsh\lib\bin.js")
$dshHome = Join-Path $disposableRoot ("home-" + $v)
$logDir  = Join-Path $logRoot ("log-" + $v)
$leaf    = "home-" + $v

if (-not (Test-Path -LiteralPath $binJs)) {
  throw ("no DSH build at " + $binJs + " - run install-hosts.ps1 first")
}
if (-not (Test-Path -LiteralPath $tarball)) {
  throw ("no tarball at " + $tarball + " - run install-tarball.ps1 first")
}

# --- the guard ---------------------------------------------------------------

function Assert-NoReparsePoint {
  param([string]$Path, [string]$StopAt, [string]$Label)
  $cur  = [System.IO.Path]::GetFullPath($Path)
  $stop = [System.IO.Path]::GetFullPath($StopAt)
  while ($cur) {
    if (Test-Path -LiteralPath $cur) {
      $item = Get-Item -LiteralPath $cur -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw ("REFUSED[{0}]: {1} is a reparse point; Remove-Item -Recurse would follow it" -f $Label, $cur)
      }
    }
    if ($cur -eq $stop) { break }
    $parent = Split-Path $cur -Parent
    if ($parent -eq $cur) { break }
    $cur = $parent
  }
}

function Assert-Under {
  # Base check for every delete in this script. $MustBeUnder names the one
  # designated directory that a given delete is allowed to touch.
  param([string]$Path, [string]$MustBeUnder, [string]$Label)
  $full = [System.IO.Path]::GetFullPath($Path)
  $scope= [System.IO.Path]::GetFullPath($MustBeUnder)
  $user = [Environment]::GetFolderPath('UserProfile')
  $sep  = [IO.Path]::DirectorySeparatorChar

  if ($full -eq $user)                            { throw ("REFUSED[{0}]: {1} IS the user profile" -f $Label, $full) }
  if ($full -match '^[A-Za-z]:\\?$')             { throw ("REFUSED[{0}]: {1} is a drive root" -f $Label, $full) }
  if ($full -eq $scope)                           { throw ("REFUSED[{0}]: {1} IS the designated root itself" -f $Label, $full) }
  if ($full -eq [IO.Path]::GetFullPath($evidenceRoot)) { throw ("REFUSED[{0}]: {1} IS the evidence root" -f $Label, $full) }
  if ($full -eq [IO.Path]::GetFullPath($runRoot))       { throw ("REFUSED[{0}]: {1} IS the run root" -f $Label, $full) }
  if (-not $full.StartsWith($scope + $sep, [StringComparison]::OrdinalIgnoreCase)) {
    throw ("REFUSED[{0}]: {1} is not under {2}" -f $Label, $full, $scope)
  }
  return $full
}

function Assert-DirectChild {
  # one level below $MustBeUnder, named exactly $ExpectLeaf, no reparse point
  param([string]$Path, [string]$MustBeUnder, [string]$ExpectLeaf, [string]$Label)
  $full = Assert-Under -Path $Path -MustBeUnder $MustBeUnder -Label $Label
  $scope= [System.IO.Path]::GetFullPath($MustBeUnder)

  $parent = Split-Path $full -Parent
  if ($parent -ne $scope) {
    throw ("REFUSED[{0}]: {1} is not a direct child of {2}" -f $Label, $full, $scope)
  }
  $name = Split-Path $full -Leaf
  if ($name -ne $ExpectLeaf) {
    throw ("REFUSED[{0}]: leaf '{1}' is not the expected '{2}'" -f $Label, $name, $ExpectLeaf)
  }
  Assert-NoReparsePoint -Path $full -StopAt $scope -Label $Label
  return $full
}

function Assert-Deletable {
  # The strictest one: a direct child of $disposableRoot named home-<v>.
  param([string]$Path, [string]$Label)
  return Assert-DirectChild -Path $Path -MustBeUnder $disposableRoot -ExpectLeaf $leaf -Label $Label
}

function Assert-LogDir {
  # Log directories are evidence, not scratch: a direct child of $logRoot
  # named log-<v>. Same shape of rule, separate designated root.
  param([string]$Path, [string]$Label)
  return Assert-DirectChild -Path $Path -MustBeUnder $logRoot -ExpectLeaf ("log-" + $v) -Label $Label
}

$script:summaryFile = $null
function Emit {
  # Writes to the host AND to summary.txt in this version's log directory, so the
  # per-run verdicts survive the console scrollback. The driver cannot capture
  # them instead: Write-Host does not go to the output stream in this host.
  param($k, $val)
  $line = ("{0}: {1}" -f $k, $val)
  Write-Host $line
  if ($script:summaryFile) { Add-Content -LiteralPath $script:summaryFile -Value $line }
}

function Run-Dsh {
  param([string[]]$DshArgs, [string]$Tag, [int]$TimeoutSec = 180)
  $outFile = Join-Path $logDir ($Tag + '.txt')
  $r = & $invoker -Exe 'node' -Args (@($binJs) + $DshArgs) -OutFile $outFile `
                   -TimeoutSec $TimeoutSec -AllowedRoot $logDir
  return $r
}

# --- preconditions -----------------------------------------------------------

if ($v -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "refusing odd version string '$v'" }
if (-not (Test-Path -LiteralPath $binJs))    { throw "missing DSH at $binJs" }
if (-not (Test-Path -LiteralPath $tarball))  { throw "missing tarball at $tarball" }
foreach ($d in @($disposableRoot, $logRoot)) { if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null } }

# --- 0. fresh, isolated DSH_HOME ---------------------------------------------

$safeHome = Assert-Deletable -Path $dshHome -Label 'dshHome'
if (Test-Path -LiteralPath $safeHome) { Remove-Item -LiteralPath $safeHome -Recurse -Force }
New-Item -ItemType Directory -Path $safeHome | Out-Null
$env:DSH_HOME = $safeHome

# isolation must be live before any dsh command runs
if ([System.IO.Path]::GetFullPath($env:DSH_HOME) -eq [Environment]::GetFolderPath('UserProfile')) {
  throw "REFUSED: DSH_HOME resolved to the user profile"
}

# A previous aborted run can leave a booted dsh holding this version's
# 04-boot.stderr.txt open, which makes the log directory undeletable. Clear any
# process still pointing at our own host build before touching the directory.
# Scoped to $hostsRoot so nothing outside the evidence workspace is touched.
$stray = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
         Where-Object { $_.CommandLine -and $_.CommandLine -like ("*" + [IO.Path]::GetFullPath($hostsRoot) + "*") }
foreach ($s in $stray) {
  Write-Host ("clearing stray host process PID " + $s.ProcessId)
  $null = & taskkill /PID $s.ProcessId /T /F 2>&1
}
if ($stray) { Start-Sleep -Seconds 2 }

$safeLog = Assert-LogDir -Path $logDir -Label 'logDir'
if (Test-Path -LiteralPath $safeLog) { Remove-Item -LiteralPath $safeLog -Recurse -Force }
New-Item -ItemType Directory -Path $safeLog | Out-Null
$script:summaryFile = Join-Path $safeLog 'summary.txt'

Emit "version"     $v
Emit "node"        (node -v)
Emit "dsh_actual"  ((& node $binJs --version) -join '')
Emit "dsh_home"    $env:DSH_HOME
Emit "tarball"     (Split-Path $tarball -Leaf)

# --- 1. create the profile from the shipped web template ---------------------
# --dump-config is what makes this compose-and-exit instead of booting a server
# on the default port 3080. --no-open must NOT be added here: dsh rejects the
# combination outright ("config dumps take no app arguments"), and the failure is
# silent in the sense that the next step then builds a bare profile with no web
# app bundle layer - which composes fine but never activates.
#
# Verified on 0.1.7-rc.1: with --no-open this exits 1 and the profile is created
# by the plugin add instead, giving a 359-line config tree against 1189 from the
# web template.

$r = Run-Dsh -DshArgs @('--profile','evidence','--from-default-profile','web','--dump-config') -Tag '01-create' -TimeoutSec 180
Emit "create_exit"  $r.code
Emit "create_out"   (((Get-Content -LiteralPath $r.out -Raw) + (Get-Content -LiteralPath $r.err -Raw)) -replace '\s+',' ').Trim()

# --- 2. install the tarball ---------------------------------------------------

$r = Run-Dsh -DshArgs @('plugin','--profile','evidence','add',$tarball) -Tag '02-add' -TimeoutSec 300
$addText = (Get-Content -LiteralPath $r.out -Raw) + (Get-Content -LiteralPath $r.err -Raw)
Emit "add_exit"        $r.code
Emit "add_out"         (($addText -replace '\s+',' ').Trim())
Emit "add_incompatible" $(if ($addText -match 'incompatible') { 'YES' } else { 'no' })

$pkg = Join-Path $safeHome 'profiles\evidence\node_modules\dsh-worktree-space\package.json'
if (Test-Path -LiteralPath $pkg) {
  $j = Get-Content -LiteralPath $pkg -Raw | ConvertFrom-Json
  Emit "installed_version" $j.version
  Emit "installed_engines" (($j.engines | ConvertTo-Json -Compress))
} else {
  Emit "installed_version" "MISSING"
}

# --- 3. compose after install ------------------------------------------------

$r = Run-Dsh -DshArgs @('--profile','evidence','--dump-config') -Tag '03-dump-after' -TimeoutSec 180
$dump = Get-Content -LiteralPath $r.out
# @() is required: Select-String returns a SCALAR when it matches 0 or 1 lines,
# and under Set-StrictMode a scalar has no .Count to read.
Emit "dump_after_exit"  $r.code
Emit "dump_after_lines" @($dump).Count
Emit "dump_after_hits"  @($dump | Select-String -Pattern 'worktree-space').Count
Emit "dump_after_name"  @($dump | Select-String -Pattern 'name: dsh-worktree-space').Count

# --- 4. start, probe, stop ---------------------------------------------------
# A caller-supplied high port, not the DSH default 3080 and not 0. 3080 collides
# with anything else running the app, and 0 hides the port from the evidence
# record. run-all.ps1 gives each version its own so two runs cannot tread on each
# other, and the port is probed free BEFORE booting so a collision is a hard stop
# rather than a boot that silently lands somewhere else.

$busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($busy) {
  throw ("REFUSED: port {0} is already in use by PID {1}; pick another or stop it" -f $Port, (($busy | Select-Object -ExpandProperty OwningProcess) -join ','))
}
Emit "port" $Port

$bootOut = Join-Path $logDir '04-boot.txt'
$bootErr = $bootOut -replace '\.txt$', '.stderr.txt'
$proc = Start-Process -FilePath 'node' `
          -ArgumentList (@($binJs,'--profile','evidence','--no-open','--port',"$Port")) `
          -NoNewWindow -PassThru -RedirectStandardOutput $bootOut -RedirectStandardError $bootErr
$null = $proc.Handle

$url = $null
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline -and -not $url) {
  if ($proc.HasExited) { break }
  if (Test-Path -LiteralPath $bootOut) {
    # Get-Content -Raw returns $null on a file that is still empty, and
    # [regex]::Match($null, ...) throws ArgumentNullException under StrictMode.
    $txt = Get-Content -LiteralPath $bootOut -Raw
    if ($null -ne $txt -and $txt.Length -gt 0) {
      # Capture the WHOLE url including ?token=... - dsh prints
      # "dsh web: http://127.0.0.1:PORT/?token=XYZ dsh web: opening the default
      # browser; pass --no-open to disable". Truncating at the port drops the
      # token and every page and RPC probe then answers 401.
      $m = [regex]::Match($txt, 'http://[^\s]+')
      if ($m.Success) { $url = $m.Value }
    }
  }
  if (-not $url) { Start-Sleep -Milliseconds 800 }
}
if (-not $url) {
  $raw = Get-Content -LiteralPath $bootOut -Raw
  if ($null -ne $raw) { Emit "boot_output_so_far" (($raw -replace '\s+',' ').Trim()) }
  $e = Get-Content -LiteralPath $bootErr -Raw
  if ($null -ne $e) { Emit "boot_stderr" (($e -replace '\s+',' ').Trim()) }
}

Emit "boot_url"  $(if ($url) { $url } else { 'NOT FOUND' })
Emit "boot_alive" (-not $proc.HasExited)

# --- 2.3 visibility, the way the acceptance criteria define it ----------------
# Three separate facts, each machine-readable, none of them a screenshot:
#   a) the page is served and advertises the plugin's client module
#   b) that module URL really serves the client code as javascript
#   c) the host RPC route answers: a real endpoint 200 with {ok:true,...}, an
#      invented one 404
#
# Everything below was wrong in earlier revisions of this script. Recorded
# because each failure looks like a plugin fault rather than a probe fault:
#   * POST /api/<ep> answers 405 and GET answers 404 until the session cookie
#     exists. The token in the launch url is exchanged for that cookie on the
#     index request, so the index must be fetched with -SessionVariable and the
#     cookie replayed. Unauthenticated, EVERY /api route fails, including host
#     routes that are obviously present.
#   * endpointFromPath("/api", p) is p.slice("/api".length + 1), so the envelope
#     method is the WHOLE remainder, "dsh-worktree-space/<ep>", not "<ep>".
#   * the module url is page-relative and needs no leading slash on $base, or
#     "//plugins/..." silently falls through to the SPA fallback and answers 200
#     text/html with the page's own byte count.

if ($url) {
  $base = (($url -split '\?')[0]).TrimEnd('/')
  try {
    $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 30 -SessionVariable sess
    Emit "page_status"   $page.StatusCode
    Emit "page_bytes"    $page.RawContentLength
    Emit "page_mentions" ([regex]::Matches($page.Content, 'dsh-worktree-space')).Count
    Emit "session_cookies" (@($sess.Cookies.GetCookies($base)).Count)
  } catch {
    Emit "page_error" $_.Exception.Message
  }

  # (b) the advertised client bundle
  $m = [regex]::Match($page.Content, '"dsh-worktree-space","url":"([^"]+)"')
  if ($m.Success) {
    Emit "bundle_url" $m.Groups[1].Value
    try {
      $b = Invoke-WebRequest -Uri ($base + '/' + $m.Groups[1].Value) -UseBasicParsing `
               -TimeoutSec 30 -WebSession $sess
      # .Content for a text/javascript response is a Byte[] on Windows
      # PowerShell, and casting that to [string] yields the literal text
      # "System.Byte[]" - which matches nothing and reads like a plugin fault.
      # Read the raw stream instead.
      $ms = New-Object IO.MemoryStream
      $b.RawContentStream.CopyTo($ms)
      $bt = [Text.Encoding]::UTF8.GetString($ms.ToArray())
      Emit "bundle_status"  $b.StatusCode
      Emit "bundle_bytes"   $b.RawContentLength
      Emit "bundle_type"    $b.Headers['Content-Type']
      Emit "bundle_registers" ([regex]::Matches($bt,'id: "dsh-worktree-space"')).Count
      Emit "bundle_endpoints" ([regex]::Matches($bt,'dsh-worktree-space/[a-z]+\.[a-z-]+')).Count
    } catch {
      $c = $null; try { $c = [int]$_.Exception.Response.StatusCode } catch { }
      Emit "bundle_status" $(if ($c) { $c } else { 'ERR' })
    }
  } else {
    Emit "bundle_url" "NOT ADVERTISED"
  }

  # (c) the host RPC route
  $rpcId = [guid]::NewGuid().ToString('N')
  foreach ($ep in @('task.preference', 'definitely.not.an.endpoint')) {
    $fullEp = 'dsh-worktree-space/' + $ep
    $envl = @{ type='client-request'; rpcId=$rpcId; method=$fullEp; payload=@{} } | ConvertTo-Json -Compress
    try {
      $r = Invoke-WebRequest -Uri ($base + '/api/' + $fullEp) -Method POST -Body $envl `
                 -ContentType 'application/json' -UseBasicParsing -TimeoutSec 20 -WebSession $sess
      Emit ("rpc_" + $ep) ("HTTP " + $r.StatusCode + "  " + (($r.Content -replace '\s+',' ').Trim()))
    } catch {
      $code = $null; $raw = ''
      try { $code = [int]$_.Exception.Response.StatusCode } catch { }
      try {
        $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
        $raw = $sr.ReadToEnd(); $sr.Close()
      } catch { }
      Emit ("rpc_" + $ep) $(if ($code) { "HTTP $code  " + (($raw -replace '\s+',' ').Trim()) } else { "error: " + $_.Exception.Message })
    }
  }
}

# --- 7. rollback-on-registration-failure -------------------------------------
#
# The create dialog must leave nothing behind when Workspace registration fails:
# not the container, not its worktrees, not the branch. Two of those three are
# facts on disk rather than things anyone reads on screen, and one of them - the
# branch - is the one a partial cleanup used to leave, which turned the next
# attempt at the same name into `branch already exists`.
#
# The failure itself is a transient host race (EPERM renaming workspace.json) that
# cannot be provoked on demand, so the dialog carries a switch that fails the
# registration deterministically. Nothing here can click a button, so the facts are
# collected two ways: a probe samples the container and the branch while the user
# drives the page, and the same assertions are made here over plain RPC for the
# create half. The probe is what makes the UI half checkable after the fact.
#
# ASCII-only, like every script in this folder. No Remove-Item: this stage creates
# a repository and reads state, and the teardown below is bounded by the same
# $disposableRoot rule as everything else.

$probeRoot  = Join-Path $disposableRoot ('home-' + $v + '\probe')
$fixtureRepo = Join-Path $probeRoot 'fixture-repo'
$containerRoot = Join-Path $probeRoot 'container'
$probeLog = Join-Path $safeLog 'rollback-probe.txt'

foreach ($d in @($probeRoot, $containerRoot)) {
  if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

# A real repository, because task.create runs git against it: a directory that is
# not a repository would fail the first precondition and never reach the step under
# test. One commit is enough - the create needs a HEAD to cut a worktree from.
if (-not (Test-Path -LiteralPath (Join-Path $fixtureRepo '.git'))) {
  New-Item -ItemType Directory -Path $fixtureRepo -Force | Out-Null
  $g = @('-C', $fixtureRepo, '-c', 'user.email=acceptance@example.invalid', '-c', 'user.name=Acceptance',
         '-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false')
  $null = & git @g init --quiet 2>&1
  Set-Content -LiteralPath (Join-Path $fixtureRepo 'README.md') -Value 'acceptance fixture' -Encoding ASCII
  $null = & git @g add README.md 2>&1
  $null = & git @g commit --quiet -m 'fixture' 2>&1
}
$fixtureBranch = ((& git -C $fixtureRepo rev-parse --abbrev-ref HEAD) -join '').Trim()
Emit "fixture_repo"    $fixtureRepo
Emit "fixture_branch"  $fixtureBranch
Emit "container_root"  $containerRoot

# The probe samples the two facts the rollback is judged on, once a second, and
# writes a line only when one of them CHANGES. A rollback that runs to completion
# between two samples is still recorded, because the sample before it saw the
# container and the sample after it does not. Written to the log directory, which
# is evidence and is not deleted here.
#
# A Start-Job would die with this script, which defeats the point: the page is
# driven after the script has finished its work. So the sampler is a separate pwsh
# process writing to the same log, and the teardown kills it by its recorded PID.
$probeTask = 'rollback-check'
# The project layer is the SOURCE root's own directory name - that is how the Host
# files a task - so it is the repository's leaf, never the string "fixture".
$probeProject = Split-Path $fixtureRepo -Leaf
$probeContainer = Join-Path (Join-Path $containerRoot $probeProject) $probeTask
$probeBranchRef = 'refs/heads/task/' + $probeTask
$probePidFile = Join-Path $safeLog 'rollback-probe.pid'
if (Test-Path -LiteralPath $probeLog) { Remove-Item -LiteralPath $probeLog -Force }

$probeScript = Join-Path $safeLog 'rollback-probe.ps1'
$probeBody = @(
  'Set-StrictMode -Version Latest',
  '$container = $args[0]; $repo = $args[1]; $branchRef = $args[2]; $logPath = $args[3]',
  '$last = ""',
  'while ($true) {',
  '  $dirThere = Test-Path -LiteralPath $container',
  '  $brThere = $null -ne (& git -C $repo rev-parse --verify --quiet $branchRef)',
  '  $state = "container=" + $(if ($dirThere) { "present" } else { "absent" }) + " branch=" + $(if ($brThere) { "present" } else { "absent" })',
  '  if ($state -ne $last) {',
  '    Add-Content -LiteralPath $logPath -Value ((Get-Date).ToString("HH:mm:ss") + "  " + $state)',
  '    $last = $state',
  '  }',
  '  Start-Sleep -Seconds 1',
  '}'
) -join "`r`n"
Set-Content -LiteralPath $probeScript -Value $probeBody -Encoding ASCII

$pwshExe = (Get-Process -Id $PID).Path
$probeProc = Start-Process -FilePath $pwshExe `
  -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$probeScript,
                  $probeContainer, $fixtureRepo, $probeBranchRef, $probeLog) `
  -PassThru -WindowStyle Hidden
$null = $probeProc.Handle   # without this, ExitCode is never populated
Set-Content -LiteralPath $probePidFile -Value ([string]$probeProc.Id) -Encoding ASCII

Emit "probe_log" $probeLog
Emit "probe_container" $probeContainer
Emit "probe_branch"    $probeBranchRef

# The same three facts over RPC, for the create half a script can reach: a create
# into a container root that does not exist must succeed and leave both the
# container and the branch, which is the "all succeeded" half of the contract the
# rollback half answers to. Driven here rather than by the user so the run stays
# meaningful even if nobody opens the page.
if ($base) {
  $rpcId2 = [guid]::NewGuid().ToString('N')
  $createEp = 'dsh-worktree-space/task.create'
  $envl = @{
    type='client-request'; rpcId=$rpcId2; method=$createEp
    payload=@{ sourceRoot=$fixtureRepo; task='rpc-check'; tasksRoot=$containerRoot }
  } | ConvertTo-Json -Compress -Depth 5
  try {
    $r = Invoke-WebRequest -Uri ($base + '/api/' + $createEp) -Method POST -Body $envl `
               -ContentType 'application/json' -UseBasicParsing -TimeoutSec 120 -WebSession $sess
    Emit "rpc_create_status" $r.StatusCode
    Emit "rpc_create_body" (($r.Content -replace '\s+',' ').Trim())
  } catch {
    $code = $null; $raw = ''
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    try {
      $sr = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
      $raw = $sr.ReadToEnd(); $sr.Close()
    } catch { }
    Emit "rpc_create_status" $(if ($code) { $code } else { 'ERR' })
    Emit "rpc_create_body" (($raw -replace '\s+',' ').Trim())
  }
  $rpcDir = Join-Path (Join-Path $containerRoot (Split-Path $fixtureRepo -Leaf)) 'rpc-check'
  Emit "rpc_create_dir"    (Test-Path -LiteralPath $rpcDir)
  Emit "rpc_create_branch" ((& git -C $fixtureRepo rev-parse --verify --quiet 'refs/heads/task/rpc-check') -ne $null)
}

Emit "STAGE" "7 rollback probe armed; drive the page, then re-run to read the log"
Write-Host ("probe is sampling: " + $probeContainer)
Write-Host ("the server stays up on port " + $Port + " - open the url above and follow the steps")

# --- leave the page to the user -------------------------------------------------
#
# The probe and the server both stay up after this script finishes: the page is
# driven from here on, and the evidence is read afterwards from the probe log and
# from the container directory. A matrix run passes -HoldSeconds 0, which tears
# down immediately - because it has no page to drive.
#
# What is left behind, and only this:
#   <RunRoot>\logs\log-<v>\rollback-probe.txt   the samples
#   <RunRoot>\logs\log-<v>\rollback-probe.pid   the sampler's process id
#   <RunRoot>\homes\home-<v>\probe\             the fixture repo and container root
#   the dsh process holding the port
# Re-running this script clears all of it: step 0 kills strays and deletes the
# home and log directories after the guards have approved them.
if ($HoldSeconds -gt 0) {
  Write-Host ''
  Write-Host ('  Server:  ' + $url)
  Write-Host ('  Probe:   ' + $probeLog)
  Write-Host ('  Pid:     ' + $probeProc.Id + '  (sampler)')
  Write-Host ('  Source:  ' + $fixtureRepo)
  Write-Host ('  Probe watches: ' + $probeContainer)
  Write-Host ''
  Write-Host ('  The server and the sampler stay up for ' + $HoldSeconds + 's.')
  Write-Host '  Drive the create dialog in that window, then re-run to collect.'
  Write-Host ''
  $deadline = (Get-Date).AddSeconds($HoldSeconds)
  while ((Get-Date) -lt $deadline) { Start-Sleep -Seconds 5 }
}

# taskkill /T /F, not $proc.Kill($true): that overload does not exist on .NET
# Framework, and swallowing the error leaves the server holding its port.
if ($probeProc -and -not $probeProc.HasExited) {
  $null = & taskkill /PID $probeProc.Id /T /F 2>&1
}
$tree = & taskkill /PID $proc.Id /T /F 2>&1
$null = $proc.WaitForExit(15000)
Emit "probe_final" $(if (Test-Path -LiteralPath $probeLog) { ((Get-Content -LiteralPath $probeLog) -join ' | ') } else { 'no samples' })
Emit "boot_stopped" $proc.HasExited
if (-not $proc.HasExited) { Emit "boot_kill_FAILED" ($tree -join ' ') }


# --- 5. uninstall ------------------------------------------------------------

$r = Run-Dsh -DshArgs @('plugin','--profile','evidence','remove','dsh-worktree-space') -Tag '05-remove' -TimeoutSec 300
Emit "remove_exit" $r.code
Emit "node_modules_gone" (-not (Test-Path -LiteralPath (Join-Path $safeHome 'profiles\evidence\node_modules\dsh-worktree-space')))

# --- 6. rollback -------------------------------------------------------------

$r = Run-Dsh -DshArgs @('--profile','evidence','--dump-config') -Tag '06-dump-after-remove' -TimeoutSec 180
$dump2 = Get-Content -LiteralPath $r.out
Emit "rollback_exit"  $r.code
Emit "rollback_lines" @($dump2).Count
Emit "rollback_hits"  @($dump2 | Select-String -Pattern 'worktree-space').Count

$patch = Join-Path $safeHome 'profiles\evidence\cordis.patch.yml'
if (Test-Path -LiteralPath $patch) {
  Emit "patch_mentions" @((Get-Content -LiteralPath $patch -Raw) -split "`n" | Select-String -Pattern 'worktree-space').Count
} else {
  Emit "patch_mentions" "no cordis.patch.yml"
}

Emit "STAGE" "all six steps done"
Write-Host ("logs: " + $logDir)
