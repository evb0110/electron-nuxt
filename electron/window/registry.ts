import { BrowserWindow } from 'electron';

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
    const allWindows = BrowserWindow.getAllWindows().filter(window => !window.isDestroyed());
    const activeIds = new Set(allWindows.map(window => window.id));

    for (const window of allWindows) {
        appWindows.set(window.id, window);
    }

    for (const windowId of appWindows.keys()) {
        if (!activeIds.has(windowId)) {
            appWindows.delete(windowId);
        }
    }

    if (mainWindowId !== null && !activeIds.has(mainWindowId)) {
        mainWindowId = allWindows[0]?.id ?? null;
    }
}

export function getWindowByIdFromRegistry(windowId: number) {
    const fromRegistry = appWindows.get(windowId);
    if (fromRegistry && !fromRegistry.isDestroyed()) {
        return fromRegistry;
    }

    const fromElectron = BrowserWindow.fromId(windowId);
    if (!fromElectron || fromElectron.isDestroyed()) {
        appWindows.delete(windowId);
        return null;
    }

    appWindows.set(windowId, fromElectron);
    return fromElectron;
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
