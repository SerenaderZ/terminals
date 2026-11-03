#Requires -Version 5.1
<#
.SYNOPSIS
    Deploy TerminalS to fnOS (or any Linux box) for on-device validation.

.DESCRIPTION
    This is a manual deployment helper, NOT an fpk packager. The point is to get
    the binary onto the NAS and validate real-world behaviour in minutes, instead
    of spending a day on app-center integration first.

    Default mode is SSH tunnel (server listens on 127.0.0.1 only), because the
    server has no built-in login: binding 0.0.0.0 hands your shell to the whole
    subnet.

    File must stay ASCII-only: Windows PowerShell 5.1 reads .ps1 as ANSI unless
    there is a BOM, and non-ASCII comments break parsing.

.EXAMPLE
    .\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Check

.EXAMPLE
    .\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Start -Backend tmux

.EXAMPLE
    .\tools\deploy.ps1 -Server 192.0.2.10 -User admin -Stop
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Server,
    [string]$User = "root",
    [int]$Port = 22,
    [string]$RemoteDir = "/opt/terminals",
    [string]$Listen = "127.0.0.1:18086",
    [ValidateSet("native", "tmux")][string]$Backend = "native",
    [string]$RunAs = "",

    # Run --check only, do not start. Recommended on first deploy.
    [switch]$Check,
    # Start the service (default action).
    [switch]$Start,
    # Stop the running instance.
    [switch]$Stop,
    # Tail the remote log.
    [switch]$Logs,

    # Bind 0.0.0.0 so the LAN can reach it directly. Prints a loud warning.
    [switch]$Lan
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Target = "$User@$Server"
$SshOpts = @("-p", "$Port", "-o", "StrictHostKeyChecking=accept-new")

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Write-Ok($msg) { Write-Host "OK  $msg" -ForegroundColor Green }

function Invoke-Remote {
    param([string]$Script)
    return (& ssh @SshOpts $Target $Script 2>&1)
}

# ---------------------------------------------------------------- preflight

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    throw "ssh not found. Install the OpenSSH Client optional feature on Windows 10+."
}
if (-not (Get-Command scp -ErrorAction SilentlyContinue)) {
    throw "scp not found."
}

if ($Lan) {
    $Listen = "0.0.0.0:" + ($Listen -split ":")[-1]
    Write-Warn "Listening on 0.0.0.0 - the server has NO built-in login."
    Write-Warn "Anyone on the same subnet gets your shell. Stop it right after testing."
}

# ---------------------------------------------------------------- remote arch

Write-Step "Detecting remote architecture"
$uname = ((Invoke-Remote "uname -m") -join "").Trim()
Write-Host "    uname -m = $uname"

switch -Regex ($uname) {
    "^x86_64$"  { $artifact = "dist/tsd-linux-amd64" }
    "^aarch64$" { $artifact = "dist/tsd-linux-arm64" }
    "^arm64$"   { $artifact = "dist/tsd-linux-arm64" }
    default     { throw "Unsupported architecture: $uname (only linux amd64/arm64 are built)" }
}

$localPath = Join-Path $ProjectRoot $artifact
if (-not (Test-Path $localPath)) {
    throw "$artifact missing. Run tools\build.ps1 first."
}
$sizeMB = [math]::Round((Get-Item $localPath).Length / 1MB, 1)
Write-Ok "$artifact ($sizeMB MB)"

# ---------------------------------------------------------------- stop / logs

if ($Stop) {
    Write-Step "Stopping remote instance"
    $r = Invoke-Remote "pkill -f '$RemoteDir/tsd' 2>/dev/null; sleep 1; pgrep -af '$RemoteDir/tsd' || echo STOPPED"
    $r | ForEach-Object { Write-Host "    $_" }
    Write-Ok "stopped"
    return
}

if ($Logs) {
    Write-Step "Remote log (Ctrl+C to exit)"
    & ssh @SshOpts $Target "tail -f $RemoteDir/tsd.log"
    return
}

# ---------------------------------------------------------------- upload

Write-Step "Uploading binary"
$tmpRemote = "/tmp/tsd-upload-$PID"
& scp -P $Port -o StrictHostKeyChecking=accept-new $localPath "${Target}:$tmpRemote"
if ($LASTEXITCODE -ne 0) { throw "scp failed (exit $LASTEXITCODE)" }

$install = @'
set -e
mkdir -p __DIR__
if pgrep -f "__DIR__/tsd" >/dev/null 2>&1; then
  pkill -f "__DIR__/tsd" || true
  sleep 1
fi
cp __TMP__ __DIR__/tsd
chmod 755 __DIR__/tsd
rm -f __TMP__
echo "installed: __DIR__/tsd"
'@
$install = $install.Replace("__DIR__", $RemoteDir).Replace("__TMP__", $tmpRemote)

$r = Invoke-Remote $install
$r | ForEach-Object { Write-Host "    $_" }
if (($r -join "") -notmatch "installed") { throw "remote install failed" }
Write-Ok "installed to $RemoteDir/tsd"

# ---------------------------------------------------------------- self-check

Write-Step "Remote self-check"
$checkArgs = "--check --listen $Listen --backend $Backend --data-dir $RemoteDir/data"
if ($RunAs -ne "") { $checkArgs += " --run-as $RunAs" }
$r = Invoke-Remote "$RemoteDir/tsd $checkArgs"
$r | ForEach-Object { Write-Host "    $_" }

if ($Check) {
    return
}

# ---------------------------------------------------------------- start

Write-Step "Starting service"
$startArgs = "--listen $Listen --backend $Backend --data-dir $RemoteDir/data"
if ($RunAs -ne "") { $startArgs += " --run-as $RunAs" }

$start = @'
set -e
cd __DIR__
setsid nohup ./tsd __ARGS__ > __DIR__/tsd.log 2>&1 < /dev/null &
sleep 1.5
if pgrep -f "__DIR__/tsd" >/dev/null 2>&1; then
  echo "started pid=$(pgrep -f '__DIR__/tsd' | head -1)"
else
  echo "FAILED"
  tail -20 __DIR__/tsd.log
  exit 1
fi
'@
$start = $start.Replace("__DIR__", $RemoteDir).Replace("__ARGS__", $startArgs)

$r = Invoke-Remote $start
$r | ForEach-Object { Write-Host "    $_" }
if (($r -join "") -notmatch "started pid=") { throw "start failed, see log above" }
Write-Ok "running in background"

# ---------------------------------------------------------------- access

$svcPort = ($Listen -split ":")[-1]
Write-Host ""
Write-Host "---------------- how to open ----------------" -ForegroundColor Cyan

if ($Listen -like "0.0.0.0*") {
    Write-Host "  open      http://${Server}:$svcPort/"
    Write-Warn "bound to all interfaces with no login - run -Stop as soon as you are done"
}
else {
    Write-Host "  step 1 (in another local terminal, keep it open):"
    Write-Host "      ssh -p $Port -N -L ${svcPort}:127.0.0.1:${svcPort} $Target" -ForegroundColor White
    Write-Host "  step 2 (browser):"
    Write-Host "      http://127.0.0.1:$svcPort/" -ForegroundColor White
}

Write-Host ""
Write-Host "  logs      .\tools\deploy.ps1 -Server $Server -User $User -Logs"
Write-Host "  stop      .\tools\deploy.ps1 -Server $Server -User $User -Stop"
Write-Host ""
Write-Warn "While you are there, run 'tmux -V' on the NAS and note the version."
Write-Warn "The tmux backend needs 3.3+ for allow-passthrough to actually work."
