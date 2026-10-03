param(
  [string]$RunRoot = (Join-Path $env:TEMP 'dsh-acceptance\run')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ASCII-only on purpose. A BOM-less UTF-8 .ps1 is read as the system ANSI code page
# by Windows PowerShell 5.1; non-ASCII gets mangled and the byte that gets eaten is
# often the closing quote, producing a parser error far from the real cause. This
# file hit exactly that while being written. Keep .ps1 bodies ASCII.

# Regression tests for the delete guard in run-one.ps1.
#
# The guards are EXTRACTED FROM run-one.ps1 with the PowerShell parser rather than
# copied here. A copy would be a second implementation that can drift, and a guard
# that only exists in a test proves nothing about the code that actually deletes.
# If a function in run-one.ps1 is renamed or removed, this test fails to find it.

$runnerPath = Join-Path $PSScriptRoot 'run-one.ps1'
if (-not (Test-Path -LiteralPath $runnerPath)) { throw ("runner not found at " + $runnerPath) }

$runRoot  = [System.IO.Path]::GetFullPath($RunRoot)
$v        = '0.1.7-rc.2'

# The scope variables the guards read are TAKEN FROM THE RUNNER, not restated
# here. Copying them would be a second answer to the same question: widen
# $disposableRoot in run-one.ps1, or set $leaf to something that is not this
# version's home, and a test carrying its own copies would still print GUARD-OK
# while the runner deleted whatever the new values named. Only the two script
# *inputs* are supplied above; everything else follows the runner.
#
# Order is the list's, and it is the runner's: $runRoot feeds the two roots and
# $evidenceRoot, and $v feeds $leaf.
$scopeNames = @('runRoot', 'evidenceRoot', 'disposableRoot', 'logRoot', 'leaf')

$errors = $null
$ast    = [System.Management.Automation.Language.Parser]::ParseFile($runnerPath, [ref]$null, [ref]$errors)
if ($errors -and $errors.Count) { throw ("runner does not parse: " + $errors[0].Message) }

# Bind the extracted guards to the runner's own scope before anything calls them.
# Evaluated in $scopeNames order, which is the runner's: $runRoot feeds the two
# roots and $evidenceRoot, and $v feeds $leaf.
$assigned = @{}
foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.AssignmentStatementAst] }, $false)) {
  $target = $node.Left
  if ($target -isnot [System.Management.Automation.Language.VariableExpressionAst]) { continue }
  $varName = $target.VariablePath.UserPath
  if ($scopeNames -contains $varName) { $assigned[$varName] = $node.Extent.Text }
}
$unassigned = @($scopeNames | Where-Object { -not $assigned.ContainsKey($_) })
if ($unassigned.Count) {
  throw ("run-one.ps1 no longer assigns: " + ($unassigned -join ', ') + " - the guard tests cannot run")
}
foreach ($scopeName in $scopeNames) { Invoke-Expression $assigned[$scopeName] }

$found = @{}
foreach ($node in $ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  $found[$node.Name] = $node.Extent.Text
}

$wanted = @('Assert-NoReparsePoint', 'Assert-Under', 'Assert-DirectChild', 'Assert-Deletable', 'Assert-LogDir')
$missing = @($wanted | Where-Object { -not $found.ContainsKey($_) })
if ($missing.Count) {
  throw ("run-one.ps1 no longer defines: " + ($missing -join ', ') + " - the guard tests cannot run")
}
foreach ($name in $wanted) {
  Invoke-Expression $found[$name]
}
Write-Host ("extracted from run-one.ps1: " + ($wanted -join ', '))
Write-Host ''

# --- cases --------------------------------------------------------------------
# One ALLOW: the home directory of the version being run. Everything else must be
# refused, including the three paths that actually caused harm before.

$sep  = [IO.Path]::DirectorySeparatorChar
$u    = '..'
$user = [Environment]::GetFolderPath('UserProfile')
$hostsRoot = (Join-Path $evidenceRoot 'hosts')

$cases = @(
  @{ ok = $true;  n = 'normal: this version home';        p = $disposableRoot + $sep + $leaf },
  @{ ok = $false; n = 'user profile';                     p = $user },
  @{ ok = $false; n = 'a sibling of the user profile';    p = $user + $sep + 'Documents' },
  @{ ok = $false; n = 'all DSH builds';                   p = $hostsRoot },
  @{ ok = $false; n = 'one DSH build';                    p = $hostsRoot + $sep + '0.2.0-rc.2' },
  @{ ok = $false; n = 'the evidence root itself';         p = $evidenceRoot },
  @{ ok = $false; n = 'the run root itself';              p = $runRoot },
  @{ ok = $false; n = 'the disposable root itself';       p = $disposableRoot },
  @{ ok = $false; n = 'drive root of the run area';       p = ([System.IO.Path]::GetPathRoot($runRoot)) },
  @{ ok = $false; n = 'drive root C:\';                   p = 'C:\' },
  @{ ok = $false; n = 'traversal up to the hosts';        p = $runRoot + $sep + $u + $sep + 'hosts' },
  @{ ok = $false; n = 'traversal out to the user';        p = $disposableRoot + $sep + $leaf + $sep + $u + $sep + $u + $sep + $u + $sep + $u + $sep + 'Users' + $sep + 'someone' },
  @{ ok = $false; n = 'right name but nested deeper';     p = $disposableRoot + $sep + 'sub' + $sep + $leaf },
  @{ ok = $false; n = 'right level but wrong name';       p = $disposableRoot + $sep + 'home-0.9.9' },
  @{ ok = $false; n = 'the temp dir an earlier run hit';  p = [System.IO.Path]::GetTempPath() }
)

Write-Host ('delete scope : ' + $disposableRoot)
Write-Host ('log scope    : ' + $logRoot)
Write-Host ('user profile : ' + $user)
Write-Host ''
$fail = 0
foreach ($c in $cases) {
  try { $null = Assert-Deletable -Path $c.p -Label 'test'; $got = 'ALLOW' }
  catch { $got = 'BLOCK' }
  $want = if ($c.ok) { 'ALLOW' } else { 'BLOCK' }
  if ($got -ne $want) { $fail++ }
  Write-Host ('  [{0}] want={1} got={2}  {3}' -f $(if ($got -eq $want) { 'ok  ' } else { 'FAIL' }), $want, $got, $c.n)
  Write-Host ('           ' + $c.p)
}

# the log guard is a separate scope and must be just as narrow
Write-Host ''
foreach ($c in @(
  @{ ok = $true;  n = 'normal: this version log dir';  p = $logRoot + $sep + ("log-" + $v) },
  @{ ok = $false; n = 'the disposable root';           p = $disposableRoot },
  @{ ok = $false; n = 'a home directory';              p = $disposableRoot + $sep + $leaf },
  @{ ok = $false; n = 'wrong log name';                p = $logRoot + $sep + 'log-9.9.9' }
)) {
  try { $null = Assert-LogDir -Path $c.p -Label 'test'; $got = 'ALLOW' }
  catch { $got = 'BLOCK' }
  $want = if ($c.ok) { 'ALLOW' } else { 'BLOCK' }
  if ($got -ne $want) { $fail++ }
  Write-Host ('  [{0}] want={1} got={2}  {3}' -f $(if ($got -eq $want) { 'ok  ' } else { 'FAIL' }), $want, $got, $c.n)
}

# --- the ASCII rule, checked rather than remembered ---------------------------
# Every .ps1 in this folder must be pure ASCII. A single non-ASCII byte is enough
# to turn a later edit into a parse error on a different machine.

Write-Host ''
$nonAscii = @()
foreach ($f in Get-ChildItem -LiteralPath $PSScriptRoot -Filter *.ps1) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  if (@($bytes | Where-Object { $_ -gt 127 }).Count) { $nonAscii += $f.Name }
}
if ($nonAscii.Count) {
  $fail++
  Write-Host ('  [FAIL] non-ASCII bytes in: ' + ($nonAscii -join ', '))
} else {
  Write-Host '  [ok  ] every .ps1 here is ASCII only'
}

Write-Host ''
if ($fail -eq 0) { Write-Host 'GUARD-OK: every case matched its expectation' }
else { Write-Host ('GUARD-FAIL: ' + $fail + ' case(s) did not match') }
Write-Host 'nothing was deleted'
if ($fail -ne 0) { exit 1 }