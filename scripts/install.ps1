# Installs or updates Curator on Windows from the latest GitHub release, and connects it to Claude Code.
#   irm https://raw.githubusercontent.com/BostelJ/curator/main/scripts/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is very slow with its progress bar
$repo = 'BostelJ/curator'

function Say($text) { Write-Host $text -ForegroundColor White }

if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'This installer is for Windows. On a Mac, use scripts/install.sh.' }
if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Curator needs Windows 10 (1809) or Windows 11.' }

Say 'Finding the latest release...'
$release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'curator-installer' }
$asset = $release.assets | Where-Object { $_.name -like 'Curator-Setup-*.exe' } | Select-Object -First 1
if (-not $asset) { throw "The latest release ($($release.tag_name)) has no Windows installer." }

$work = Join-Path ([IO.Path]::GetTempPath()) ("curator-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $setup = Join-Path $work $asset.name
  Say "Downloading Curator $($release.tag_name)..."
  Invoke-WebRequest $asset.browser_download_url -OutFile $setup -Headers @{ 'User-Agent' = 'curator-installer' }

  # Close a running copy so it can be replaced.
  Get-Process Curator -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500

  Say 'Installing...'
  Start-Process $setup -ArgumentList '/S' -Wait
} finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Join-Path $env:LOCALAPPDATA 'Programs\Curator\Curator.exe'
if (-not (Test-Path $exe)) { throw "The installer finished, but $exe isn't there." }
Say "Installed $exe"

# Connect to Claude Code: the MCP server `curator` at user scope, plus its skill.
# Curator.exe is a windowed program, so PowerShell only waits for it (and gets its words) through Start-Process.
$script = Join-Path (Split-Path $exe) 'resources\app\src\connect.js'
$out = [IO.Path]::GetTempFileName()
$err = [IO.Path]::GetTempFileName()
$env:ELECTRON_RUN_AS_NODE = '1'
try {
  Start-Process $exe -ArgumentList "`"$script`"" -Wait -NoNewWindow -RedirectStandardOutput $out -RedirectStandardError $err
  Get-Content $out, $err | Where-Object { $_ } | ForEach-Object { Say $_ }
} finally {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item $out, $err -ErrorAction SilentlyContinue
}

Start-Process $exe
Say 'Done. Curator is in the system tray (the tilted print; it may be under the ^ arrow). Ctrl+Alt+G opens the art gallery.'
