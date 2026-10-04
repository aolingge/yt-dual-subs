#requires -Version 5.1

[CmdletBinding()]
param(
    [string]$EdgePath,
    [string]$ProfilePath = (Join-Path $env:TEMP "ytds-real-restart-20261002-a"),
    [string]$ExtensionPath = (Resolve-Path (Join-Path $PSScriptRoot "..")),
    [int]$RemoteDebuggingPort = 9345,
    [switch]$RestoreLastSession,
    [switch]$AllowTestAudio
)

$ErrorActionPreference = "Stop"

if (-not $EdgePath) {
    $candidates = @(
        (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe"),
        (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe")
    )
    $EdgePath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

if (-not $EdgePath -or -not (Test-Path -LiteralPath $EdgePath)) {
    throw "Microsoft Edge executable not found. Pass -EdgePath explicitly."
}
if (-not (Test-Path -LiteralPath $ExtensionPath -PathType Container)) {
    throw "Extension directory not found: $ExtensionPath"
}

$edgeArguments = @(
    "--user-data-dir=$ProfilePath"
    "--no-first-run"
    "--no-default-browser-check"
    "--disable-extensions-except=$ExtensionPath"
    "--load-extension=$ExtensionPath"
    "--remote-debugging-port=$RemoteDebuggingPort"
    "--headless=new"
    "--disable-gpu"
    "--window-size=1280,900"
)
if (-not $AllowTestAudio) {
    $edgeArguments += "--mute-audio"
}
if ($RestoreLastSession) {
    $edgeArguments += "--restore-last-session"
}

# Keep each switch as its own argument. Passing one space-joined string makes
# Windows treat --user-data-dir=... as a program name in some Start-Process paths.
Start-Process -FilePath $EdgePath -ArgumentList $edgeArguments -WorkingDirectory (Split-Path -Parent $EdgePath) -WindowStyle Hidden | Out-Null
Write-Output ("Started Edge with profile {0} on CDP port {1}." -f $ProfilePath, $RemoteDebuggingPort)
