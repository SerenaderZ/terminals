#Requires -Version 5.1
<#
.SYNOPSIS
    Build a fnOS installable package (.fpk) for TerminalS.

.DESCRIPTION
    Uses the official fnpack tool, not a hand-rolled tar: the format has
    requirements (checksums, file order, permissions) that are easy to get
    subtly wrong by hand.

    ASCII only: Windows PowerShell 5.1 reads .ps1 as ANSI without a BOM.

.EXAMPLE
    .\tools\pack.ps1              # x86 only
    .\tools\pack.ps1 -Arch both   # x86 + arm64
#>
[CmdletBinding()]
param(
    [ValidateSet("x86", "arm", "both")][string]$Arch = "x86",
    [switch]$SkipBuild,
    [switch]$SkipIcons
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$Go = Join-Path $Root ".tools\go\bin\go.exe"
$Fnpack = Join-Path $Root ".tools\fnpack.exe"
$PkgSrc = Join-Path $Root "package"
$BuildDir = Join-Path $Root ".build"
$DistDir = Join-Path $Root "dist"

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m) { Write-Host "OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "!!  $m" -ForegroundColor Red; exit 1 }

if (-not (Test-Path $Fnpack)) { Fail "missing .tools\fnpack.exe (official fnOS packer)" }
if (-not $SkipIcons) {
    if (-not (Test-Path $Go)) { Fail "missing .tools\go\bin\go.exe" }
    Write-Step "Generating icons"
    & $Go run ./tools/icongen .
    if ($LASTEXITCODE -ne 0) { Fail "icon generation failed" }
}

# ---------------------------------------------------------------- build binary

if (-not $SkipBuild) {
    if (-not (Test-Path $Go)) { Fail "missing .tools\go\bin\go.exe" }
    Write-Step "Cross-compiling"
    $env:CGO_ENABLED = "0"
    $env:GOTOOLCHAIN = "local"
    $env:GOOS = "linux"
    $targets = @{ "amd64" = "dist\tsd-linux-amd64"; "arm64" = "dist\tsd-linux-arm64" }
    foreach ($t in $targets.Keys) {
        $env:GOARCH = $t
        & $Go build -trimpath -ldflags "-s -w" -o $targets[$t] ./cmd/tsd
        if ($LASTEXITCODE -ne 0) { Fail "build failed for $t" }
        Write-Ok "$t -> $($targets[$t])"
    }
    $env:GOOS = ""
    $env:GOARCH = ""
}

# ---------------------------------------------------------------- helpers

function Get-ManifestValue {
    param([string]$File, [string]$Key)
    foreach ($line in Get-Content -LiteralPath $File -Encoding UTF8) {
        if ($line -match "^\s*$([regex]::Escape($Key))\s*=(.*)$") { return $Matches[1].Trim() }
    }
    return $null
}

function Set-ManifestValue {
    param([string]$File, [string]$Key, [string]$Value)
    $lines = Get-Content -LiteralPath $File -Encoding UTF8
    $found = $false
    $out = foreach ($l in $lines) {
        if ($l -match "^\s*$([regex]::Escape($Key))\s*=") { $found = $true; "$Key=$Value" } else { $l }
    }
    if (-not $found) { $out = $out + "$Key=$Value" }
    [System.IO.File]::WriteAllLines($File, $out, (New-Object System.Text.UTF8Encoding($false)))
}

$Version = Get-ManifestValue (Join-Path $PkgSrc "manifest") "version"
if (-not $Version) { Fail "manifest has no version" }

# ---------------------------------------------------------------- pack

function Invoke-Pack {
    param([string]$ArchName)

    $bin = if ($ArchName -eq "x86") { "dist\tsd-linux-amd64" } else { "dist\tsd-linux-arm64" }
    if (-not (Test-Path $bin)) { Fail "$bin missing; run without -SkipBuild" }

    $stage = Join-Path $BuildDir "terminals-$ArchName"
    Write-Step "Staging $ArchName"

    # .NET delete instead of Remove-Item: some shells hook Remove-Item with a
    # "safe delete" wrapper that fails on large trees and aborts the pack.
    if (Test-Path $stage) { [System.IO.Directory]::Delete($stage, $true) }
    New-Item -ItemType Directory -Force -Path $stage | Out-Null
    Copy-Item -Path (Join-Path $PkgSrc "*") -Destination $stage -Recurse -Force

    $binDir = Join-Path $stage "app\bin"
    New-Item -ItemType Directory -Force -Path $binDir | Out-Null
    Copy-Item -Path (Join-Path $Root $bin) -Destination (Join-Path $binDir "tsd") -Force

    Set-ManifestValue (Join-Path $stage "manifest") "platform" $ArchName
    Set-ManifestValue (Join-Path $stage "manifest") "version" $Version

    # Guard the classic Windows-packing failure: CRLF inside shell scripts makes
    # the app install fine and then refuse to start with a cryptic interpreter error.
    $bad = @()
    Get-ChildItem -Path (Join-Path $stage "cmd") -File | ForEach-Object {
        $bytes = [System.IO.File]::ReadAllBytes($_.FullName)
        if ($bytes -contains 13) { $bad += $_.Name }
    }
    if ($bad.Count -gt 0) { Fail ("CRLF found in: " + ($bad -join ", ")) }

    Write-Step "fnpack build ($ArchName)"
    $out = & $Fnpack build --directory $stage 2>&1
    $out | ForEach-Object { Write-Host "    $_" }
    if ($LASTEXITCODE -ne 0) { Fail "fnpack failed (exit $LASTEXITCODE)" }

    $fpk = Get-ChildItem -Path $Root, $BuildDir, $DistDir, $stage -Filter *.fpk -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $fpk) { Fail "fnpack reported success but no .fpk was found" }

    New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
    $final = Join-Path $DistDir ("terminals_{0}_{1}.fpk" -f $Version, $ArchName)
    if (Test-Path $final) { [System.IO.File]::Delete($final) }
    Move-Item $fpk.FullName $final

    # fnpack.exe on Windows writes every tar entry as 0666 because NTFS has no
    # executable bit. Without this step cmd/main is not executable on the NAS and
    # the app installs fine then refuses to start. Linux builds are unaffected
    # (the fixer is idempotent).
    if (-not (Test-Path $Go)) { Fail "missing .tools\go\bin\go.exe (needed for fpkfix)" }
    Write-Step "Fixing file modes inside the package"
    & $Go run ./tools/fpkfix -in $final
    if ($LASTEXITCODE -ne 0) { Fail "fpkfix failed" }

    $mb = [math]::Round((Get-Item $final).Length / 1MB, 1)
    Write-Ok "$final ($mb MB)"
}

if ($Arch -eq "both") {
    Invoke-Pack "x86"
    Invoke-Pack "arm"
} else {
    Invoke-Pack $Arch
}

Write-Host ""
Write-Host "Install: fnOS App Center -> Settings -> Manual install -> pick the .fpk" -ForegroundColor Cyan
Write-Host "Pick x86 for N100/N305/Intel/AMD, arm for RK3588/ARM boards." -ForegroundColor DarkGray
