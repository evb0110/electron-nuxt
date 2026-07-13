import AppKit
import CoreGraphics
import Foundation

enum ProbeError: Error {
    case invalidArguments
}

func hasDocumentWindow(processIdentifier: pid_t, onscreenOnly: Bool) -> Bool {
    let options: CGWindowListOption = onscreenOnly ? [.optionOnScreenOnly] : [.optionAll]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else {
        return false
    }

    return windows.contains { window in
        guard
            let ownerPid = window[kCGWindowOwnerPID as String] as? pid_t,
            ownerPid == processIdentifier,
            let layer = window[kCGWindowLayer as String] as? Int,
            layer == 0,
            let boundsValue = window[kCGWindowBounds as String],
            let bounds = CGRect(dictionaryRepresentation: boundsValue as! CFDictionary)
        else {
            return false
        }
        return bounds.width > 100 && bounds.height > 100
    }
}

func applicationWindows(processIdentifier: pid_t) -> [AXUIElement] {
    let application = AXUIElementCreateApplication(processIdentifier)
    var value: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
        let windows = value as? [AXUIElement]
    else {
        return []
    }
    return windows
}

func minimizeMainWindow(processIdentifier: pid_t) -> Bool {
    guard let window = applicationWindows(processIdentifier: processIdentifier).first else {
        return false
    }
    return AXUIElementSetAttributeValue(
        window,
        kAXMinimizedAttribute as CFString,
        kCFBooleanTrue
    ) == .success
}

func closeMainWindow(processIdentifier: pid_t) -> Bool {
    guard let window = applicationWindows(processIdentifier: processIdentifier).first else {
        return false
    }
    var closeButtonValue: CFTypeRef?
    guard
        AXUIElementCopyAttributeValue(window, kAXCloseButtonAttribute as CFString, &closeButtonValue) == .success,
        let closeButton = closeButtonValue as! AXUIElement?
    else {
        return false
    }
    return AXUIElementPerformAction(closeButton, kAXPressAction as CFString) == .success
}

func hideApplication(processIdentifier: pid_t) -> Bool {
    let application = AXUIElementCreateApplication(processIdentifier)
    return AXUIElementSetAttributeValue(
        application,
        kAXHiddenAttribute as CFString,
        kCFBooleanTrue
    ) == .success
}

guard CommandLine.arguments.count == 3, let pid = pid_t(CommandLine.arguments[2]) else {
    throw ProbeError.invalidArguments
}

let command = CommandLine.arguments[1]
let frontmostPid = NSWorkspace.shared.frontmostApplication?.processIdentifier
let hasAnyWindow = hasDocumentWindow(processIdentifier: pid, onscreenOnly: false)
let hasOnscreenWindow = hasDocumentWindow(processIdentifier: pid, onscreenOnly: true)

let passed: Bool
switch command {
case "ready":
    passed = frontmostPid == pid && hasOnscreenWindow
case "not-frontmost":
    passed = frontmostPid != pid
case "not-visible":
    passed = !hasOnscreenWindow
case "no-window":
    passed = !hasAnyWindow
case "minimize":
    passed = minimizeMainWindow(processIdentifier: pid)
case "hide":
    passed = hideApplication(processIdentifier: pid)
case "close":
    passed = closeMainWindow(processIdentifier: pid)
default:
    throw ProbeError.invalidArguments
}

if passed {
    print("PASS")
    exit(EXIT_SUCCESS)
}

let frontmostPidDescription = frontmostPid.map { String($0) } ?? "none"
fputs(
    "WAIT command=\(command) pid=\(pid) frontmostPid=\(frontmostPidDescription) "
        + "hasAnyWindow=\(hasAnyWindow) hasOnscreenWindow=\(hasOnscreenWindow)\n",
    stderr
)
exit(EXIT_FAILURE)
