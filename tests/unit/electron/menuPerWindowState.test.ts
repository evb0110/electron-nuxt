import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IMenuItemLike {
    label?: string;
    enabled?: boolean;
    role?: string;
    type?: string;
    checked?: boolean;
    click?: (item: unknown, window?: unknown) => unknown;
    submenu?: IMenuItemLike[] | unknown;
}

interface IMenuPerWindowStateTestWindow {
    id: number;
    webContents: {
        send: ReturnType<typeof vi.fn>;
        copy: ReturnType<typeof vi.fn>;
        cut: ReturnType<typeof vi.fn>;
        paste: ReturnType<typeof vi.fn>;
        selectAll: ReturnType<typeof vi.fn>;
        undo: ReturnType<typeof vi.fn>;
        redo: ReturnType<typeof vi.fn>;
        executeJavaScript: ReturnType<typeof vi.fn>;
        isDestroyed: ReturnType<typeof vi.fn>;
    };
    close: () => void;
    isDestroyed: () => boolean;
    getTitle: () => string;
    on: (event: string, handler: (...args: unknown[]) => void) => IMenuPerWindowStateTestWindow;
}

const mocks = vi.hoisted(() => ({
    windows: [] as IMenuPerWindowStateTestWindow[],
    buildFromTemplate: vi.fn((template: unknown) => ({
        popup: vi.fn(),
        template,
    })),
    setApplicationMenu: vi.fn(),
    appListeners: new Map<string, (...args: unknown[]) => void>(),
    createWindow: ((_id: number, _title: string): IMenuPerWindowStateTestWindow => {
        throw new Error('createWindow mock not initialized');
    }),
    focusWindow: ((_window: IMenuPerWindowStateTestWindow | null): void => {
        throw new Error('focusWindow mock not initialized');
    }),
}));

vi.mock('electron', () => {
    class MockBrowserWindow {
        static focusedWindow: MockBrowserWindow | null = null;

        readonly id: number;

        private title: string;

        private destroyed = false;

        private handlers = new Map<string, Array<(...args: unknown[]) => void>>();

        readonly webContents = {
            send: vi.fn(),
            copy: vi.fn(),
            cut: vi.fn(),
            paste: vi.fn(),
            selectAll: vi.fn(),
            undo: vi.fn(),
            redo: vi.fn(),
            executeJavaScript: vi.fn(async () => false),
            isDestroyed: vi.fn(() => false),
        };

        constructor(id: number, title: string) {
            this.id = id;
            this.title = title;
        }

        static getFocusedWindow() {
            return MockBrowserWindow.focusedWindow;
        }

        isDestroyed() {
            return this.destroyed;
        }

        getTitle() {
            return this.title;
        }

        on(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        }

        close() {
            this.destroyed = true;
            const listeners = this.handlers.get('closed') ?? [];
            for (const listener of listeners) {
                listener();
            }
        }
    }

    mocks.createWindow = (id: number, title: string) => new MockBrowserWindow(id, title);
    mocks.focusWindow = (window: IMenuPerWindowStateTestWindow | null) => {
        MockBrowserWindow.focusedWindow = window as MockBrowserWindow | null;
    };

    return {
        app: {
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                mocks.appListeners.set(event, handler);
            }),
            quit: vi.fn(),
            showAboutPanel: vi.fn(),
        },
        BrowserWindow: MockBrowserWindow,
        Menu: {
            buildFromTemplate: mocks.buildFromTemplate,
            setApplicationMenu: mocks.setApplicationMenu,
        },
    };
});

vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: () => mocks.windows,
    getWindowByIdFromRegistry: (windowId: number) =>
        mocks.windows.find(window => window.id === windowId) ?? null,
}));

vi.mock('@electron/recentFiles', () => ({getRecentFilesSync: () => []}));

vi.mock('@electron/te', () => ({te: (key: string) => key}));

vi.mock('@electron/config', () => ({config: {isMac: false}}));

const {
    setupMenu,
    setMenuDocumentState,
    setMenuTabCount,
    refreshMenu,
} = await import('@electron/menu');

function getLastMenuTemplate() {
    const lastCall = mocks.buildFromTemplate.mock.calls.at(-1);
    return (lastCall?.[0] as IMenuItemLike[] | undefined) ?? [];
}

async function waitForMenuClickTasks() {
    await Promise.resolve();
    await Promise.resolve();
}

function isSaveEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const saveItem = submenu.find(item => item.label === 'menu.save');
    return Boolean(saveItem?.enabled);
}

function isSaveAsEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const saveAsItem = submenu.find(item => item.label === 'menu.saveAs');
    return Boolean(saveAsItem?.enabled);
}

function isRepairSaveEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const repairSaveItem = submenu.find(item => item.label === 'menu.repairAndSave');
    return Boolean(repairSaveItem?.enabled);
}

function isOptimizePdfEnabled(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    const submenu = Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
    const optimizeItem = submenu.find(item => item.label === 'menu.optimizePdfForInteraction');
    return Boolean(optimizeItem?.enabled);
}

function getFileMenuSubmenu(template: IMenuItemLike[]) {
    const fileMenu = template.find(item => item.label === 'menu.file');
    return Array.isArray(fileMenu?.submenu) ? fileMenu.submenu : [];
}

function isMoveToNewWindowEnabled(template: IMenuItemLike[]) {
    const windowMenu = template.find(item => item.label === 'menu.window');
    const submenu = Array.isArray(windowMenu?.submenu) ? windowMenu.submenu : [];
    const moveItem = submenu.find(item => item.label === 'menu.moveActiveTabToNewWindow');
    return Boolean(moveItem?.enabled);
}

function getEditMenuSubmenu(template: IMenuItemLike[]) {
    const editMenu = template.find(item => item.label === 'menu.edit');
    return Array.isArray(editMenu?.submenu) ? editMenu.submenu : [];
}

function getViewMenuSubmenu(template: IMenuItemLike[]) {
    const viewMenu = template.find(item => item.label === 'menu.view');
    return Array.isArray(viewMenu?.submenu) ? viewMenu.submenu : [];
}

describe('menu per-window document state', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.windows.length = 0;
        mocks.focusWindow(null);
    });

    it('uses focused window document state independently', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        const secondWindow = mocks.createWindow(2, 'Second Window');

        mocks.windows.push(
            firstWindow,
            secondWindow,
        );

        mocks.focusWindow(firstWindow);
        setupMenu();

        setMenuDocumentState(1, true);
        setMenuDocumentState(2, false);

        let template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);

        mocks.focusWindow(secondWindow);
        refreshMenu();

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(false);

        setMenuDocumentState(2, true);
        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);

        mocks.focusWindow(firstWindow);
        refreshMenu();

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);
    });

    it('disables save while keeping document actions enabled when a document is clean', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
        });

        const template = getLastMenuTemplate();
        const fileSubmenu = getFileMenuSubmenu(template);

        expect(isSaveEnabled(template)).toBe(false);
        expect(isSaveAsEnabled(template)).toBe(true);
        expect(isRepairSaveEnabled(template)).toBe(true);
        expect(isOptimizePdfEnabled(template)).toBe(true);
        expect(fileSubmenu.find(item => item.label === 'menu.print')?.enabled).toBe(true);
    });

    it('tracks save-as availability separately from document and save state', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: true,
            canSaveAs: false,
        });

        let template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(true);
        expect(isSaveAsEnabled(template)).toBe(false);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canSaveAs: true,
        });

        template = getLastMenuTemplate();
        expect(isSaveEnabled(template)).toBe(false);
        expect(isSaveAsEnabled(template)).toBe(true);
    });

    it('tracks optimize availability separately from repair availability', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        mocks.windows.push(firstWindow);
        mocks.focusWindow(firstWindow);

        setupMenu();
        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: false,
        });

        let template = getLastMenuTemplate();
        expect(isRepairSaveEnabled(template)).toBe(true);
        expect(isOptimizePdfEnabled(template)).toBe(false);

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            canRepairSave: true,
            canOptimizePdf: true,
        });

        template = getLastMenuTemplate();
        expect(isOptimizePdfEnabled(template)).toBe(true);
    });

    it('disables move-to-new-window when focused window has one tab', () => {
        const firstWindow = mocks.createWindow(1, 'First Window');
        const secondWindow = mocks.createWindow(2, 'Second Window');

        mocks.windows.push(
            firstWindow,
            secondWindow,
        );

        mocks.focusWindow(firstWindow);
        setupMenu();

        setMenuTabCount(1, 1);

        let template = getLastMenuTemplate();
        expect(isMoveToNewWindowEnabled(template)).toBe(false);

        setMenuTabCount(1, 2);
        template = getLastMenuTemplate();
        expect(isMoveToNewWindowEnabled(template)).toBe(true);
    });

    it('keeps native edit roles available for focused text inputs', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        const roles = getEditMenuSubmenu(getLastMenuTemplate())
            .map(item => item.role)
            .filter(Boolean);

        expect(roles).toEqual(expect.arrayContaining([
            'cut',
            'copy',
            'paste',
            'selectAll',
        ]));
    });

    it('installs the built native application menu instead of clearing it', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        const builtMenu = mocks.buildFromTemplate.mock.results.at(-1)?.value;
        expect(builtMenu).toBeDefined();
        expect(mocks.setApplicationMenu).toHaveBeenLastCalledWith(builtMenu);
        expect(mocks.setApplicationMenu).not.toHaveBeenCalledWith(null);
    });

    it('adds print current page to the native file menu', () => {
        const window = mocks.createWindow(1, 'Window');

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const printCurrentPageItem = getFileMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.printCurrentPage');

        expect(printCurrentPageItem?.enabled).toBe(true);
        printCurrentPageItem?.click?.({}, window);
        expect(window.webContents.send).toHaveBeenCalledWith('menu:printCurrentPage');
    });

    it('shows a capability-aware checked continuous-scroll command', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: true,
            canContinuousScroll: true,
            continuousScroll: true,
        });

        const item = getViewMenuSubmenu(getLastMenuTemplate())
            .find(candidate => candidate.label === 'zoom.continuousScroll');
        expect(item).toMatchObject({
            enabled: true,
            type: 'checkbox',
            checked: true,
        });
        item?.click?.({}, window);
        expect(window.webContents.send).toHaveBeenCalledWith('menu:toggleContinuousScroll');
    });

    it('disables View commands while the active document is still opening', () => {
        const window = mocks.createWindow(1, 'Window');
        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();

        setMenuDocumentState(1, {
            hasDocument: true,
            canSave: false,
            interactive: false,
            canContinuousScroll: true,
            continuousScroll: true,
        });

        const viewItems = getViewMenuSubmenu(getLastMenuTemplate());
        expect(viewItems.find(item => item.label === 'menu.zoomIn')?.enabled).toBe(false);
        expect(viewItems.find(item => item.label === 'zoom.continuousScroll')?.enabled).toBe(false);
    });

    it('routes undo to the focused text input instead of the document action', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockResolvedValueOnce(true);

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).toHaveBeenCalledOnce();
        expect(window.webContents.send).not.toHaveBeenCalledWith('menu:undo');
    });

    it('does not invoke native undo when the window closes during the text focus probe', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockImplementationOnce(async () => {
            window.close();
            return true;
        });

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).not.toHaveBeenCalled();
        expect(window.webContents.send).not.toHaveBeenCalledWith('menu:undo');
    });

    it('routes undo to the document action when text input is not focused', async () => {
        const window = mocks.createWindow(1, 'Window');
        window.webContents.executeJavaScript.mockResolvedValueOnce(false);

        mocks.windows.push(window);
        mocks.focusWindow(window);
        setupMenu();
        setMenuDocumentState(1, true);

        const undoItem = getEditMenuSubmenu(getLastMenuTemplate())
            .find(item => item.label === 'menu.undo');
        undoItem?.click?.({}, window);
        await waitForMenuClickTasks();

        expect(window.webContents.undo).not.toHaveBeenCalled();
        expect(window.webContents.send).toHaveBeenCalledWith('menu:undo');
    });
});
