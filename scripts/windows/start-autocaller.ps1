param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path,
    [string]$LogPath = (Join-Path (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path "logs\autocaller.log")
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path $RepoPath).Path
$logDirectory = Split-Path $LogPath -Parent
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$envFile = Join-Path $repoRoot ".env"
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*#' -or [string]::IsNullOrWhiteSpace($_)) {
            return
        }

        $parts = $_ -split '=', 2
        if ($parts.Count -lt 2) {
            return
        }

        $key = $parts[0].Trim()
        $value = $parts[1].Trim()
        if (-not [string]::IsNullOrWhiteSpace($key)) {
            [System.Environment]::SetEnvironmentVariable($key, $value, "Process")
        }
    }
}

Set-Location $repoRoot

$nodeCommand = Get-Command node -ErrorAction Stop | Select-Object -ExpandProperty Source

$process = Start-Process -FilePath $nodeCommand -ArgumentList "server.js" -WorkingDirectory $repoRoot -PassThru -RedirectStandardOutput $LogPath -RedirectStandardError $LogPath -NoNewWindow

Write-Output "AutoCaller started with PID $($process.Id)"
