<#
.SYNOPSIS
    Verifies the permanent no-audio policy for the isolated EVB Windows test account.
.DESCRIPTION
    The administrator provisioning helper disables and stops Audiosrv. This logon-time check
    validates the lab marker and standard test-user context, then verifies that the service has
    stayed disabled and stopped. It writes the result to state\audio-mute.json before the worker
    is allowed to start.

    Exit codes: 0 when Audiosrv is disabled and stopped, 2 when the session or lab marker is
    invalid, and 3 when the service policy cannot be verified.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GuestRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedUserName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'test-lab-helpers.ps1')

$stateDirectory = Join-Path -Path $GuestRoot -ChildPath 'state'
$outcomePath = Join-Path -Path $stateDirectory -ChildPath 'audio-mute.json'

function Write-Outcome([object]$Payload) {
    try {
        if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
            [Console]::Error.WriteLine("Cannot record audio outcome because state directory is missing: $stateDirectory")
            return $false
        }
        $temporaryPath = Join-Path -Path $stateDirectory -ChildPath ('.audio-mute.{0}.tmp' -f $PID)
        try {
            ConvertTo-Json -InputObject $Payload -Depth 8 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            Move-Item -LiteralPath $temporaryPath -Destination $outcomePath -Force
        } finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        return $true
    } catch {
        [Console]::Error.WriteLine("Cannot record audio outcome at $outcomePath : $($_.Exception.Message)")
        return $false
    }
}

function Write-BlockedOutcome([string]$Reason, [int]$ExitCode = 2) {
    $payload = [ordered]@{
        schemaVersion = 1
        status        = 'blocked'
        phase         = 'startup-validation'
        reason        = $Reason
        capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }
    [void](Write-Outcome $payload)
    [Console]::Error.WriteLine($Reason)
    exit $ExitCode
}

function Assert-StandardTestContext {
    if (-not (Test-Path -LiteralPath $GuestRoot -PathType Container)) {
        throw "EVB guest root is missing: $GuestRoot"
    }
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
        throw "EVB guest state directory is missing: $stateDirectory"
    }
    $marker = Get-LabMarker -StateDirectory $stateDirectory
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $expectedSid = Resolve-AccountSid $ExpectedUserName
    if ($identity.User.Value -cne $expectedSid) {
        throw "scheduled task is running as $($identity.Name), expected $ExpectedUserName"
    }
    $process = Get-Process -Id $PID
    if (-not [Environment]::UserInteractive) {
        throw 'scheduled task is not running in an interactive user session'
    }
    if ($process.SessionId -eq 0) {
        throw 'scheduled task is running in Session 0'
    }
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'scheduled task is running with an administrator token; the EVB test account must be standard'
    }
    return [pscustomobject]@{
        marker    = $marker
        identity  = $identity
        sessionId = [int]$process.SessionId
    }
}

try {
    $context = Assert-StandardTestContext
} catch {
    Write-BlockedOutcome $_.Exception.Message
}

try {
    $audioService = Get-CimInstance -ClassName Win32_Service -Filter "Name = 'Audiosrv'" | Select-Object -First 1
} catch {
    Write-BlockedOutcome "Cannot inspect Audiosrv: $($_.Exception.Message)" 3
}
if ($null -eq $audioService) {
    Write-BlockedOutcome 'Audiosrv service was not found' 3
}

$serviceStartMode = [string]$audioService.StartMode
$serviceState = [string]$audioService.State
$outcome = [ordered]@{
    schemaVersion     = 1
    status            = if ($serviceStartMode -ceq 'Disabled' -and $serviceState -ceq 'Stopped') { 'audio-service-disabled' } else { 'failed' }
    phase             = 'audio-service-policy'
    capturedAt        = (Get-Date).ToUniversalTime().ToString('o')
    userSid           = $context.identity.User.Value
    userName          = $context.identity.Name
    sessionId         = $context.sessionId
    service           = 'Audiosrv'
    serviceStartMode  = $serviceStartMode
    serviceState      = $serviceState
    marker            = [ordered]@{
        imageId         = [string]$context.marker.imageId
        guestTestMarker = [string]$context.marker.guestTestMarker
    }
}
if ($outcome.status -ne 'audio-service-disabled') {
    $outcome.reason = 'Audiosrv must have StartMode Disabled and State Stopped before the worker starts'
}
if (-not (Write-Outcome $outcome)) {
    [Console]::Error.WriteLine('Audio service policy outcome was not recorded; refusing to start the worker.')
    exit 3
}
ConvertTo-Json -InputObject $outcome -Depth 8 -Compress
if ($outcome.status -ne 'audio-service-disabled') {
    [Console]::Error.WriteLine("Audiosrv policy is invalid: StartMode=$serviceStartMode State=$serviceState")
    exit 3
}
exit 0
