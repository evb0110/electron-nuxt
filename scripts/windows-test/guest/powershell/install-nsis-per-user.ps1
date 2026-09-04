<#
.SYNOPSIS
    Installs the per-user NSIS build of EVB Viewer silently and reports the installed executable.
.DESCRIPTION
    The lane installs the same artifact a user downloads, into the per-user location, without
    elevation. The script verifies the installer hash before running it when one is supplied, so a
    corrupted or swapped artifact is rejected instead of installed.

    Exit codes: 0 success, 2 installer missing, 3 hash mismatch, 4 installer failed, 5 executable missing.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$InstallerPath,

    [string]$ExpectedSha256 = '',

    [string]$ExecutablePath = '',

    [ValidateRange(10, 1800)]
    [int]$TimeoutSeconds = 600
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
    [Console]::Error.WriteLine("Installer not found: $InstallerPath")
    exit 2
}

if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256)) {
    $actual = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
        [Console]::Error.WriteLine("Installer sha256 $actual does not match the expected $ExpectedSha256")
        exit 3
    }
}

if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $ExecutablePath = Join-Path $env:LOCALAPPDATA 'Programs\EVB Viewer\EVB Viewer.exe'
}

$started = Get-Date
$process = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', '/currentuser') -PassThru
if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill()
    [Console]::Error.WriteLine("The installer did not finish within $TimeoutSeconds seconds")
    exit 4
}
if ($process.ExitCode -ne 0) {
    [Console]::Error.WriteLine("The installer exited with $($process.ExitCode)")
    exit 4
}

if (-not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
    [Console]::Error.WriteLine("The installer finished but $ExecutablePath does not exist")
    exit 5
}

$payload = [ordered]@{
    installed       = $true
    installerPath   = (Get-Item -LiteralPath $InstallerPath).FullName
    executablePath  = (Get-Item -LiteralPath $ExecutablePath).FullName
    sha256          = (Get-FileHash -LiteralPath $ExecutablePath -Algorithm SHA256).Hash.ToLowerInvariant()
    exitCode        = [int]$process.ExitCode
    durationSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 3)
}

ConvertTo-Json -InputObject $payload -Depth 4 -Compress
exit 0
