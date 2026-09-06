<#
.SYNOPSIS
    Shared validation helpers for the isolated EVB Windows test account.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-LabMarker([string]$StateDirectory) {
    $markerPath = Join-Path -Path $StateDirectory -ChildPath 'test-marker.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) {
        throw "EVB lab marker is missing: $markerPath"
    }
    $markerText = Get-Content -LiteralPath $markerPath -Raw
    if ([string]::IsNullOrWhiteSpace($markerText)) {
        throw "EVB lab marker is empty: $markerPath"
    }
    try {
        $marker = $markerText | ConvertFrom-Json
    } catch {
        throw "EVB lab marker is not valid JSON: $markerPath"
    }
    if ($null -eq $marker) {
        throw "EVB lab marker is null: $markerPath"
    }
    $propertyNames = @($marker.PSObject.Properties.Name)
    if ($propertyNames.Count -ne 2 -or -not ($propertyNames -ccontains 'imageId') -or -not ($propertyNames -ccontains 'guestTestMarker')) {
        throw 'EVB lab marker must contain exactly imageId and guestTestMarker'
    }
    if ([string]::IsNullOrWhiteSpace([string]$marker.imageId) -or [string]::IsNullOrWhiteSpace([string]$marker.guestTestMarker)) {
        throw 'EVB lab marker imageId and guestTestMarker must be non-empty strings'
    }
    return $marker
}

function Resolve-AccountSid([string]$AccountName) {
    try {
        $account = New-Object System.Security.Principal.NTAccount($AccountName)
        return $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
    } catch {
        throw "Cannot resolve expected test account $AccountName : $($_.Exception.Message)"
    }
}

function ConvertTo-ProcessArgument([string]$Value) {
    if ($Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = $Value.Replace('"', '\"')
    $trailingBackslashes = [regex]::Match($escaped, '\\*$').Value
    return '"{0}{1}"' -f $escaped, $trailingBackslashes
}

function Join-ProcessArguments([string[]]$Values) {
    return (($Values | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')
}
