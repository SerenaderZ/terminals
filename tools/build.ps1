# Cross-compile for fnOS (Linux).
#
# Only uses Go's built-in cross compilation: no Docker, no cross linker.
# The output is a static binary that runs directly on the NAS.
# ASCII only on purpose: PowerShell 5.1 reads .ps1 as ANSI and mangles non-ASCII.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$go = Join-Path $root '.tools\go\bin\go.exe'
if (-not (Test-Path $go)) {
    $cmd = Get-Command go -ErrorAction SilentlyContinue
    if ($cmd) {
        $go = $cmd.Source
    } else {
        throw "go not found. Put a portable toolchain in .tools\go or add Go to PATH."
    }
}

$env:CGO_ENABLED = '0'
$env:GOTOOLCHAIN = 'local'
if (-not $env:GOPROXY) { $env:GOPROXY = 'https://goproxy.cn,direct' }

New-Item -ItemType Directory -Force -Path (Join-Path $root 'dist') | Out-Null

$targets = @(
    @{ GOARCH = 'amd64'; Out = 'tsd-linux-amd64' },
    @{ GOARCH = 'arm64'; Out = 'tsd-linux-arm64' }
)

foreach ($t in $targets) {
    $env:GOOS = 'linux'
    $env:GOARCH = $t.GOARCH
    Write-Host "building $($t.Out) ..."
    & $go build -trimpath -ldflags '-s -w' -o (Join-Path $root "dist\$($t.Out)") ./cmd/tsd
    if ($LASTEXITCODE -ne 0) { throw "failed to build $($t.Out)" }
}

# Local debugging build for Windows
$env:GOOS = 'windows'
$env:GOARCH = 'amd64'
Write-Host "building tsd.exe (local dev) ..."
& $go build -o (Join-Path $root 'dist\tsd.exe') ./cmd/tsd

Write-Host ""
Get-ChildItem (Join-Path $root 'dist') | Format-Table Name, @{N = 'Size'; E = { '{0:N1} MB' -f ($_.Length / 1MB) } }
