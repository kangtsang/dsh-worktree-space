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
  [int]$Port = 34800
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

# taskkill /T /F, not $proc.Kill($true): that overload does not exist on .NET
# Framework, and swallowing the error leaves the server holding its port.
$tree = & taskkill /PID $proc.Id /T /F 2>&1
$null = $proc.WaitForExit(15000)
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
