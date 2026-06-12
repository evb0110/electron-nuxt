import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IHostZenEscapeTestWindow {
    id: number;
    webContents: {
        focus: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        removeListener: ReturnType<typeof vi.fn>;
        send: ReturnType<typeof vi.fn>;
    };
    focus: ReturnType<typeof vi.fn>;
    getBounds: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    isFocused: ReturnType<typeof vi.fn>;
    isFullScreen: ReturnType<typeof vi.fn>;
    isMaximized: ReturnType<typeof vi.fn>;
    isSimpleFullScreen: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    once: ReturnType<typeof vi.fn>;
    removeListener: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
    setFullScreen: ReturnType<typeof vi.fn>;
    setSimpleFullScreen: ReturnType<typeof vi.fn>;
}

const mocks = vi.hoisted(() => ({
    focusedWindow: null as IHostZenEscapeTestWindow | null,
    shortcutHandler: null as (() => void) | null,
    registeredAccelerator: '',
    createWindow: ((_id: number): IHostZenEscapeTestWindow => {
        throw new Error('createWindow mock not initialized');
    }),
}));

vi.mock('electron', () => {
    const MockBrowserWindow = {getFocusedWindow: vi.fn(() => {
        return mocks.focusedWindow;
    })};

    mocks.createWindow = (id: number): IHostZenEscapeTestWindow => {
        let fullScreen = false;
        let simpleFullScreen = false;
        const window: IHostZenEscapeTestWindow = {
            id,
            webContents: {
                focus: vi.fn(),
                on: vi.fn(),
                removeListener: vi.fn(),
                send: vi.fn(),
            },
            focus: vi.fn(),
            getBounds: vi.fn(() => ({
                x: 0,
                y: 0,
                width: 800,
                height: 600,
            })),
            isDestroyed: vi.fn(() => false),
            isFocused: vi.fn(() => mocks.focusedWindow === window),
            isFullScreen: vi.fn(() => fullScreen),
            isMaximized: vi.fn(() => false),
            isSimpleFullScreen: vi.fn(() => simpleFullScreen),
            on: vi.fn(),
            once: vi.fn(),
            removeListener: vi.fn(),
            setBounds: vi.fn(),
            setFullScreen: vi.fn((active: boolean) => {
                fullScreen = active;
            }),
            setSimpleFullScreen: vi.fn((active: boolean) => {
                simpleFullScreen = active;
            }),
        };
        return window;
    };

    return {
        BrowserWindow: MockBrowserWindow,
        globalShortcut: {
            register: vi.fn((accelerator: string, handler: () => void) => {
                mocks.registeredAccelerator = accelerator;
                mocks.shortcutHandler = handler;
                return true;
            }),
            unregister: vi.fn(),
        },
        screen: {
            getDisplayMatching: vi.fn(() => {
                return {workArea: {
                    x: 0,
                    y: 0,
                    width: 800,
                    height: 600,
                }};
            }),
            getDisplayNearestPoint: vi.fn(() => ({scaleFactor: 1})),
            getPrimaryDisplay: vi.fn(() => ({scaleFactor: 1})),
            on: vi.fn(),
        },
    };
});

vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: vi.fn(() => [])}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({warn: vi.fn()})}));
vi.mock('@electron/utils/error', () => ({getErrorMessage: (error: unknown) => String(error)}));

describe('host environment zen Escape handling', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.focusedWindow = null;
        mocks.shortcutHandler = null;
        mocks.registeredAccelerator = '';
    });

    it('exits the focused zen window when multiple windows are in zen mode', async () => {
        const { setHostZenModeForWindow } = await import('@electron/hostEnvironment');
        const firstWindow = mocks.createWindow(1);
        const secondWindow = mocks.createWindow(2);

        await setHostZenModeForWindow(firstWindow as never, true);
        await setHostZenModeForWindow(secondWindow as never, true);

        mocks.focusedWindow = secondWindow;
        mocks.shortcutHandler?.();
        await Promise.resolve();

        expect(mocks.registeredAccelerator).toBe('Esc');
        if (process.platform === 'darwin') {
            expect(firstWindow.setSimpleFullScreen).toHaveBeenCalledWith(true);
            expect(firstWindow.setSimpleFullScreen).not.toHaveBeenCalledWith(false);
            expect(secondWindow.setSimpleFullScreen).toHaveBeenCalledWith(false);
        } else {
            expect(firstWindow.setFullScreen).toHaveBeenCalledWith(true);
            expect(firstWindow.setFullScreen).not.toHaveBeenCalledWith(false);
            expect(secondWindow.setFullScreen).toHaveBeenCalledWith(false);
        }
    });
});
