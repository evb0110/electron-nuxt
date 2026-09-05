<#
.SYNOPSIS
    Reports the worker's Windows identity, the input desktop and the installed application version as JSON.
.DESCRIPTION
    The guest worker calls this script before running any case. Invariant I9 requires an interactive
    session: a Session 0 launch, a non-Default input desktop or a visible LogonUI means no user journey
    is possible, and the worker refuses to continue. This script only reports; it never repairs.
#>
[CmdletBinding()]
param(
    [Parameter(Position = 0)]
    [string]$ExecutablePath = '',

    [int]$WorkerPid = $PID
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$desktopSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class EvbInputDesktop
{
    private const uint DESKTOP_READOBJECTS = 0x0001;
    private const int UOI_NAME = 2;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    public static string Name()
    {
        IntPtr desktop = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
        if (desktop == IntPtr.Zero)
        {
            return "";
        }
        try
        {
            StringBuilder builder = new StringBuilder(256);
            int needed;
            if (!GetUserObjectInformation(desktop, UOI_NAME, builder, builder.Capacity, out needed))
            {
                return "";
            }
            return builder.ToString();
        }
        finally
        {
            CloseDesktop(desktop);
        }
    }
}
'@

if (-not ('EvbInputDesktop' -as [type])) {
    Add-Type -TypeDefinition $desktopSource -Language CSharp | Out-Null
}

function Get-IntegrityLevel {
    $rows = & whoami.exe /groups /fo csv | ConvertFrom-Csv
    $label = $rows | Where-Object { $_.SID -like 'S-1-16-*' } | Select-Object -First 1
    if ($null -eq $label) {
        return 'unknown'
    }
    switch ($label.SID) {
        'S-1-16-4096'  { return 'Low' }
        'S-1-16-8192'  { return 'Medium' }
        'S-1-16-8448'  { return 'MediumPlus' }
        'S-1-16-12288' { return 'High' }
        'S-1-16-16384' { return 'System' }
        default        { return $label.SID }
    }
}

function Get-OsArchitecture {
    if ($env:PROCESSOR_ARCHITEW6432) {
        return $env:PROCESSOR_ARCHITEW6432
    }
    if ($env:PROCESSOR_ARCHITECTURE) {
        return $env:PROCESSOR_ARCHITECTURE
    }
    return 'unknown'
}

function Get-AppVersion([string]$path) {
    if ([string]::IsNullOrWhiteSpace($path) -or -not (Test-Path -LiteralPath $path -PathType Leaf)) {
        return ''
    }
    $info = (Get-Item -LiteralPath $path).VersionInfo
    if ($null -eq $info -or [string]::IsNullOrWhiteSpace($info.ProductVersion)) {
        return ''
    }
    return $info.ProductVersion.Trim()
}

$worker = Get-Process -Id $WorkerPid
if ($WorkerPid -ne $PID) {
    $probeProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$PID"
    if ($probeProcess.ParentProcessId -ne $WorkerPid) {
        throw 'The requested worker is not the parent of the identity probe.'
    }
}
$operatingSystem = Get-CimInstance -ClassName Win32_OperatingSystem
$logonUi = @(Get-Process -Name 'LogonUI' -ErrorAction SilentlyContinue)

$payload = [ordered]@{
    userSid         = ([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value
    sessionId       = [int]$worker.SessionId
    integrityLevel  = Get-IntegrityLevel
    inputDesktop    = [EvbInputDesktop]::Name()
    logonUiPresent  = ($logonUi.Count -gt 0)
    workerPid       = [int]$worker.Id
    workerStartTime = $worker.StartTime.ToUniversalTime().ToString('o')
    osVersion       = "$($operatingSystem.Caption) $($operatingSystem.Version)"
    osArchitecture  = Get-OsArchitecture
    hostname        = [System.Net.Dns]::GetHostName()
    appVersion      = Get-AppVersion $ExecutablePath
}

ConvertTo-Json -InputObject $payload -Depth 4 -Compress
exit 0
