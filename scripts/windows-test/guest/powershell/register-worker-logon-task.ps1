<#
.SYNOPSIS
    Registers the logon scheduled task that starts the guest worker in the interactive session.
.DESCRIPTION
    Provisioning step, run once by an administrator while building the guest image. It is not part of
    a test run and the guest worker never calls it.

    Invariant I9 requires the worker to hold an interactive token on the Default desktop of the test
    user's session. A service or a Session 0 task cannot drive the application, so the task is
    registered with an at-logon trigger, an Interactive logon type and the Limited run level. Task
    Scheduler then starts PowerShell with the token the user already has after signing in. Before
    registration, this script runs disable-test-audio.ps1 as the administrator to disable and stop
    Audiosrv and configures Microsoft Print to PDF for A4 output. The PowerShell entry
    point validates the lab marker and account, verifies both policies, and supervises the worker.

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

    [string]$WorkingDirectory = '',

    [string]$StartScript = '',

    [string]$DisableScript = '',

    [string]$PrinterScript = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'test-lab-helpers.ps1')

if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
    [Console]::Error.WriteLine("Node executable not found: $NodeExecutable")
    exit 2
}
if (-not (Test-Path -LiteralPath $WorkerScript -PathType Leaf)) {
    [Console]::Error.WriteLine("Worker bundle not found: $WorkerScript")
    exit 2
}
if (-not (Test-Path -LiteralPath $GuestRoot -PathType Container)) {
    [Console]::Error.WriteLine("EVB guest root not found: $GuestRoot")
    exit 2
}
if ([string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $WorkingDirectory = Split-Path -Parent $WorkerScript
}
if ([string]::IsNullOrWhiteSpace($StartScript)) {
    $StartScript = Join-Path -Path $PSScriptRoot -ChildPath 'start-worker-logon.ps1'
}
if (-not (Test-Path -LiteralPath $StartScript -PathType Leaf)) {
    [Console]::Error.WriteLine("Worker logon entry point not found: $StartScript")
    exit 2
}
if ([string]::IsNullOrWhiteSpace($DisableScript)) {
    $DisableScript = Join-Path -Path $PSScriptRoot -ChildPath 'disable-test-audio.ps1'
}
if (-not (Test-Path -LiteralPath $DisableScript -PathType Leaf)) {
    [Console]::Error.WriteLine("Audio service provisioning helper not found: $DisableScript")
    exit 2
}
if ([string]::IsNullOrWhiteSpace($PrinterScript)) {
    $PrinterScript = Join-Path -Path $PSScriptRoot -ChildPath 'configure-test-printer.ps1'
}
if (-not (Test-Path -LiteralPath $PrinterScript -PathType Leaf)) {
    [Console]::Error.WriteLine("Printer policy helper not found: $PrinterScript")
    exit 2
}

$powerShellExecutable = Join-Path -Path $env:SystemRoot -ChildPath 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
    [Console]::Error.WriteLine("Windows PowerShell executable not found: $powerShellExecutable")
    exit 2
}

$disableArguments = Join-ProcessArguments @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $DisableScript,
    '-GuestRoot',
    $GuestRoot
)
try {
    $audioPolicyProcess = Start-Process -FilePath $powerShellExecutable -ArgumentList $disableArguments -WorkingDirectory $GuestRoot -WindowStyle Hidden -PassThru -Wait
} catch {
    [Console]::Error.WriteLine("Audio service provisioning helper could not start: $($_.Exception.Message)")
    exit 3
}
if ($audioPolicyProcess.ExitCode -ne 0) {
    [Console]::Error.WriteLine("Audio service provisioning helper failed with exit code $($audioPolicyProcess.ExitCode)")
    exit $(if ($audioPolicyProcess.ExitCode -eq 2) { 2 } else { 3 })
}

$printerArguments = Join-ProcessArguments @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    $PrinterScript,
    '-GuestRoot',
    $GuestRoot,
    '-Configure'
)
try {
    $printerPolicyProcess = Start-Process -FilePath $powerShellExecutable -ArgumentList $printerArguments -WorkingDirectory $GuestRoot -WindowStyle Hidden -PassThru -Wait
} catch {
    [Console]::Error.WriteLine("Printer policy provisioning helper could not start: $($_.Exception.Message)")
    exit 3
}
if ($printerPolicyProcess.ExitCode -ne 0) {
    [Console]::Error.WriteLine("Printer policy provisioning helper failed with exit code $($printerPolicyProcess.ExitCode)")
    exit $(if ($printerPolicyProcess.ExitCode -eq 2) { 2 } else { 3 })
}

$arguments = Join-ProcessArguments @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    $StartScript,
    '-NodeExecutable',
    $NodeExecutable,
    '-WorkerScript',
    $WorkerScript,
    '-GuestRoot',
    $GuestRoot,
    '-ExpectedUserName',
    $UserName,
    '-PrinterScript',
    $PrinterScript
)
$action = New-ScheduledTaskAction -Execute $powerShellExecutable -Argument $arguments -WorkingDirectory $WorkingDirectory
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
        -Description 'Validates the EVB lab session, verifies disabled Audiosrv and A4 printer policy, and starts the Windows test worker in the interactive session of the test user (invariant I9).' `
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
    execute          = $powerShellExecutable
    arguments        = $arguments
    workingDirectory = $WorkingDirectory
    startScript      = $StartScript
    disableScript    = $DisableScript
    printerScript    = $PrinterScript
    nodeExecutable   = $NodeExecutable
    workerScript     = $WorkerScript
}

ConvertTo-Json -InputObject $payload -Depth 4 -Compress
exit 0
