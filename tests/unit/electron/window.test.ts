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
            getURL: vi.fn(() => 'evb-viewer://app/electron'),
            executeJavaScript: vi.fn(async () => undefined),
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

        loadURL = (...args: Parameters<typeof mocks.loadURL>) => mocks.loadURL(...args);

        destroy = vi.fn(() => {
            this.destroyed = true;
            this.emit('closed');
        });

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

        maximize = vi.fn(() => {
            this.maximized = true;
            this.visible = true;
        });

        on(event: string, handler: (...args: unknown[]) => void) {
            const existing = this.handlers.get(event) ?? [];
            existing.push(handler);
            this.handlers.set(event, existing);
            return this;
        }

        emit(event: string, ...args: unknown[]) {
            const handlers = [...(this.handlers.get(event) ?? [])];
            for (const handler of handlers) {
                handler(...args);
            }
            return handlers.length > 0;
        }

        emitWebContents(event: string, ...args: unknown[]) {
            const handlers = [...(this.handlers.get(`webContents:${event}`) ?? [])];
            for (const handler of handlers) {
                handler(...args);
            }
            return handlers.length > 0;
        }

        show = vi.fn(() => {
            this.visible = true;
        });

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
        dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
        loadURL: vi.fn(async (_url?: string) => {}),
        logger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        },
        config: {
            automation: {
                hideWindow: true,
                noFocus: false,
            },
            isDev: false,
            isMac: false,
            renderer: {
                trustedOrigin: 'evb-viewer://app',
                url: 'evb-viewer://app/electron',
            },
            server: {url: 'http://127.0.0.1:3235'},
            window: {
                backgroundColor: '#fff',
                height: 800,
                title: 'EVB Viewer',
                width: 1200,
            },
        },
        openExternal: vi.fn(async () => {}),
        setupContentSecurityPolicy: vi.fn(),
        te: vi.fn((key: string) => key),
    };
});

vi.mock('electron', () => ({
    BrowserWindow: mocks.BrowserWindow,
    app: mocks.app,
    dialog: mocks.dialog,
    session: {defaultSession: {clearCache: mocks.clearCache}},
    shell: {openExternal: mocks.openExternal},
}));

vi.mock('@electron/config', () => ({config: mocks.config}));

vi.mock('@electron/config/constants', () => ({WINDOW_RENDERER_READY_TIMEOUT_MS: 30_000}));
vi.mock('@electron/i18n', () => ({te: mocks.te}));

vi.mock('@electron/security/csp', () => ({setupContentSecurityPolicy: mocks.setupContentSecurityPolicy}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

describe('window runtime readiness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.BrowserWindow.nextId = 1;
        mocks.BrowserWindow.windows.length = 0;
        mocks.loadURL.mockReset();
        mocks.loadURL.mockResolvedValue(undefined);
        mocks.config.automation.hideWindow = true;
        mocks.config.automation.noFocus = false;
        mocks.config.isDev = false;
        delete process.env.EVB_CLEAR_RENDERER_CACHE;
    });

    it('waits for the initial rendererReady signal when requested', async () => {
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        markWindowRendererReady(1);

        await expect(createPromise).resolves.toBe(mocks.BrowserWindow.windows[0]);
    });

    it('keeps strict startup hidden until rendererReady', async () => {
        mocks.config.automation.hideWindow = false;
        const { createAppWindow } = await import('@electron/window');
        const { markWindowRendererReady } = await import('@electron/window/rendererReady');

        const createPromise = createAppWindow({ waitForInitialRendererReady: true });
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        expect(mocks.loadURL).not.toHaveBeenCalledWith('about:blank');
        expect(window?.maximize).not.toHaveBeenCalled();
        expect(window?.isVisible()).toBe(false);

        window?.emitWebContents('did-finish-load');
        markWindowRendererReady(1);
        await createPromise;

        await vi.waitFor(() => {
            expect(window?.maximize).toHaveBeenCalledTimes(1);
        });
        expect(window?.isVisible()).toBe(true);
    });

    it('creates the startup window before the renderer load completes', async () => {
        mocks.config.automation.hideWindow = false;
        let resolveLoad: () => void = () => {
            throw new Error('loadURL was not called');
        };
        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                await new Promise<void>((resolve) => {
                    resolveLoad = resolve;
                });
            }
        });
        const { createAppWindow } = await import('@electron/window');

        const createPromise = createAppWindow();
        await vi.waitFor(() => {
            expect(mocks.BrowserWindow.windows).toHaveLength(1);
        });

        const window = mocks.BrowserWindow.windows[0];
        await vi.waitFor(() => {
            expect(mocks.loadURL).toHaveBeenCalledWith(mocks.config.renderer.url);
        });

        resolveLoad();
        await expect(createPromise).resolves.toBe(window);
    });

    it('does not clear the dev renderer cache by default', async () => {
        mocks.config.isDev = true;
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();

        expect(mocks.clearCache).not.toHaveBeenCalled();
    });

    it('clears the dev renderer cache when explicitly requested', async () => {
        mocks.config.isDev = true;
        process.env.EVB_CLEAR_RENDERER_CACHE = '1';
        const { createAppWindow } = await import('@electron/window');

        await createAppWindow();

        expect(mocks.clearCache).toHaveBeenCalledTimes(1);
    });

    it('rejects strict startup when the initial loadURL call fails', async () => {
        const loadError = new Error('renderer bootstrap failed');
        const { createAppWindow } = await import('@electron/window');

        mocks.loadURL.mockImplementation(async (url?: string) => {
            if (url === mocks.config.renderer.url) {
                throw loadError;
            }
        });

        await expect(createAppWindow({ waitForInitialRendererReady: true }))
            .rejects
            .toThrow('Initial loadURL failed: renderer bootstrap failed');

        expect(mocks.BrowserWindow.windows[0]?.destroy).toHaveBeenCalledTimes(1);
    });
});
