import type {
    IpcMainInvokeEvent,
    IpcRendererEvent,
} from 'electron';
import { BrowserWindow } from 'electron';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { registerTabsMenuBindings } from '@app/modules/workspace-shell/menu/registerTabsMenuBindings';
import type { IDocumentsService } from '@electron/features/documents/documentsService';
import { createDocumentsPreloadClient } from '@electron/features/documents/createDocumentsPreloadClient';
import { handleOpenPdfDialog } from '@electron/features/documents/main/documentOpenHandlers';
import { handleSavePdfDialog } from '@electron/features/documents/main/documentSaveDialogHandlers';
import { registerDocumentsIpcAdapter } from '@electron/features/documents/registerDocumentsIpcAdapter';
import {
    setMenuDocumentState,
    setupMenu,
} from '@electron/menu';
import type { IWorkspaceExpose } from '@app/types/workspaceExpose';
import { cast } from '@tests/helpers/cast';

interface IMenuItemLike {
    click?: (item: unknown, window?: unknown) => unknown;
    label?: string;
    submenu?: IMenuItemLike[] | unknown;
}

type TInvokeHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
type TRendererListener = (event: IpcRendererEvent, payload?: unknown) => void;

const mocks = vi.hoisted(() => ({
    buildFromTemplate: vi.fn((template: unknown) => ({template})),
    dialog: {
        showOpenDialog: vi.fn(async () => ({
            canceled: true,
            filePaths: [],
        })),
        showSaveDialog: vi.fn(async () => ({
            canceled: false,
            filePath: '/tmp/native-route-output',
        })),
    },
    emitRendererEvent: ((_channel: string, ..._args: unknown[]) => undefined),
    focusedWindow: null as unknown,
    lastMenuTemplate: [] as IMenuItemLike[],
}));

vi.mock('electron', () => {
    class MockBrowserWindow {
        static fromWebContents(sender: unknown) {
            const focused = mocks.focusedWindow as MockBrowserWindow | null;
            return focused?.webContents === sender ? focused : null;
        }

        static getFocusedWindow() {
            return mocks.focusedWindow as MockBrowserWindow | null;
        }

        readonly id: number;

        readonly webContents = {
            copy: vi.fn(),
            cut: vi.fn(),
            executeJavaScript: vi.fn(async () => false),
            isDestroyed: vi.fn(() => false),
            paste: vi.fn(),
            redo: vi.fn(),
            selectAll: vi.fn(),
            send: vi.fn((channel: string, ...args: unknown[]) => mocks.emitRendererEvent(channel, ...args)),
            undo: vi.fn(),
        };

        constructor(id: number) {
            this.id = id;
        }

        getTitle() {
            return 'Routing Test';
        }

        isDestroyed() {
            return false;
        }

        on() {
            return this;
        }
    }

    return {
        app: {
            on: vi.fn(),
            quit: vi.fn(),
            showAboutPanel: vi.fn(),
        },
        BrowserWindow: MockBrowserWindow,
        dialog: mocks.dialog,
        Menu: {
            buildFromTemplate: vi.fn((template: IMenuItemLike[]) => {
                mocks.lastMenuTemplate = template;
                return mocks.buildFromTemplate(template);
            }),
            setApplicationMenu: vi.fn(),
        },
    };
});

vi.mock('@electron/config', () => ({config: {isMac: false}}));
vi.mock('@electron/recentFiles', () => ({getRecentFilesSync: () => []}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: () => mocks.focusedWindow ? [mocks.focusedWindow] : [],
    getWindowByIdFromRegistry: () => mocks.focusedWindow,
}));

function findMenuItem(menuLabel: string, itemLabel: string) {
    const menu = mocks.lastMenuTemplate.find(item => item.label === menuLabel);
    const submenu = Array.isArray(menu?.submenu) ? menu.submenu : [];
    const item = submenu.find(candidate => candidate.label === itemLabel);
    if (!item) {
        throw new Error(`Missing native menu item ${menuLabel} > ${itemLabel}`);
    }
    return item;
}

async function flushCommandRoute() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
}

describe('native menu and dialog routing', () => {
    it('routes native menu commands through preload, workspace, IPC codecs, and the OS dialog boundary', async () => {
        const invokeHandlers = new Map<string, TInvokeHandler>();
        const listeners = new Map<string, Set<TRendererListener>>();
        const window = new BrowserWindow(42 as never);
        mocks.focusedWindow = window;

        const ipcRenderer = cast<Electron.IpcRenderer>({
            invoke: async (channel: string, ...args: unknown[]) => {
                const handler = invokeHandlers.get(channel);
                if (!handler) {
                    throw new Error(`Missing IPC handler for ${channel}`);
                }
                return handler(cast<IpcMainInvokeEvent>({sender: window.webContents}), ...args);
            },
            on: (channel: string, listener: TRendererListener) => {
                const channelListeners = listeners.get(channel) ?? new Set<TRendererListener>();
                channelListeners.add(listener);
                listeners.set(channel, channelListeners);
                return ipcRenderer;
            },
            postMessage: vi.fn(),
            removeListener: (channel: string, listener: TRendererListener) => {
                listeners.get(channel)?.delete(listener);
                return ipcRenderer;
            },
        });
        mocks.emitRendererEvent = (channel: string, ...args: unknown[]) => {
            for (const listener of listeners.get(channel) ?? []) {
                listener({} as IpcRendererEvent, args[0]);
            }
        };

        const service = cast<IDocumentsService>({
            openDocumentDialog: handleOpenPdfDialog,
            savePdfDialog: handleSavePdfDialog,
        });
        registerDocumentsIpcAdapter(
            {handle: (channel: string, handler: TInvokeHandler) => invokeHandlers.set(channel, handler)} as never,
            service,
            {eventRegistrar: {on: vi.fn()}},
        );

        const documents = createDocumentsPreloadClient(ipcRenderer);
        let saveDialogResult: string | null = null;
        const print = vi.fn(async () => undefined);
        const deletePages = vi.fn();
        const workspace = cast<IWorkspaceExpose>({
            handleDeletePages: deletePages,
            handlePrint: print,
            handleSaveAs: async () => {
                saveDialogResult = await documents.savePdfDialog('native-route-output.pdf');
                return saveDialogResult !== null;
            },
        });
        registerTabsMenuBindings(cast<Parameters<typeof registerTabsMenuBindings>[0]>({
            documentMenu: documents,
            djvu: {},
            settings: {},
            updates: {},
            windowTabs: {},
        }), cast<Parameters<typeof registerTabsMenuBindings>[1]>({
            activeTabId: ref('tab-1'),
            activeWorkspace: ref(workspace),
            handleFallbackToolbarOpenFile: async () => {
                await documents.openDocumentDialog();
            },
        }));

        setupMenu();
        setMenuDocumentState(window.id, true);

        findMenuItem('menu.file', 'menu.openFile').click?.({}, window);
        await flushCommandRoute();
        expect(mocks.dialog.showOpenDialog).toHaveBeenCalledWith(window, expect.objectContaining({
            title: 'dialogs.openDocument',
            filters: [{
                name: 'dialogs.documentsFilter',
                extensions: expect.arrayContaining([
                    'pdf',
                    'djvu',
                    'djv',
                ]),
            }],
            properties: [
                'openFile',
                'multiSelections',
            ],
        }));

        findMenuItem('menu.file', 'menu.saveAs').click?.({}, window);
        await flushCommandRoute();
        expect(mocks.dialog.showSaveDialog).toHaveBeenCalledWith(window, {
            title: 'dialogs.savePdf',
            defaultPath: 'native-route-output.pdf',
            filters: [{
                name: 'dialogs.pdfFiles',
                extensions: ['pdf'],
            }],
        });
        expect(saveDialogResult).toBe('/tmp/native-route-output.pdf');

        findMenuItem('menu.file', 'menu.print').click?.({}, window);
        findMenuItem('menu.pages', 'menu.deleteSelectedPages').click?.({}, window);
        await flushCommandRoute();
        expect(print).toHaveBeenCalledOnce();
        expect(deletePages).toHaveBeenCalledOnce();
    });
});
