import type {
    BaseWindow,
    MenuItemConstructorOptions,
} from 'electron';
import {
    app,
    BrowserWindow,
    Menu,
} from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import { createLogger } from '@electron/utils/createLogger';
import { te } from '@electron/te';
import {
    getAllRegisteredAppWindows,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('menu');
const WINDOW_TABS_ACTION_CHANNEL = 'menu:windowTabsAction';
const MENU_REBUILD_DEBOUNCE_MS = 40;
const menuDocumentStateByWindow = new Map<number, boolean>();
const menuSaveStateByWindow = new Map<number, boolean>();
const menuRepairSaveStateByWindow = new Map<number, boolean>();
const menuTabCountByWindow = new Map<number, number>();
const trackedWindowIds = new Set<number>();
let listenersRegistered = false;
let menuRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let menuRebuildPending = false;

function getFocusedAppWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        return focusedWindow;
    }

    const windows = getAllRegisteredAppWindows();
    return windows[0] ?? null;
}

function getWindowTabCount(window: BrowserWindow | null) {
    if (!window) {
        return 0;
    }

    return menuTabCountByWindow.get(window.id) ?? 0;
}

function getWindowDisplayLabel(window: BrowserWindow, duplicateCountByTitle: Record<string, number>) {
    const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
    const duplicateCount = duplicateCountByTitle[title] ?? 0;
    if (duplicateCount <= 1) {
        return title;
    }

    return `${title} (${window.id})`;
}

function getOtherWindows(sourceWindowId: number) {
    return sortBy(
        getAllRegisteredAppWindows().filter(window => window.id !== sourceWindowId),
        [window => window.id],
    );
}

function buildDuplicateWindowTitleMap(windows: BrowserWindow[]) {
    return countBy(windows, window => (window.getTitle() || te('app.title')).trim() || te('app.title'));
}

function sendWindowTabsAction(sourceWindowId: number | null, action: TWindowTabsAction) {
    const sourceWindow = sourceWindowId === null
        ? getFocusedAppWindow()
        : (getWindowByIdFromRegistry(sourceWindowId) ?? getFocusedAppWindow());

    if (!sourceWindow) {
        return;
    }

    sendToWindow(sourceWindow, WINDOW_TABS_ACTION_CHANNEL, action);
}

function buildMoveToWindowSubmenu(
    sourceWindowId: number,
    tabId: string | undefined,
): MenuItemConstructorOptions[] {
    return buildWindowTargetSubmenu(sourceWindowId, window => ({
        kind: 'move-tab-to-window',
        targetWindowId: window.id,
        ...(tabId ? { tabId } : {}),
    }));
}

function buildWindowTargetSubmenu(
    sourceWindowId: number,
    createAction: (window: BaseWindow) => TWindowTabsAction,
): MenuItemConstructorOptions[] {
    const otherWindows = getOtherWindows(sourceWindowId);
    if (otherWindows.length === 0) {
        return [{
            label: te('menu.noOtherWindows'),
            enabled: false,
        }];
    }

    const duplicateCounts = buildDuplicateWindowTitleMap(otherWindows);

    return otherWindows.map((window) => ({
        label: getWindowDisplayLabel(window, duplicateCounts),
        click: () => {
            sendWindowTabsAction(sourceWindowId, createAction(window));
        },
    }));
}

export function sendToWindow(window: BaseWindow | undefined | null, channel: string, ...args: unknown[]) {
    if (!(window instanceof BrowserWindow) || window.isDestroyed() || window.webContents.isDestroyed()) {
        return false;
    }

    try {
        window.webContents.send(channel, ...args);
        return true;
    } catch (error) {
        const message = getErrorMessage(error);
        // Menu clicks can race with window teardown; avoid surfacing this as a main-process crash.
        logger.warn(`Failed to send "${channel}" to renderer: ${message}`);
        return false;
    }
}

function rebuildMenuNow() {
    Menu.setApplicationMenu(null);
}

function rebuildMenu(immediate = false) {
    if (immediate) {
        if (menuRebuildTimer) {
            clearTimeout(menuRebuildTimer);
            menuRebuildTimer = null;
        }
        menuRebuildPending = false;
        rebuildMenuNow();
        return;
    }

    menuRebuildPending = true;
    if (menuRebuildTimer) {
        return;
    }

    menuRebuildTimer = setTimeout(() => {
        menuRebuildTimer = null;

        if (!menuRebuildPending) {
            return;
        }
        menuRebuildPending = false;
        rebuildMenuNow();
    }, MENU_REBUILD_DEBOUNCE_MS);
}

function rebuildMenuForWindowStateChange(windowId: number) {
    const focusedWindow = getFocusedAppWindow();
    rebuildMenu(focusedWindow?.id === windowId);
}

function trackWindowForMenu(window: BrowserWindow) {
    if (trackedWindowIds.has(window.id)) {
        return;
    }

    trackedWindowIds.add(window.id);

    window.on('page-title-updated', () => {
        rebuildMenu();
    });

    window.on('closed', () => {
        trackedWindowIds.delete(window.id);
        menuDocumentStateByWindow.delete(window.id);
        menuSaveStateByWindow.delete(window.id);
        menuRepairSaveStateByWindow.delete(window.id);
        menuTabCountByWindow.delete(window.id);
        rebuildMenu();
    });
}

function registerMenuListeners() {
    if (listenersRegistered) {
        return;
    }

    listenersRegistered = true;

    app.on('browser-window-focus', () => {
        rebuildMenu();
    });

    app.on('browser-window-blur', () => {
        rebuildMenu();
    });

    app.on('browser-window-created', (_event, window) => {
        trackWindowForMenu(window);
        rebuildMenu();
    });

}

export function setupMenu() {
    registerMenuListeners();
    for (const window of getAllRegisteredAppWindows()) {
        trackWindowForMenu(window);
    }
    rebuildMenu(true);
}

export function updateRecentFilesMenu() {
    rebuildMenu();
}

export function refreshMenu() {
    rebuildMenu(true);
}

export function setMenuDocumentState(windowId: number, state: boolean | {
    hasDocument: boolean;
    canSave: boolean;
    canRepairSave?: boolean;
}) {
    const normalizedDocument = typeof state === 'boolean'
        ? Boolean(state)
        : Boolean(state.hasDocument);
    const normalizedSave = typeof state === 'boolean'
        ? normalizedDocument
        : Boolean(state.canSave);
    const normalizedRepairSave = typeof state === 'boolean'
        ? normalizedDocument
        : state.canRepairSave ?? normalizedDocument;
    if (
        menuDocumentStateByWindow.get(windowId) === normalizedDocument
        && menuSaveStateByWindow.get(windowId) === normalizedSave
        && menuRepairSaveStateByWindow.get(windowId) === normalizedRepairSave
    ) {
        return;
    }

    menuDocumentStateByWindow.set(windowId, normalizedDocument);
    menuSaveStateByWindow.set(windowId, normalizedSave);
    menuRepairSaveStateByWindow.set(windowId, normalizedRepairSave);
    rebuildMenuForWindowStateChange(windowId);
}

export function setMenuTabCount(windowId: number, tabCount: number) {
    const normalized = Number.isFinite(tabCount)
        ? Math.max(0, Math.floor(tabCount))
        : 0;
    if (menuTabCountByWindow.get(windowId) === normalized) {
        return;
    }

    menuTabCountByWindow.set(windowId, normalized);
    rebuildMenuForWindowStateChange(windowId);
}

export function showTabContextMenu(window: BrowserWindow, tabId: string) {
    const normalizedTabId = tabId.trim();
    if (!normalizedTabId || window.isDestroyed()) {
        return;
    }

    const sourceWindowId = window.id;
    const hasTargets = getOtherWindows(sourceWindowId).length > 0;
    const canMoveToNewWindow = getWindowTabCount(window) > 1;

    const menu = Menu.buildFromTemplate([
        {
            label: te('menu.closeTab'),
            click: () => {
                sendWindowTabsAction(sourceWindowId, {
                    kind: 'close-tab',
                    tabId: normalizedTabId,
                });
            },
        },
        { type: 'separator' },
        {
            label: te('menu.moveTabToNewWindow'),
            enabled: canMoveToNewWindow,
            click: () => {
                sendWindowTabsAction(sourceWindowId, {
                    kind: 'move-tab-to-new-window',
                    tabId: normalizedTabId,
                });
            },
        },
        {
            label: te('menu.moveTabToWindow'),
            enabled: hasTargets,
            submenu: buildMoveToWindowSubmenu(sourceWindowId, normalizedTabId),
        },
    ]);

    menu.popup({ window });
}
