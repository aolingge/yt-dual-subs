#requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputRoot = (Join-Path (Split-Path -Parent $PSScriptRoot) "..\yt-dual-subs-release")
)
$ErrorActionPreference = "Stop"
$Root = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot)).TrimEnd('\', '/')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\', '/')
if ($OutputRoot -eq $Root -or $OutputRoot.StartsWith($Root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Release output must be outside the source folder.'
}
$Manifest = Get-Content -LiteralPath (Join-Path $Root "manifest.json") -Raw | ConvertFrom-Json
$RunRoot = Join-Path $OutputRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
$Stage = Join-Path $RunRoot ("yt-dual-subs-" + $Manifest.version)
$Zip = Join-Path $RunRoot ("yt-dual-subs-" + $Manifest.version + ".zip")
$Files = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($x in @('manifest.json','LICENSE','README.md','README.zh-CN.md',
  '_locales/en/messages.json','_locales/zh_CN/messages.json','_locales/zh_TW/messages.json',
  'tools/Start-AudioAlignment.cmd','tools/Start-AudioAlignment.ps1','tools/Stop-AudioAlignment.ps1',
  'tools/audio-alignment/server.py','tools/audio-alignment/requirements.txt')) { $Files.Add($x) | Out-Null }
# Runtime assets are kept at the source root. Include all of them, including
# transitive worker imports and the AudioWorklet; never copy profiles/caches.
foreach ($item in Get-ChildItem -LiteralPath $Root -File | Where-Object { $_.Extension -in '.js','.html','.css' }) { $Files.Add($item.Name) | Out-Null }
$DocsPrefix = (Join-Path $Root 'docs').TrimEnd('\') + '\'
foreach ($item in Get-ChildItem -LiteralPath (Join-Path $Root 'docs') -Recurse -File | Where-Object { $_.Extension -in '.md','.png','.svg','.jpg','.webp' }) {
  $Files.Add('docs/' + $item.FullName.Substring($DocsPrefix.Length).Replace('\', '/')) | Out-Null
}
$Files.Add($Manifest.background.service_worker) | Out-Null
foreach ($entry in $Manifest.content_scripts) {
  foreach ($x in (@($entry.js) + @($entry.css) | Where-Object { $_ })) { $Files.Add($x) | Out-Null }
}
foreach ($x in @($Manifest.icons.PSObject.Properties.Value)) { $Files.Add($x) | Out-Null }
foreach ($x in @($Manifest.action.default_icon.PSObject.Properties.Value)) { $Files.Add($x) | Out-Null }
$Missing = [System.Collections.Generic.List[string]]::new()
foreach ($rel in $Files) {
  $src = Join-Path $Root $rel
  if (!(Test-Path -LiteralPath $src -PathType Leaf)) { $Missing.Add($rel); continue }
}
if ($Missing.Count -gt 0) { throw ('Missing release files: ' + ($Missing -join ', ')) }
New-Item -ItemType Directory -Path $Stage | Out-Null
foreach ($rel in $Files) {
  $src = Join-Path $Root $rel
  $dest = Join-Path $Stage $rel
  New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
  Copy-Item -LiteralPath $src -Destination $dest -Force
}
if (@($Missing | Where-Object { $_ -and $_.Trim() }).Count -gt 0) { throw ("Missing release files: " + (($Missing | Where-Object { $_ -and $_.Trim() }) -join ", ")) }
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$StagePrefix = (Resolve-Path -LiteralPath $Stage).Path.TrimEnd("\") + "\"
$List = Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object { $_.FullName.Substring($StagePrefix.Length).Replace("\", "/") } | Sort-Object
# PowerShell 5 Compress-Archive writes backslashes into entry names. Write
# canonical ZIP names explicitly so both Windows PowerShell and pwsh work.
$Writer = [System.IO.Compression.ZipFile]::Open($Zip, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  foreach ($rel in $List) {
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($Writer, (Join-Path $Stage $rel), $rel, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
  }
} finally { $Writer.Dispose() }
$Archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)
try { $ZipList = $Archive.Entries | Where-Object { $_.Name } | ForEach-Object FullName | Sort-Object }
finally { $Archive.Dispose() }
if (Compare-Object $List $ZipList) { throw "ZIP file list mismatch" }
$Hash = (Get-FileHash -LiteralPath $Zip -Algorithm SHA256).Hash
[pscustomobject]@{ Zip = $Zip; Files = $List.Count; Bytes = (Get-Item -LiteralPath $Zip).Length; SHA256 = $Hash; Missing = @($Missing | Where-Object { $_ -and $_.Trim() }).Count } | ConvertTo-Json
