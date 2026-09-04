<#
.SYNOPSIS
    Lists the spooler jobs of one printer as a JSON array.
.DESCRIPTION
    The print cases wait for the queue to drain and assert that a canceled print leaves no job behind.
    Exit codes: 0 success (an existing printer with no jobs yields []), 3 the query failed,
    4 the printer is not installed. Both failures are distinct from "no jobs".
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PrinterName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Convert-Job($job, [string]$printerName, [string]$documentName, $submitted) {
    $submittedText = $null
    if ($null -ne $submitted) {
        $submittedText = ([datetime]$submitted).ToUniversalTime().ToString('o')
    }
    return [ordered]@{
        jobId        = [int]$job.JobId
        documentName = [string]$documentName
        printerName  = [string]$printerName
        status       = [string]$job.JobStatus
        submittedTime = $submittedText
    }
}

# WQL LIKE treats %, _, [ and ] as wildcards and ' as the string delimiter;
# the printer name is data, so every one of them is escaped.
function ConvertTo-WqlLikeLiteral([string]$value) {
    $escaped = $value.Replace('\', '\\').Replace("'", "\'")
    $escaped = $escaped.Replace('[', '[[]').Replace('%', '[%]').Replace('_', '[_]')
    return $escaped
}

$jobs = @()
try {
    if (Get-Command -Name 'Get-PrintJob' -ErrorAction SilentlyContinue) {
        $printer = Get-Printer -Name $PrinterName -ErrorAction SilentlyContinue
        if ($null -eq $printer) {
            [Console]::Error.WriteLine("Printer not found: ${PrinterName}")
            exit 4
        }
        $raw = @(Get-PrintJob -PrinterName $PrinterName)
        foreach ($job in $raw) {
            $jobs += Convert-Job $job $job.PrinterName $job.DocumentName $job.SubmittedTime
        }
    }
    else {
        $filter = "Name LIKE '$(ConvertTo-WqlLikeLiteral $PrinterName),%'"
        $raw = @(Get-CimInstance -ClassName Win32_PrintJob -Filter $filter)
        foreach ($job in $raw) {
            $jobs += [ordered]@{
                jobId         = [int]$job.JobId
                documentName  = [string]$job.Document
                printerName   = $PrinterName
                status        = [string]$job.JobStatus
                submittedTime = $null
            }
        }
    }
}
catch {
    [Console]::Error.WriteLine("Failed to query the print queue of ${PrinterName}: $($_.Exception.Message)")
    exit 3
}

$json = ConvertTo-Json -InputObject @($jobs) -Depth 4 -Compress
if ([string]::IsNullOrWhiteSpace($json)) {
    $json = '[]'
}
elseif (-not $json.StartsWith('[')) {
    $json = "[$json]"
}
Write-Output $json
exit 0
