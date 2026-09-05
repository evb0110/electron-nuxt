<#
.SYNOPSIS
    Registers the logon scheduled task that starts the guest worker in the interactive session.
.DESCRIPTION
    Provisioning step, run once by an administrator while building the guest image. It is not part of
    a test run and the guest worker never calls it.

    Invariant I9 requires the worker to hold an interactive token on the Default desktop of the test
    user's session. A service or a Session 0 task cannot drive the application, so the task is
    registered with an at-logon trigger, an Interactive logon type and the Limited run level: Task
    Scheduler then starts the worker with the token the user already has after signing in.

    The script contains no credentials and never asks for a password. Interactive logon type reuses
    the existing session token, so no stored secret is needed. Configure automatic sign-in for the
    test account through image provisioning, not here.

    Usage (elevated PowerShell on the image being provisioned):
        powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass `
            -File register-worker-logon-task.ps1 `
            -UserName EVB\tester -NodeExecutable C:\EVBViewerTests\node\node.exe `
            -WorkerScript C:\EVBViewerTests\worker\guestWorker.cjs -GuestRoot C:\EVBViewerTests

    Exit codes: 0 success, 2 missing input, 3 registration failed.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$UserName,

    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,

    [Parameter(Mandatory = $true)]
    [string]$WorkerScript,

    [string]$GuestRoot = 'C:\EVBViewerTests',

    [string]$TaskName = 'EVB Windows Test Worker',

    [string]$WorkingDirectory = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    [Console]::Error.WriteLine("Node executable not found: $NodeExecutable")
    exit 2
}
if (-not (Test-Path -LiteralPath $WorkerScript -PathType Leaf)) {
    [Console]::Error.WriteLine("Worker bundle not found: $WorkerScript")
    exit 2
}
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = Split-Path -Parent $WorkerScript
}

$arguments = '"{0}" --root="{1}"' -f $WorkerScript, $GuestRoot
$action = New-ScheduledTaskAction -Execute $NodeExecutable -Argument $arguments -WorkingDirectory $WorkingDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $UserName
$principal = New-ScheduledTaskPrincipal -UserId $UserName -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -DontStopOnIdleEnd `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval ([TimeSpan]::FromMinutes(1)) `
    -StartWhenAvailable

try {
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -Principal $principal `
        -Settings $settings `
        -Description 'Starts the EVB Windows test worker in the interactive session of the test user (invariant I9).' `
        -Force | Out-Null
}
catch {
    [Console]::Error.WriteLine("Failed to register $TaskName : $($_.Exception.Message)")
    exit 3
}

$payload = [ordered]@{
    registered       = $true
    taskName         = $TaskName
    userId           = $UserName
    logonType        = 'Interactive'
    runLevel         = 'Limited'
    execute          = $NodeExecutable
    arguments        = $arguments
    workingDirectory = $WorkingDirectory
}

ConvertTo-Json -InputObject $payload -Depth 4 -Compress
exit 0
