param([switch]$SetupOnly, [switch]$Foreground)
$ErrorActionPreference = 'Stop'
$taskHelper = Join-Path $PSScriptRoot 'audio-alignment'
$taskEnvironment = Join-Path $taskHelper '.venv'
$taskPython = Join-Path $taskEnvironment 'Scripts\python.exe'
$taskServer = Join-Path $taskHelper 'server.py'
$taskCache = Join-Path $env:LOCALAPPDATA 'YT Dual Subs\audio-alignment'
New-Item -ItemType Directory -Path $taskCache -Force | Out-Null
if (-not (Test-Path -LiteralPath $taskPython)) {
    $taskBasePython = (Get-Command python -ErrorAction Stop).Source
    # Reuse an installed Torch while keeping new packages inside this venv.
    & $taskBasePython -m venv --system-site-packages $taskEnvironment
    if ($LASTEXITCODE -ne 0) { throw 'Could not create the local Python environment.' }
}
& $taskPython -c 'import importlib.util,sys; sys.exit(not all(importlib.util.find_spec(m) for m in sys.argv[1:]))' torch numpy transformers yt_dlp
if ($LASTEXITCODE -ne 0) {
    & $taskPython -m pip install -r (Join-Path $taskHelper 'requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency setup failed. See docs/AUDIO_ALIGNMENT.md.' }
}
if ($SetupOnly) { Write-Output 'Audio alignment dependencies are ready.'; exit }
if ($Foreground) { & $taskPython $taskServer; exit }
$taskHealth = $null
try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2 } catch { }
if ($taskHealth) {
    if ($taskHealth.ok -and $taskHealth.version -eq 1) { Write-Output ('Audio alignment is already running (cache: ' + $taskHealth.cacheDir + ').'); exit }
    throw 'Port 8765 is used by another program.'
}
$taskArguments = '"' + $taskServer + '"'
$taskOutput = Join-Path $taskCache 'helper.log'
$taskError = Join-Path $taskCache 'helper-error.log'
$taskProcess = Start-Process -FilePath $taskPython -ArgumentList $taskArguments -WindowStyle Hidden -PassThru -RedirectStandardOutput $taskOutput -RedirectStandardError $taskError
$taskProcess.Id | Set-Content -LiteralPath (Join-Path $taskCache 'helper.pid')
# Confirm the helper answers before reporting success: a duplicate instance or a broken
# dependency would otherwise look like a successful start.
$taskReady = $false
for ($taskTry = 0; $taskTry -lt 20; $taskTry++) {
    Start-Sleep -Milliseconds 500
    try { $taskHealth = Invoke-RestMethod -Uri 'http://127.0.0.1:8765/health' -TimeoutSec 2 } catch { $taskHealth = $null }
    if ($taskHealth -and $taskHealth.ok) { $taskReady = $true; break }
    if ($taskProcess.HasExited) { break }
}
if (-not $taskReady) { throw ('Audio alignment did not start. See ' + $taskError + ' (cache: ' + $taskCache + ').') }
Write-Output ('Audio alignment started. PID: ' + $taskProcess.Id + ' cache: ' + $taskCache)
