import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => {
    class MockBrowserWindow {
        static windows: MockBrowserWindow[] = [];

        static nextId = 1;

        static getAllWindows() {
            return [...MockBrowserWindow.windows];
        }

        static fromId(windowId: number) {
            return MockBrowserWindow.windows.find(window => window.id === windowId) ?? null;
        }

        readonly id = MockBrowserWindow.nextId++;

        private destroyed = false;

        private maximized = false;

        private visible = false;

        private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

        readonly webContents = {
            forcefullyCrashRenderer: vi.fn(),
            getURL: vi.fn(() => 'http://127.0.0.1:3235'),
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                const existing = this.handlers.get(`webContents:${event}`) ?? [];
                existing.push(handler);
                this.handlers.set(`webContents:${event}`, existing);
            }),
            once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                const wrapped = (...args: unknown[]) => {
                    this.removeListener(`webContents:${event}`, wrapped);
                    handler(...args);
                };
                const existing = this.handlers.get(`webContents:${event}`) ?? [];
                existing.push(wrapped);
                this.handlers.set(`webContents:${event}`, existing);
            }),
            removeListener: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                this.removeListener(`webContents:${event}`, handler);
            }),
            setVisualZoomLevelLimits: vi.fn(async () => {}),
            setWindowOpenHandler: vi.fn(),
            setZoomFactor: vi.fn(),
            setZoomLevel: vi.fn(),
        };

        constructor(_options: unknown) {
            MockBrowserWindow.windows.push(this);
        }

        loadURL = vi.fn(async () => {});

        focus = vi.fn();

        isDestroyed() {
            return this.destroyed;
        }

        isMaximized() {
            return this.maximized;
        }

        isVisible() {
            return this.visible;
        }

        maximize() {
            this.maximized = true;
        }

        on(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        }

        show() {
            this.visible = true;
        }

        private removeListener(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            this.handlers.set(event, existing.filter(listener => listener !== handler));
        }
    }

    return {
        BrowserWindow: MockBrowserWindow,
        app: {
            focus: vi.fn(),
            isPackaged: true,
        },
        clearCache: vi.fn(async () => {}),
        logger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        openExternal: vi.fn(async () => {}),
        setupContentSecurityPolicy: vi.fn(),
        startServer: vi.fn(async () => {}),
        stopServer: vi.fn(async () => {}),
        waitForServer: vi.fn(async () => {}),
    };
});

vi.mock('electron', () => ({
    BrowserWindow: mocks.BrowserWindow,
    app: mocks.app,
    session: {defaultSession: {clearCache: mocks.clearCache}},
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('@electron/config', () => ({config: {
    automation: {
        hideWindow: true,
        noFocus: false,
    },
    isDev: false,
    isMac: false,
    server: {url: 'http://127.0.0.1:3235'},
    window: {
        backgroundColor: '#fff',
        height: 800,
        title: 'EVB Viewer',
        width: 1200,
    },
}}));

vi.mock('@electron/server', () => ({
    startServer: mocks.startServer,
    stopServer: mocks.stopServer,
    waitForServer: mocks.waitForServer,
}));

vi.mock('@electron/security/csp', () => ({setupContentSecurityPolicy: mocks.setupContentSecurityPolicy}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

describe('window runtime readiness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.BrowserWindow.nextId = 1;
        mocks.BrowserWindow.windows.length = 0;
        mocks.startServer.mockReset();
        mocks.stopServer.mockReset();
        mocks.waitForServer.mockReset();
        mocks.startServer.mockResolvedValue(undefined);
        mocks.stopServer.mockResolvedValue(undefined);
    });

    it('restarts the runtime server when a later window detects stale health', async () => {
        mocks.waitForServer
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('runtime server stopped responding'))
            .mockResolvedValueOnce(undefined);

        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();
        await createAppWindow();

        expect(mocks.startServer).toHaveBeenCalledTimes(2);
        expect(mocks.stopServer).toHaveBeenCalledTimes(1);
        expect(mocks.waitForServer).toHaveBeenCalledTimes(3);
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Runtime server health check failed; restarting before retry'),
        );
    });
});
