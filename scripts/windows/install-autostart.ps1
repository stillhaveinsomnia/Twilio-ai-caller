param(
    [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot "..\..\")).Path,
    [string]$TaskName = "AutoCaller"
)

$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $RepoPath "scripts\windows\start-autocaller.ps1"

if (-not (Test-Path $scriptPath)) {
    throw "Launcher script not found: $scriptPath"
}

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File \"$scriptPath\""
$trigger = New-ScheduledTaskTrigger -AtLogOn

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Force

Write-Output "Scheduled task '$TaskName' registered to start on user logon."
