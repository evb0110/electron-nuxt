<#
.SYNOPSIS
    Configures and verifies the paper policy for the isolated EVB Windows test printer.
.DESCRIPTION
    The Windows test fixture is generated at A4 size. Microsoft Print to PDF inherits the
    guest's driver default, which is Letter on an en-US image unless the lab sets it. This
    helper records the observed policy and refuses to report success unless the printer is
    present and its paper size is A4. Run it with -Configure once from an administrator
    context while provisioning the golden image. The logon task runs it without -Configure
    on every boot, so printer drift blocks the worker before a test can start.

    Exit codes: 0 when the printer is present and A4, 2 for invalid context or a missing
    printer, and 3 when configuration or verification fails.
#>
[CmdletBinding()]
param(
    [string]$PrinterName = 'Microsoft Print to PDF',

    [string]$GuestRoot = 'C:\EVBViewerTests',

    [switch]$Configure
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$stateDirectory = Join-Path -Path $GuestRoot -ChildPath 'state'
$outcomePath = Join-Path -Path $stateDirectory -ChildPath 'printer-policy.json'

function Write-Outcome([object]$Payload) {
    try {
        if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
            [Console]::Error.WriteLine("Cannot record printer policy because state directory is missing: $stateDirectory")
            return $false
        }
        $temporaryPath = Join-Path -Path $stateDirectory -ChildPath ('.printer-policy.{0}.tmp' -f $PID)
        try {
            ConvertTo-Json -InputObject $Payload -Depth 8 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            Move-Item -LiteralPath $temporaryPath -Destination $outcomePath -Force
        } finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        return $true
    } catch {
        [Console]::Error.WriteLine("Cannot record printer policy at $outcomePath : $($_.Exception.Message)")
        return $false
    }
}

function Finish-Failure([string]$Reason, [int]$ExitCode) {
    $payload = [ordered]@{
        schemaVersion = 1
        status        = 'failed'
        phase         = 'printer-policy'
        printerName   = $PrinterName
        reason        = $Reason
        capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }
    [void](Write-Outcome $payload)
    [Console]::Error.WriteLine($Reason)
    exit $ExitCode
}

if (-not (Test-Path -LiteralPath $GuestRoot -PathType Container)) {
    Finish-Failure "EVB guest root is missing: $GuestRoot" 2
}
if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
    Finish-Failure "EVB guest state directory is missing: $stateDirectory" 2
}
if ($Configure) {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if (-not $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        Finish-Failure 'printer provisioning requires an administrator token' 2
    }
}

try {
    $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
} catch {
    Finish-Failure "Cannot inspect printer $PrinterName : $($_.Exception.Message)" 3
}
if ($null -eq $printer) {
    Finish-Failure "Required printer is not installed: $PrinterName" 2
}

if ($Configure) {
    try {
        Set-PrintConfiguration -PrinterName $PrinterName -PaperSize A4 -Confirm:$false -ErrorAction Stop | Out-Null
    } catch {
        Finish-Failure "Cannot configure $PrinterName for A4 output: $($_.Exception.Message)" 3
    }
}

try {
    $configuration = Get-PrintConfiguration -PrinterName $PrinterName -ErrorAction Stop
} catch {
    Finish-Failure "Cannot read print configuration for $PrinterName : $($_.Exception.Message)" 3
}

$paperSize = [string]$configuration.PaperSize
$orientationProperty = $configuration.PSObject.Properties['Orientation']
$orientation = if ($null -eq $orientationProperty) { '' } else { [string]$orientationProperty.Value }
$outcome = [ordered]@{
    schemaVersion = 1
    status        = if ($paperSize -ceq 'A4') { 'printer-policy-ok' } else { 'failed' }
    phase         = 'printer-policy'
    capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    printerName   = $PrinterName
    driverName    = [string]$printer.DriverName
    paperSize     = $paperSize
    orientation   = $orientation
    configured    = [bool]$Configure
}
if ($outcome.status -ne 'printer-policy-ok') {
    $outcome.reason = "Expected A4 paper, observed PaperSize=$paperSize Orientation=$orientation"
}
if (-not (Write-Outcome $outcome)) {
    [Console]::Error.WriteLine('Printer policy outcome was not recorded; refusing to report success.')
    exit 3
}
ConvertTo-Json -InputObject $outcome -Depth 8 -Compress
if ($outcome.status -ne 'printer-policy-ok') {
    [Console]::Error.WriteLine([string]$outcome.reason)
    exit 3
}
exit 0
