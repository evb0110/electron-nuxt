import type { BrowserWindow } from 'electron';

const appWindows = new Map<number, BrowserWindow>();
let mainWindowId: number | null = null;

export function registerAppWindow(window: BrowserWindow, options: { setAsMain?: boolean } = {}) {
    appWindows.set(window.id, window);

    const shouldSetMain = options.setAsMain ?? mainWindowId === null;
    if (shouldSetMain) {
        mainWindowId = window.id;
    }
}

export function unregisterAppWindow(windowId: number) {
    appWindows.delete(windowId);
    if (mainWindowId === windowId) {
        mainWindowId = null;
        syncWindowRegistry();
    }
}

function syncWindowRegistry() {
    for (const windowId of appWindows.keys()) {
        const window = appWindows.get(windowId);
        if (!window || window.isDestroyed()) {
            appWindows.delete(windowId);
        }
    }

    if (mainWindowId !== null && !appWindows.has(mainWindowId)) {
        mainWindowId = appWindows.keys().next().value ?? null;
    }
}

export function getWindowByIdFromRegistry(windowId: number) {
    const fromRegistry = appWindows.get(windowId);
    if (fromRegistry && !fromRegistry.isDestroyed()) {
        return fromRegistry;
    }

    appWindows.delete(windowId);
    return null;
}

export function getAllRegisteredAppWindows() {
    syncWindowRegistry();
    return Array.from(appWindows.values()).filter(window => !window.isDestroyed());
}

export function getRegisteredMainWindow() {
    if (mainWindowId !== null) {
        const mainWindow = getWindowByIdFromRegistry(mainWindowId);
        if (mainWindow) {
            return mainWindow;
        }
    }

    const fallback = getAllRegisteredAppWindows()[0] ?? null;
    if (fallback) {
        mainWindowId = fallback.id;
    }

    return fallback;
}
