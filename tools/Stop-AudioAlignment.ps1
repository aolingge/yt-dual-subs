$ErrorActionPreference = 'Stop'
$taskPidFile = Join-Path $env:LOCALAPPDATA 'YT Dual Subs\audio-alignment\helper.pid'
$taskServerPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'audio-alignment\server.py'))
# Match by command line, not only by the recorded PID: a helper started twice (or by
# hand) would otherwise survive and keep serving the same port.
$taskStopped = @()
$taskArgumentPattern = '(?i)(?:^|\s)"?' + [Regex]::Escape($taskServerPath) + '"?(?=\s|$)'
Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and ([IO.Path]::GetFileName($_.ExecutablePath) -in 'python.exe','pythonw.exe') -and
    $_.CommandLine -and $_.CommandLine -match $taskArgumentPattern
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    $taskStopped += $_.ProcessId
}
Remove-Item -LiteralPath $taskPidFile -ErrorAction SilentlyContinue
if ($taskStopped.Count) { Write-Output ('Audio alignment stopped. PIDs: ' + ($taskStopped -join ', ')) }
else { Write-Output 'No audio alignment helper is running.' }
