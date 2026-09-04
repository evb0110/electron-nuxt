<#
.SYNOPSIS
    Queries the UI Automation tree and prints matching elements as JSON.
.DESCRIPTION
    Fallback native UI driver for the guest worker when the winapp CLI is unavailable. Elements are
    identified by their UI Automation runtime id, which the matching uia-action.ps1 resolves again
    before acting. The script never types text and never clicks: it only reads the tree.

    Exit codes: 0 success, 3 no interactive desktop, 4 query failure.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('window', 'control', 'tree')]
    [string]$Kind,

    [string]$Root = 'root',
    [string]$ControlType = '',
    [string]$AutomationId = '',
    [string]$ProcessId = '',
    [string]$TitleContains = '',
    [string]$ClassName = '',
    [int]$MaxDepth = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$desktopSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class EvbQueryDesktop
{
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool CloseDesktop(IntPtr hDesktop);

    public static bool Available()
    {
        IntPtr desktop = OpenInputDesktop(0, false, 0x0001);
        if (desktop == IntPtr.Zero)
        {
            return false;
        }
        CloseDesktop(desktop);
        return true;
    }
}
'@

if (-not ('EvbQueryDesktop' -as [type])) {
    Add-Type -TypeDefinition $desktopSource -Language CSharp | Out-Null
}

if (-not [EvbQueryDesktop]::Available()) {
    [Console]::Error.WriteLine('the input desktop is not available to this session; no interactive desktop for UI Automation')
    exit 3
}

function Get-RuntimeIdText($element) {
    $runtimeId = $element.GetRuntimeId()
    if ($null -eq $runtimeId) {
        return ''
    }
    return ($runtimeId -join '.')
}

function ConvertTo-Payload($element) {
    $current = $element.Current
    $automationId = $current.AutomationId
    if ([string]::IsNullOrEmpty($automationId)) {
        $automationId = $null
    }
    return [ordered]@{
        runtimeId    = Get-RuntimeIdText $element
        controlType  = ($current.ControlType.ProgrammaticName -split '\.')[-1]
        name         = [string]$current.Name
        automationId = $automationId
        processId    = [int]$current.ProcessId
    }
}

function Resolve-Root([string]$rootId) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    if ($rootId -eq 'root' -or [string]::IsNullOrWhiteSpace($rootId)) {
        return $desktop
    }
    $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = New-Object 'System.Collections.Generic.Queue[object]'
    $queue.Enqueue(@($desktop, 0))
    $visited = 0
    while ($queue.Count -gt 0 -and $visited -lt 20000) {
        $entry = $queue.Dequeue()
        $element = $entry[0]
        $depth = [int]$entry[1]
        $visited += 1
        if ((Get-RuntimeIdText $element) -eq $rootId) {
            return $element
        }
        if ($depth -ge $MaxDepth) {
            continue
        }
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child) {
            $queue.Enqueue(@($child, $depth + 1))
            $child = $walker.GetNextSibling($child)
        }
    }
    return $null
}

function Resolve-ControlTypeCondition([string]$name) {
    if ([string]::IsNullOrWhiteSpace($name)) {
        return $null
    }
    $field = [System.Windows.Automation.ControlType].GetField(
        $name,
        [System.Reflection.BindingFlags]::Public -bor
        [System.Reflection.BindingFlags]::Static -bor
        [System.Reflection.BindingFlags]::IgnoreCase)
    if ($null -eq $field) {
        [Console]::Error.WriteLine("Unknown UI Automation control type: $name")
        exit 4
    }
    return New-Object System.Windows.Automation.PropertyCondition(
        [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
        $field.GetValue($null))
}

function Build-Condition {
    $conditions = New-Object 'System.Collections.Generic.List[System.Windows.Automation.Condition]'
    $controlTypeCondition = Resolve-ControlTypeCondition $ControlType
    if ($null -ne $controlTypeCondition) {
        $conditions.Add($controlTypeCondition)
    }
    if (-not [string]::IsNullOrWhiteSpace($AutomationId)) {
        $conditions.Add((New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty,
            $AutomationId)))
    }
    if (-not [string]::IsNullOrWhiteSpace($ClassName)) {
        $conditions.Add((New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ClassNameProperty,
            $ClassName)))
    }
    if (-not [string]::IsNullOrWhiteSpace($ProcessId)) {
        $conditions.Add((New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
            [int]$ProcessId)))
    }
    if ($conditions.Count -eq 0) {
        return [System.Windows.Automation.Condition]::TrueCondition
    }
    if ($conditions.Count -eq 1) {
        return $conditions[0]
    }
    return New-Object System.Windows.Automation.AndCondition($conditions.ToArray())
}

function ConvertTo-Tree($element, [int]$depth) {
    $payload = ConvertTo-Payload $element
    $children = @()
    if ($depth -lt 4) {
        $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
        $child = $walker.GetFirstChild($element)
        $count = 0
        while ($null -ne $child -and $count -lt 200) {
            $children += (ConvertTo-Tree $child ($depth + 1))
            $child = $walker.GetNextSibling($child)
            $count += 1
        }
    }
    $payload['children'] = @($children)
    return $payload
}

$rootElement = Resolve-Root $Root
if ($null -eq $rootElement) {
    # A find under a vanished root is an empty result so callers can keep
    # polling; a tree capture of nothing would be a silent lie, so it fails.
    if ($Kind -eq 'tree') {
        [Console]::Error.WriteLine("No UI Automation element matches the tree root $Root")
        exit 4
    }
    Write-Output '[]'
    exit 0
}

if ($Kind -eq 'tree') {
    ConvertTo-Json -InputObject (ConvertTo-Tree $rootElement 0) -Depth 12 -Compress
    exit 0
}

$scope = if ($Kind -eq 'window') {
    [System.Windows.Automation.TreeScope]::Children
}
else {
    [System.Windows.Automation.TreeScope]::Descendants
}

$found = @($rootElement.FindAll($scope, (Build-Condition)))
$payloads = @()
foreach ($element in $found) {
    $payload = ConvertTo-Payload $element
    if (-not [string]::IsNullOrWhiteSpace($TitleContains) -and $payload.name -notlike "*$TitleContains*") {
        continue
    }
    $payloads += $payload
}

$json = ConvertTo-Json -InputObject @($payloads) -Depth 5 -Compress
if ([string]::IsNullOrWhiteSpace($json)) {
    $json = '[]'
}
elseif (-not $json.StartsWith('[')) {
    $json = "[$json]"
}
Write-Output $json
exit 0
