param(
  # Must match run-one.ps1's MatrixRoot default, because that is where the runner
  # looks for the tarball this script produces. Same derivation, same reason:
  # one acceptance root, per-project state under <root>\<repo name>.
  [string]$AcceptanceRoot = 'D:\dsh-acceptance',
  [string]$ProjectName = (Split-Path (Join-Path $PSScriptRoot '..\..') -Leaf),
  [string]$MatrixRoot = (Join-Path (Join-Path $AcceptanceRoot $ProjectName) 'matrix')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less .ps1 as the system
# ANSI code page, which mangles non-ASCII and can eat a closing quote.
#
# Packs this repository and drops the tarball where run-one.ps1 looks for it. The
# pack is what the matrix actually installs, so it is the same artifact the release
# workflow would publish.

$matrixRoot = [System.IO.Path]::GetFullPath($MatrixRoot)
if (-not (Test-Path -LiteralPath $matrixRoot)) {
  New-Item -ItemType Directory -Path $matrixRoot -Force | Out-Null
}

$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manifest = Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json
$target = Join-Path $matrixRoot ("dsh-worktree-space-$($manifest.version).tgz")

if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }

Write-Host ('packing ' + $repo + ' -> ' + $target)
Push-Location $repo
try {
  # Build first, always. The pack is what the matrix installs, so it has to be
  # the artifact the release workflow would publish - and that one builds:
  # npm publish runs prepublishOnly, which runs pnpm test, which runs pnpm build.
  # Without this a source edit that was never built packs cleanly, the six
  # stages all pass, and every one of them is measuring the *committed* bundle
  # with the old strings in it. Exactly the trap this repo has already hit twice.
  Write-Host 'building before packing'
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "pnpm build failed with exit $LASTEXITCODE" }

  & pnpm pack --pack-destination $matrixRoot
  if ($LASTEXITCODE -ne 0) { throw "pnpm pack failed with exit $LASTEXITCODE" }
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $target)) {
  # pnpm names the file from the package name and version; look for it rather than
  # assume, so a rename of the package does not silently break the matrix.
  $found = @(Get-ChildItem -LiteralPath $matrixRoot -Filter '*.tgz')
  if ($found.Count -eq 1) { $target = $found[0].FullName }
  else { throw ("tarball not produced; found " + $found.Count + " .tgz in " + $matrixRoot) }
}

$size = (Get-Item -LiteralPath $target).Length
Write-Host ('tarball: ' + $target)
Write-Host ('bytes:   ' + $size)
Write-Host ('sha256:  ' + (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash)