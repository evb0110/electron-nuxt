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
import { basename } from 'path';
import type { TWindowTabsAction } from '@contracts/windowTabs';
import { config } from '@electron/config';
import { createLogger } from '@electron/utils/createLogger';
import { getRecentFilesSync } from '@electron/recentFiles';
import { te } from '@electron/te';
import {
    DOCUMENTS_EVENT_CHANNELS,
    type IDocumentsEventMap,
} from '@electron/features/documents/contract';
import {
    CORE_IPC_EVENT_CHANNELS,
    type ICoreEventMap,
} from '@electron/platform-ipc/coreContract';
import {
    getAllRegisteredAppWindows,
    getWindowByIdFromRegistry,
} from '@electron/window/registry';
import { getErrorMessage } from '@electron/utils/error';

const appName = te('app.title');
const logger = createLogger('menu');
const MENU_REBUILD_DEBOUNCE_MS = 40;
const menuDocumentStateByWindow = new Map<number, boolean>();
const menuSaveStateByWindow = new Map<number, boolean>();
const menuRepairSaveStateByWindow = new Map<number, boolean>();
const menuTabCountByWindow = new Map<number, number>();
const trackedWindowIds = new Set<number>();
let listenersRegistered = false;
let menuRebuildTimer: ReturnType<typeof setTimeout> | null = null;
let menuRebuildPending = false;

type TNativeMenuEventMap = IDocumentsEventMap & Pick<
    ICoreEventMap,
    | typeof CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates
    | typeof CORE_IPC_EVENT_CHANNELS.updatesStatus
    | typeof CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction
    | typeof CORE_IPC_EVENT_CHANNELS.menuNewTab
    | typeof CORE_IPC_EVENT_CHANNELS.menuCloseTab
    | typeof CORE_IPC_EVENT_CHANNELS.menuSplitEditor
    | typeof CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane
    | typeof CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane
    | typeof CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane
>;
type TNativeMenuChannel = Extract<keyof TNativeMenuEventMap, string>;
type TNativeMenuArgs<TChannel extends TNativeMenuChannel> =
    TNativeMenuEventMap[TChannel] extends undefined ? [] : [TNativeMenuEventMap[TChannel]];

interface IWindowMenuActionOptions<TChannel extends TNativeMenuChannel = TNativeMenuChannel> {
    label: string;
    channel: TChannel;
    accelerator?: string;
    enabled?: boolean;
    args?: TNativeMenuArgs<TChannel>;
}

interface ITextAwareWindowMenuActionOptions<TChannel extends TNativeMenuChannel = TNativeMenuChannel>
    extends IWindowMenuActionOptions<TChannel> {nativeEditCommand: 'undo' | 'redo';}

const TEXT_EDITING_FOCUS_SCRIPT = `
(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) {
        return false;
    }
    return element.isContentEditable
        || Boolean(element.closest('[contenteditable="true"], [contenteditable=""]'))
        || element instanceof HTMLInputElement
        || element instanceof HTMLTextAreaElement;
})()
`;

function getFocusedAppWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        return focusedWindow;
    }

    const windows = getAllRegisteredAppWindows();
    return windows[0] ?? null;
}

function resolveWindowFromMenuContext(window: BaseWindow | undefined) {
    if (window instanceof BrowserWindow && !window.isDestroyed()) {
        return window;
    }

    return getFocusedAppWindow();
}

function getWindowDocumentState(window: BrowserWindow | null) {
    if (!window) {
        return false;
    }

    return menuDocumentStateByWindow.get(window.id) ?? false;
}

function getWindowSaveState(window: BrowserWindow | null) {
    if (!window) {
        return false;
    }

    return menuSaveStateByWindow.get(window.id) ?? getWindowDocumentState(window);
}

function getWindowRepairSaveState(window: BrowserWindow | null) {
    if (!window) {
        return false;
    }

    return menuRepairSaveStateByWindow.get(window.id) ?? getWindowDocumentState(window);
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

    sendToWindow(sourceWindow, CORE_IPC_EVENT_CHANNELS.menuWindowTabsAction, action);
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

function buildMergeWindowSubmenu(sourceWindowId: number): MenuItemConstructorOptions[] {
    return buildWindowTargetSubmenu(sourceWindowId, window => ({
        kind: 'merge-window-into',
        targetWindowId: window.id,
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

export function sendToWindow<TChannel extends TNativeMenuChannel>(
    window: BaseWindow | undefined | null,
    channel: TChannel,
    ...args: TNativeMenuArgs<TChannel>
) {
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

function createWindowMenuAction<TChannel extends TNativeMenuChannel>(
    options: IWindowMenuActionOptions<TChannel>,
): MenuItemConstructorOptions {
    const {
        label,
        channel,
        accelerator,
        enabled = true,
    } = options;
    const args = options.args ?? ([] as TNativeMenuArgs<TChannel>);

    return {
        label,
        ...(accelerator ? { accelerator } : {}),
        enabled,
        click: (_item, window) => {
            sendToWindow(resolveWindowFromMenuContext(window), channel, ...args);
        },
    };
}

async function isTextEditingFocused(window: BrowserWindow) {
    try {
        return Boolean(await window.webContents.executeJavaScript(TEXT_EDITING_FOCUS_SCRIPT, true));
    } catch (error) {
        logger.warn(`Failed to inspect focused edit target: ${getErrorMessage(error)}`);
        return false;
    }
}

function createTextAwareWindowMenuAction<TChannel extends TNativeMenuChannel>(
    options: ITextAwareWindowMenuActionOptions<TChannel>,
): MenuItemConstructorOptions {
    const {
        label,
        channel,
        accelerator,
        enabled = true,
        nativeEditCommand,
    } = options;
    const args = options.args ?? ([] as TNativeMenuArgs<TChannel>);

    return {
        label,
        ...(accelerator ? { accelerator } : {}),
        click: (_item, window) => {
            void (async () => {
                const targetWindow = resolveWindowFromMenuContext(window);
                if (!targetWindow) {
                    return;
                }

                if (await isTextEditingFocused(targetWindow)) {
                    if (targetWindow.isDestroyed() || targetWindow.webContents.isDestroyed()) {
                        return;
                    }

                    try {
                        targetWindow.webContents[nativeEditCommand]();
                    } catch (error) {
                        logger.warn(`Failed to invoke native ${nativeEditCommand}: ${getErrorMessage(error)}`);
                    }
                    return;
                }

                if (enabled) {
                    sendToWindow(targetWindow, channel, ...args);
                }
            })().catch(error => logger.warn(`Failed to handle menu action "${channel}": ${getErrorMessage(error)}`));
        },
    };
}

function buildRecentFilesSubmenu(): MenuItemConstructorOptions[] {
    const recentFiles = getRecentFilesSync();

    if (recentFiles.length === 0) {
        return [{
            label: te('menu.noRecentFiles'),
            enabled: false,
        }];
    }

    const fileItems: MenuItemConstructorOptions[] = recentFiles.map((filePath) => ({
        label: basename(filePath),
        click: (_, window) => {
            sendToWindow(resolveWindowFromMenuContext(window), DOCUMENTS_EVENT_CHANNELS.menuOpenRecentFile, filePath);
        },
    }));

    return [
        ...fileItems,
        { type: 'separator' },
        {
            label: te('menu.clearRecentFiles'),
            click: (_, window) => {
                sendToWindow(resolveWindowFromMenuContext(window), DOCUMENTS_EVENT_CHANNELS.menuClearRecentFiles);
            },
        },
    ];
}

function getFileMenu(
    documentActionsEnabled: boolean,
    saveActionEnabled: boolean,
    repairSaveActionEnabled: boolean,
): MenuItemConstructorOptions {
    return {
        label: te('menu.file'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.openFile'),
                accelerator: 'CmdOrCtrl+O',
                channel: DOCUMENTS_EVENT_CHANNELS.menuOpenPdf,
            }),
            {
                label: te('menu.openRecent'),
                submenu: buildRecentFilesSubmenu(),
            },
            createWindowMenuAction({
                label: te('menu.save'),
                accelerator: 'CmdOrCtrl+S',
                enabled: saveActionEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuSave,
            }),
            createWindowMenuAction({
                label: te('menu.repairAndSave'),
                enabled: repairSaveActionEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuRepairSave,
            }),
            createWindowMenuAction({
                label: te('menu.optimizePdfForInteraction'),
                enabled: repairSaveActionEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuOptimizePdfForInteraction,
            }),
            createWindowMenuAction({
                label: te('menu.saveAs'),
                accelerator: 'CmdOrCtrl+Shift+S',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuSaveAs,
            }),
            createWindowMenuAction({
                label: te('menu.print'),
                accelerator: 'CmdOrCtrl+P',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuPrint,
            }),
            createWindowMenuAction({
                label: te('menu.printCurrentPage'),
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuPrintCurrentPage,
            }),
            {
                label: te('menu.export'),
                enabled: documentActionsEnabled,
                submenu: [
                    createWindowMenuAction({
                        label: te('menu.exportDocx'),
                        accelerator: 'CmdOrCtrl+Shift+E',
                        channel: DOCUMENTS_EVENT_CHANNELS.menuExportDocx,
                    }),
                    createWindowMenuAction({
                        label: te('menu.exportImages'),
                        channel: DOCUMENTS_EVENT_CHANNELS.menuExportImages,
                    }),
                    createWindowMenuAction({
                        label: te('menu.exportMultiPageTiff'),
                        channel: DOCUMENTS_EVENT_CHANNELS.menuExportMultiPageTiff,
                    }),
                ],
            },
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.newTab'),
                accelerator: 'CmdOrCtrl+T',
                channel: CORE_IPC_EVENT_CHANNELS.menuNewTab,
            }),
            createWindowMenuAction({
                label: te('menu.closeTab'),
                accelerator: 'CmdOrCtrl+W',
                channel: CORE_IPC_EVENT_CHANNELS.menuCloseTab,
            }),
            ...(config.isMac ? [] : [
                { type: 'separator' as const },
                {
                    label: te('menu.quit'),
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => {
                        app.quit();
                    },
                },
            ]),
        ],
    };
}

function getEditMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.actions'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.insertImageFromFile'),
                accelerator: 'CmdOrCtrl+Shift+I',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuInsertImageFromFile,
            }),
            createWindowMenuAction({
                label: te('menu.pasteImageFromClipboard'),
                accelerator: 'CmdOrCtrl+Shift+V',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuPasteImageFromClipboard,
            }),
            { type: 'separator' },
            createTextAwareWindowMenuAction({
                label: te('menu.undo'),
                accelerator: 'CmdOrCtrl+Z',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuUndo,
                nativeEditCommand: 'undo',
            }),
            createTextAwareWindowMenuAction({
                label: te('menu.redo'),
                accelerator: config.isMac ? 'Cmd+Shift+Z' : 'Ctrl+Y',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuRedo,
                nativeEditCommand: 'redo',
            }),
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' },
        ],
    };
}

function getPagesMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.pages'),
        enabled: documentActionsEnabled,
        submenu: [
            createWindowMenuAction({
                label: te('menu.deleteSelectedPages'),
                channel: DOCUMENTS_EVENT_CHANNELS.menuDeletePages,
            }),
            createWindowMenuAction({
                label: te('menu.extractSelectedPages'),
                channel: DOCUMENTS_EVENT_CHANNELS.menuExtractPages,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.rotateClockwise'),
                channel: DOCUMENTS_EVENT_CHANNELS.menuRotateCw,
            }),
            createWindowMenuAction({
                label: te('menu.rotateCounterclockwise'),
                channel: DOCUMENTS_EVENT_CHANNELS.menuRotateCcw,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.insertPages'),
                channel: DOCUMENTS_EVENT_CHANNELS.menuInsertPages,
            }),
        ],
    };
}

function getViewMenu(documentActionsEnabled: boolean): MenuItemConstructorOptions {
    return {
        label: te('menu.view'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.zoomIn'),
                accelerator: 'CmdOrCtrl+=',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuZoomIn,
            }),
            createWindowMenuAction({
                label: te('menu.zoomOut'),
                accelerator: 'CmdOrCtrl+-',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuZoomOut,
            }),
            createWindowMenuAction({
                label: te('menu.actualSize'),
                accelerator: 'CmdOrCtrl+0',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuActualSize,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.fitWidth'),
                accelerator: 'CmdOrCtrl+1',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuFitWidth,
            }),
            createWindowMenuAction({
                label: te('menu.fitHeight'),
                accelerator: 'CmdOrCtrl+2',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuFitHeight,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.singlePage'),
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuViewModeSingle,
            }),
            createWindowMenuAction({
                label: te('menu.facingPages'),
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuViewModeFacing,
            }),
            createWindowMenuAction({
                label: te('menu.facingWithFirstSingle'),
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuViewModeFacingFirstSingle,
            }),
            { type: 'separator' },
            createWindowMenuAction({
                label: te('menu.assistant'),
                accelerator: 'CmdOrCtrl+Shift+A',
                enabled: documentActionsEnabled,
                channel: DOCUMENTS_EVENT_CHANNELS.menuToggleAssistant,
            }),
            { type: 'separator' },
            {
                label: te('menu.editorPanes'),
                submenu: [
                    {
                        label: te('menu.splitEditor'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.splitEditorRight'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuSplitEditor,
                                accelerator: 'CmdOrCtrl+\\',
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorLeft'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuSplitEditor,
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorUp'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuSplitEditor,
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.splitEditorDown'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuSplitEditor,
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.focusEditorPane'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.focusPaneRight'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane,
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusPaneLeft'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane,
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusPaneUp'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane,
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.focusPaneDown'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuFocusEditorPane,
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.moveTabToPane'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.moveTabRight'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane,
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabLeft'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane,
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabUp'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane,
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.moveTabDown'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuMoveTabToPane,
                                args: ['down'],
                            }),
                        ],
                    },
                    {
                        label: te('menu.copyTabToPane'),
                        submenu: [
                            createWindowMenuAction({
                                label: te('menu.copyTabRight'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane,
                                args: ['right'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabLeft'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane,
                                args: ['left'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabUp'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane,
                                args: ['up'],
                            }),
                            createWindowMenuAction({
                                label: te('menu.copyTabDown'),
                                channel: CORE_IPC_EVENT_CHANNELS.menuCopyTabToPane,
                                args: ['down'],
                            }),
                        ],
                    },
                ],
            },
            { type: 'separator' },
            { role: 'toggleDevTools' },
        ],
    };
}

function getWindowMenu(activeWindow: BrowserWindow | null): MenuItemConstructorOptions {
    const sourceWindowId = activeWindow?.id ?? null;
    const hasTargets = sourceWindowId === null
        ? false
        : getOtherWindows(sourceWindowId).length > 0;
    const canMoveActiveTabToNewWindow = getWindowTabCount(activeWindow) > 1;

    return {
        label: te('menu.window'),
        submenu: [
            { role: 'minimize' },
            { role: 'close' },
            { type: 'separator' },
            {
                label: te('menu.moveActiveTabToNewWindow'),
                enabled: sourceWindowId !== null && canMoveActiveTabToNewWindow,
                click: () => {
                    sendWindowTabsAction(sourceWindowId, {kind: 'move-tab-to-new-window'});
                },
            },
            {
                label: te('menu.moveActiveTabToWindow'),
                enabled: sourceWindowId !== null && hasTargets,
                submenu: sourceWindowId === null
                    ? [{
                        label: te('menu.noOtherWindows'),
                        enabled: false,
                    }]
                    : buildMoveToWindowSubmenu(sourceWindowId, undefined),
            },
            {
                label: te('menu.mergeWindowInto'),
                enabled: sourceWindowId !== null && hasTargets,
                submenu: sourceWindowId === null
                    ? [{
                        label: te('menu.noOtherWindows'),
                        enabled: false,
                    }]
                    : buildMergeWindowSubmenu(sourceWindowId),
            },
            ...(config.isMac ? [
                { type: 'separator' as const },
                { role: 'front' as const },
            ] : []),
        ],
    };
}

function getHelpMenu(): MenuItemConstructorOptions {
    return {
        label: te('menu.help'),
        submenu: [
            createWindowMenuAction({
                label: te('menu.checkForUpdates'),
                channel: CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates,
            }),
            { type: 'separator' },
            config.isMac
                ? { role: 'about' }
                : {
                    label: te('menu.about'),
                    click: () => { app.showAboutPanel(); },
                },
        ],
    };
}

function getMacAppMenu(): MenuItemConstructorOptions {
    return {
        label: appName,
        submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
        ],
    };
}

function buildMenuTemplate(activeWindow: BrowserWindow | null): MenuItemConstructorOptions[] {
    const template: MenuItemConstructorOptions[] = [];
    const documentActionsEnabled = getWindowDocumentState(activeWindow);
    const saveActionEnabled = getWindowSaveState(activeWindow);
    const repairSaveActionEnabled = getWindowRepairSaveState(activeWindow);

    if (config.isMac) {
        template.push(getMacAppMenu());
    }

    template.push(
        getFileMenu(documentActionsEnabled, saveActionEnabled, repairSaveActionEnabled),
        getEditMenu(documentActionsEnabled),
        getPagesMenu(documentActionsEnabled),
        getViewMenu(documentActionsEnabled),
        getWindowMenu(activeWindow),
        getHelpMenu(),
    );

    return template;
}

function rebuildMenuNow() {
    const activeWindow = getFocusedAppWindow();
    const template = buildMenuTemplate(activeWindow);
    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
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
