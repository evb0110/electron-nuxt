<#
.SYNOPSIS
    Prints the SHA-256 hash and byte size of a file as JSON.
.DESCRIPTION
    Used by the host and by guest evidence collection to compare a staged artifact with the file that
    actually landed on the guest. The script reads the file with shared access so it never blocks a
    running application.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    [Console]::Error.WriteLine("File not found: $Path")
    exit 2
}

$item = Get-Item -LiteralPath $Path
$hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256

$payload = [ordered]@{
    path   = $item.FullName
    sha256 = $hash.Hash.ToLowerInvariant()
    bytes  = [int64]$item.Length
}

ConvertTo-Json -InputObject $payload -Depth 3 -Compress
exit 0
