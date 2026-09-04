<#
.SYNOPSIS
    Performs one UI Automation action on an element identified by its runtime id.
.DESCRIPTION
    Fallback native UI driver used with uia-query.ps1. Every action resolves the runtime id again
    before acting, so a stale reference fails loudly instead of hitting the wrong control. Keyboard
    input goes to the focused element of the resolved window, never to whatever happens to be focused.

    Exit codes: 0 success, 3 no interactive desktop, 4 element not found, 5 pattern unavailable.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('invoke', 'set-value', 'select', 'send-keys', 'screenshot')]
    [string]$Action,

    [string]$RuntimeId = '',
    [string]$Value = '',
    [string]$OutputPath = '',
    [int]$MaxDepth = 12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$desktopSource = @'
using System;
using System.Runtime.InteropServices;

public static class EvbActionDesktop
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

if (-not ('EvbActionDesktop' -as [type])) {
    Add-Type -TypeDefinition $desktopSource -Language CSharp | Out-Null
}

if (-not [EvbActionDesktop]::Available()) {
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

function Resolve-Element([string]$runtimeId) {
    $desktop = [System.Windows.Automation.AutomationElement]::RootElement
    if ([string]::IsNullOrWhiteSpace($runtimeId) -or $runtimeId -eq 'root') {
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
        if ((Get-RuntimeIdText $element) -eq $runtimeId) {
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

function Get-Pattern($element, $pattern) {
    $value = $null
    if ($element.TryGetCurrentPattern($pattern, [ref]$value)) {
        return $value
    }
    return $null
}

function Complete([string]$detail) {
    ConvertTo-Json -InputObject ([ordered]@{
        action    = $Action
        runtimeId = $RuntimeId
        detail    = $detail
        completed = $true
    }) -Depth 3 -Compress
    exit 0
}

if ($Action -eq 'screenshot') {
    if ([string]::IsNullOrWhiteSpace($OutputPath)) {
        [Console]::Error.WriteLine('screenshot requires -OutputPath')
        exit 4
    }
    $directory = Split-Path -Parent $OutputPath
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
        }
        finally {
            $graphics.Dispose()
        }
        $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $bitmap.Dispose()
    }
    Complete "screenshot written to $OutputPath"
}

$target = Resolve-Element $RuntimeId
if ($null -eq $target) {
    [Console]::Error.WriteLine("No UI Automation element matches runtime id $RuntimeId")
    exit 4
}

switch ($Action) {
    'invoke' {
        $invoke = Get-Pattern $target ([System.Windows.Automation.InvokePattern]::Pattern)
        if ($null -ne $invoke) {
            $invoke.Invoke()
            Complete 'InvokePattern.Invoke'
        }
        $toggle = Get-Pattern $target ([System.Windows.Automation.TogglePattern]::Pattern)
        if ($null -ne $toggle) {
            $toggle.Toggle()
            Complete 'TogglePattern.Toggle'
        }
        $selection = Get-Pattern $target ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -ne $selection) {
            $selection.Select()
            Complete 'SelectionItemPattern.Select'
        }
        [Console]::Error.WriteLine('The element supports neither Invoke, Toggle nor SelectionItem')
        exit 5
    }
    'set-value' {
        $valuePattern = Get-Pattern $target ([System.Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $valuePattern) {
            [Console]::Error.WriteLine('The element does not support ValuePattern')
            exit 5
        }
        if ($valuePattern.Current.IsReadOnly) {
            [Console]::Error.WriteLine('The element is read-only')
            exit 5
        }
        $valuePattern.SetValue($Value)
        Complete 'ValuePattern.SetValue'
    }
    'select' {
        $expand = Get-Pattern $target ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
        if ($null -ne $expand) {
            $expand.Expand()
        }
        $condition = New-Object System.Windows.Automation.PropertyCondition(
            [System.Windows.Automation.AutomationElement]::NameProperty,
            $Value)
        $item = $target.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $condition)
        if ($null -eq $item) {
            [Console]::Error.WriteLine("No selectable item named $Value")
            exit 4
        }
        $selectionItem = Get-Pattern $item ([System.Windows.Automation.SelectionItemPattern]::Pattern)
        if ($null -eq $selectionItem) {
            [Console]::Error.WriteLine("The item named $Value does not support SelectionItemPattern")
            exit 5
        }
        $selectionItem.Select()
        if ($null -ne $expand) {
            $expand.Collapse()
        }
        Complete 'SelectionItemPattern.Select'
    }
    'send-keys' {
        $target.SetFocus()
        Start-Sleep -Milliseconds 120
        [System.Windows.Forms.SendKeys]::SendWait($Value)
        Complete 'SendKeys.SendWait'
    }
}

[Console]::Error.WriteLine("Unhandled action $Action")
exit 4
