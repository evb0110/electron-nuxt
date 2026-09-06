<#
.SYNOPSIS
    Permanently disables and stops Windows Audio in the isolated EVB test image.
.DESCRIPTION
    Provisioning step, run once by an administrator after the lab marker is written. The helper
    changes only the Audiosrv service startup policy and current state. It keeps the virtual audio
    hardware in place, records the verified policy under state\audio-service-policy.json, and
    refuses to report success unless the service is both Disabled and Stopped.

    Exit codes: 0 when the policy is verified, 2 for a missing or invalid lab marker or a
    non-administrator caller, and 3 for service or verification failure.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GuestRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'test-lab-helpers.ps1')

$stateDirectory = Join-Path -Path $GuestRoot -ChildPath 'state'
$policyPath = Join-Path -Path $stateDirectory -ChildPath 'audio-service-policy.json'
$serviceName = 'Audiosrv'

function Write-PolicyOutcome([object]$Payload) {
    try {
        if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
            [Console]::Error.WriteLine("Cannot record audio policy because state directory is missing: $stateDirectory")
            return $false
        }
        $temporaryPath = Join-Path -Path $stateDirectory -ChildPath ('.audio-service-policy.{0}.tmp' -f $PID)
        try {
            ConvertTo-Json -InputObject $Payload -Depth 8 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            Move-Item -LiteralPath $temporaryPath -Destination $policyPath -Force
        } finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        return $true
    } catch {
        [Console]::Error.WriteLine("Cannot record audio policy at $policyPath : $($_.Exception.Message)")
        return $false
    }
}

function Write-Failure([string]$Reason, [int]$ExitCode) {
    $payload = [ordered]@{
        schemaVersion = 1
        status        = 'failed'
        phase         = 'audio-service-policy'
        reason        = $Reason
        service       = $serviceName
        capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }
    [void](Write-PolicyOutcome $payload)
    [Console]::Error.WriteLine($Reason)
    exit $ExitCode
}

try {
    if (-not (Test-Path -LiteralPath $GuestRoot -PathType Container)) {
        throw "EVB guest root is missing: $GuestRoot"
    }
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
        throw "EVB guest state directory is missing: $stateDirectory"
    }
    $marker = Get-LabMarker -StateDirectory $stateDirectory
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'audio service provisioning requires an administrator token'
    }
} catch {
    Write-Failure $_.Exception.Message 2
}

try {
    $service = Get-Service -Name $serviceName -ErrorAction Stop
    Set-Service -Name $serviceName -StartupType Disabled -ErrorAction Stop
    if ($service.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped) {
        Stop-Service -Name $serviceName -Force -ErrorAction Stop
    }
} catch {
    Write-Failure "Cannot disable and stop $serviceName : $($_.Exception.Message)" 3
}

try {
    $verified = Get-CimInstance -ClassName Win32_Service -Filter ("Name = '{0}'" -f $serviceName) | Select-Object -First 1
} catch {
    Write-Failure "Cannot verify $serviceName : $($_.Exception.Message)" 3
}
if ($null -eq $verified) {
    Write-Failure "$serviceName was not found during verification" 3
}

$startMode = [string]$verified.StartMode
$state = [string]$verified.State
$outcome = [ordered]@{
    schemaVersion    = 1
    status           = if ($startMode -ceq 'Disabled' -and $state -ceq 'Stopped') { 'audio-service-disabled' } else { 'failed' }
    phase            = 'audio-service-policy'
    capturedAt       = (Get-Date).ToUniversalTime().ToString('o')
    service          = $serviceName
    serviceStartMode = $startMode
    serviceState     = $state
    userSid          = $identity.User.Value
    userName         = $identity.Name
    marker           = [ordered]@{
        imageId         = [string]$marker.imageId
        guestTestMarker = [string]$marker.guestTestMarker
    }
}
if ($outcome.status -ne 'audio-service-disabled') {
    $outcome.reason = 'service must have StartMode Disabled and State Stopped'
}
if (-not (Write-PolicyOutcome $outcome)) {
    [Console]::Error.WriteLine('Audio service policy outcome was not recorded; refusing to report success.')
    exit 3
}
ConvertTo-Json -InputObject $outcome -Depth 8 -Compress
if ($outcome.status -ne 'audio-service-disabled') {
    [Console]::Error.WriteLine("$serviceName policy verification failed: StartMode=$startMode State=$state")
    exit 3
}
exit 0
