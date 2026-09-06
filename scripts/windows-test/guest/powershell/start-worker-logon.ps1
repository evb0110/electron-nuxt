<#
.SYNOPSIS
    Validates the EVB lab logon, mutes guest audio, and supervises the worker.
.DESCRIPTION
    This is the hidden Scheduled Task entry point. It refuses to launch the worker unless the
    guest root contains the exact two-field lab marker and the task is running as the configured
    standard test account on the Default desktop in an interactive session. It then calls the
    audio and printer policy checks before starting the Node worker, keeping all helper logs
    below the guest root.

    Exit codes: 0 worker success, 2 startup validation failure, 3 policy or worker launch failure,
    or the worker's own non-zero exit code after it starts.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$NodeExecutable,

    [Parameter(Mandatory = $true)]
    [string]$WorkerScript,

    [Parameter(Mandatory = $true)]
    [string]$GuestRoot,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedUserName,

    [string]$MuteScript = '',

    [string]$PrinterScript = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path -Path $PSScriptRoot -ChildPath 'test-lab-helpers.ps1')

$stateDirectory = Join-Path -Path $GuestRoot -ChildPath 'state'
$audioOutcomePath = Join-Path -Path $stateDirectory -ChildPath 'audio-mute.json'
$printerOutcomePath = Join-Path -Path $stateDirectory -ChildPath 'printer-policy.json'
$startupOutcomePath = Join-Path -Path $stateDirectory -ChildPath 'startup-validation.json'
$workerOutcomePath = Join-Path -Path $stateDirectory -ChildPath 'worker-logon.json'

function Write-JsonFile([string]$Path, [object]$Payload) {
    try {
        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            [Console]::Error.WriteLine("Cannot record startup state because directory is missing: $directory")
            return $false
        }
        $temporaryPath = Join-Path -Path $directory -ChildPath ('.{0}.{1}.tmp' -f [IO.Path]::GetFileNameWithoutExtension($Path), $PID)
        try {
            ConvertTo-Json -InputObject $Payload -Depth 8 -Compress | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
            Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
        } finally {
            Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
        }
        return $true
    } catch {
        [Console]::Error.WriteLine("Cannot record startup state at $Path : $($_.Exception.Message)")
        return $false
    }
}

function Write-BlockedOutcome([string]$Reason) {
    $payload = [ordered]@{
        schemaVersion = 1
        status        = 'blocked'
        phase         = 'startup-validation'
        reason        = $Reason
        capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }
    [void](Write-JsonFile $startupOutcomePath $payload)
    [Console]::Error.WriteLine($Reason)
}

function Test-PathInsideRoot([string]$Candidate) {
    try {
        $rootPath = [IO.Path]::GetFullPath($GuestRoot).TrimEnd('\')
        $candidatePath = [IO.Path]::GetFullPath($Candidate).TrimEnd('\')
        return $candidatePath.Equals($rootPath, [StringComparison]::OrdinalIgnoreCase) -or $candidatePath.StartsWith("$rootPath\", [StringComparison]::OrdinalIgnoreCase)
    } catch {
        return $false
    }
}

$desktopSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class EvbInputDesktop
{
    private const uint DesktopReadObjects = 0x0001;
    private const int UserObjectName = 2;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint desiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int length, out int requiredLength);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr desktop);

    public static string Name()
    {
        IntPtr desktop = OpenInputDesktop(0, false, DesktopReadObjects);
        if (desktop == IntPtr.Zero)
        {
            return "";
        }
        try
        {
            StringBuilder value = new StringBuilder(256);
            int requiredLength;
            if (!GetUserObjectInformation(desktop, UserObjectName, value, value.Capacity, out requiredLength))
            {
                return "";
            }
            return value.ToString();
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }
}
'@

if (-not ('EvbInputDesktop' -as [type])) {
    try {
        Add-Type -TypeDefinition $desktopSource -Language CSharp | Out-Null
    } catch {
        Write-BlockedOutcome "Cannot load Windows input-desktop probe: $($_.Exception.Message)"
        exit 3
    }
}

function Assert-StartupContext {
    if (-not (Test-Path -LiteralPath $GuestRoot -PathType Container)) {
        throw "EVB guest root is missing: $GuestRoot"
    }
    if (-not (Test-Path -LiteralPath $stateDirectory -PathType Container)) {
        throw "EVB guest state directory is missing: $stateDirectory"
    }
    $marker = Get-LabMarker -StateDirectory $stateDirectory
    if (-not (Test-Path -LiteralPath $NodeExecutable -PathType Leaf)) {
        throw "Node executable is missing: $NodeExecutable"
    }
    if (-not (Test-PathInsideRoot $NodeExecutable)) {
        throw "Node executable must be below EVB guest root: $NodeExecutable"
    }
    if (-not (Test-Path -LiteralPath $WorkerScript -PathType Leaf)) {
        throw "Worker bundle is missing: $WorkerScript"
    }
    if (-not (Test-PathInsideRoot $WorkerScript)) {
        throw "Worker bundle must be below EVB guest root: $WorkerScript"
    }
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
    $desktopName = [EvbInputDesktop]::Name()
    if ($desktopName -cne 'Default') {
        throw "input desktop is `"$desktopName`" instead of `"Default`""
    }
    $logonUi = @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)
    if ($logonUi.Count -gt 0) {
        throw 'guest session is locked (LogonUI.exe is present)'
    }
    $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw 'scheduled task is running with an administrator token; the EVB test account must be standard'
    }
    return [pscustomobject]@{
        marker    = $marker
        identity  = $identity
        sessionId = [int]$process.SessionId
        desktop   = $desktopName
    }
}

if ([string]::IsNullOrWhiteSpace($MuteScript)) {
    $MuteScript = Join-Path -Path $PSScriptRoot -ChildPath 'mute-test-audio.ps1'
}

try {
    $context = Assert-StartupContext
    if (-not (Test-Path -LiteralPath $MuteScript -PathType Leaf)) {
        throw "Audio mute helper is missing: $MuteScript"
    }
    if (-not (Test-PathInsideRoot $MuteScript)) {
        throw "Audio mute helper must be below EVB guest root: $MuteScript"
    }
    if ([string]::IsNullOrWhiteSpace($PrinterScript)) {
        $PrinterScript = Join-Path -Path $PSScriptRoot -ChildPath 'configure-test-printer.ps1'
    }
    if (-not (Test-Path -LiteralPath $PrinterScript -PathType Leaf)) {
        throw "Printer policy helper is missing: $PrinterScript"
    }
    if (-not (Test-PathInsideRoot $PrinterScript)) {
        throw "Printer policy helper must be below EVB guest root: $PrinterScript"
    }
} catch {
    Write-BlockedOutcome $_.Exception.Message
    exit 2
}

$powerShellExecutable = Join-Path -Path $env:SystemRoot -ChildPath 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellExecutable -PathType Leaf)) {
    Write-BlockedOutcome "Windows PowerShell executable is missing: $powerShellExecutable"
    exit 3
}

$muteStdoutPath = Join-Path -Path $stateDirectory -ChildPath 'audio-mute.stdout.log'
$muteStderrPath = Join-Path -Path $stateDirectory -ChildPath 'audio-mute.stderr.log'
$muteArguments = Join-ProcessArguments @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    $MuteScript,
    '-GuestRoot',
    $GuestRoot,
    '-ExpectedUserName',
    $ExpectedUserName
)
try {
    $muteProcess = Start-Process -FilePath $powerShellExecutable -ArgumentList $muteArguments -WorkingDirectory $GuestRoot -WindowStyle Hidden -RedirectStandardOutput $muteStdoutPath -RedirectStandardError $muteStderrPath -PassThru -Wait
} catch {
    Write-BlockedOutcome "Audio mute helper could not start: $($_.Exception.Message)"
    exit 3
}
if ($muteProcess.ExitCode -eq 2) {
    [Console]::Error.WriteLine("Audio mute helper blocked startup. See $audioOutcomePath or $startupOutcomePath")
    exit 2
}
if ($muteProcess.ExitCode -ne 0) {
    [Console]::Error.WriteLine("Audio mute helper failed with exit code $($muteProcess.ExitCode). See $audioOutcomePath or $startupOutcomePath")
    exit 3
}

$printerStdoutPath = Join-Path -Path $stateDirectory -ChildPath 'printer-policy.stdout.log'
$printerStderrPath = Join-Path -Path $stateDirectory -ChildPath 'printer-policy.stderr.log'
$printerArguments = Join-ProcessArguments @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-WindowStyle',
    'Hidden',
    '-File',
    $PrinterScript,
    '-GuestRoot',
    $GuestRoot
)
try {
    $printerProcess = Start-Process -FilePath $powerShellExecutable -ArgumentList $printerArguments -WorkingDirectory $GuestRoot -WindowStyle Hidden -RedirectStandardOutput $printerStdoutPath -RedirectStandardError $printerStderrPath -PassThru -Wait
} catch {
    Write-BlockedOutcome "Printer policy helper could not start: $($_.Exception.Message)"
    exit 3
}
if ($printerProcess.ExitCode -eq 2) {
    [Console]::Error.WriteLine("Printer policy blocked startup. See $printerOutcomePath or $startupOutcomePath")
    exit 2
}
if ($printerProcess.ExitCode -ne 0) {
    [Console]::Error.WriteLine("Printer policy failed with exit code $($printerProcess.ExitCode). See $printerOutcomePath or $startupOutcomePath")
    exit 3
}

$workerStdoutPath = Join-Path -Path $stateDirectory -ChildPath 'worker.stdout.log'
$workerStderrPath = Join-Path -Path $stateDirectory -ChildPath 'worker.stderr.log'
$workerArguments = Join-ProcessArguments @(
    $WorkerScript,
    "--root=$GuestRoot"
)
$workerStartedAt = (Get-Date).ToUniversalTime().ToString('o')
try {
    $workerProcess = Start-Process -FilePath $NodeExecutable -ArgumentList $workerArguments -WorkingDirectory (Split-Path -Parent $WorkerScript) -WindowStyle Hidden -RedirectStandardOutput $workerStdoutPath -RedirectStandardError $workerStderrPath -PassThru -Wait
} catch {
    $message = "Worker could not start: $($_.Exception.Message)"
    [void](Write-JsonFile $workerOutcomePath ([ordered]@{
        schemaVersion = 1
        status        = 'failed'
        phase         = 'worker-start'
        reason        = $message
        startedAt     = $workerStartedAt
        capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    }))
    [Console]::Error.WriteLine($message)
    exit 3
}

$workerExitCode = [int]$workerProcess.ExitCode
$workerStatus = if ($workerExitCode -eq 0) { 'completed' } else { 'failed' }
[void](Write-JsonFile $workerOutcomePath ([ordered]@{
    schemaVersion = 1
    status        = $workerStatus
    phase         = 'worker-run'
    startedAt     = $workerStartedAt
    capturedAt    = (Get-Date).ToUniversalTime().ToString('o')
    exitCode      = $workerExitCode
    stdout        = $workerStdoutPath
    stderr        = $workerStderrPath
}))
exit $workerExitCode
