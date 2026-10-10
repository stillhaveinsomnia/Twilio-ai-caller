param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path,
    [string]$Remote = "origin",
    [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path $RepoPath).Path
$startScript = Join-Path $repoRoot "scripts\windows\start-autocaller.ps1"

if (-not (Test-Path (Join-Path $repoRoot ".git"))) {
    throw "This directory is not a Git repository: $repoRoot"
}

Write-Host "Pulling latest changes from $Remote/$Branch..."
Set-Location $repoRoot

git fetch --all --prune
if (-not (git rev-parse --verify $Branch 2>$null)) {
    throw "Branch '$Branch' does not exist locally."
}
git checkout $Branch
git pull --ff-only $Remote $Branch

if (-not (Test-Path (Join-Path $repoRoot ".env"))) {
    Write-Host "No .env file found; keeping existing environment configuration on the host."
}

Write-Host "Installing dependencies..."
npm ci

Write-Host "Running validation tests..."
npm test

Write-Host "Restarting AutoCaller..."
Get-CimInstance Win32_Process | Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match "server\.js" } | ForEach-Object {
    $_.Terminate() | Out-Null
}

Start-Process -FilePath "powershell.exe" -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File \"$startScript\"" -WorkingDirectory $repoRoot

Write-Host "Deployment completed successfully."
