import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    IRegisteredEvent,
    TRegisteredHandler,
} from '@tests/unit/electron/helpers/ipcRegistryHarness';

const ipcRegistrySecurityImportTimeoutMs = 10_000;

const mocks = vi.hoisted(() => ({
    events: new Map<string, (event: IRegisteredEvent, ...args: unknown[]) => void>(),
    handlers: new Map<string, TRegisteredHandler>(),
    attachSerializedPdfPersistencePort: vi.fn(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    browserWindowFromWebContents: vi.fn(),
    loadSettings: vi.fn(async () => ({theme: 'system'})),
}));

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
    ipcMain: {
        on: (channel: string, handler: (event: IRegisteredEvent, ...args: unknown[]) => void) => {
            mocks.events.set(channel, handler);
        },
        handle: (channel: string, handler: TRegisteredHandler) => {
            mocks.handlers.set(channel, handler);
        },
    },
    shell: {openExternal: vi.fn()},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@contracts/externalUrl', () => ({sanitizeAllowedExternalUrl: (value: unknown) => value}));
vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: 'http://127.0.0.1:41001/electron'}}}));
vi.mock('@electron/features/documents/registerDocumentsIpcAdapter', () => ({registerDocumentsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/documents/public', () => ({attachSerializedPdfPersistencePort: mocks.attachSerializedPdfPersistencePort}));
vi.mock('@electron/features/djvu/registerDjvuIpcAdapter', () => ({registerDjvuIpcAdapter: vi.fn()}));
vi.mock('@electron/features/image-export/registerImageExportIpcAdapter', () => ({registerImageExportIpcAdapter: vi.fn()}));
vi.mock('@electron/features/ocr/registerOcrIpcAdapter', () => ({registerOcrIpcAdapter: vi.fn()}));
vi.mock('@electron/features/page-ops/registerPageOpsIpcAdapter', () => ({registerPageOpsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/search/registerSearchIpcAdapter', () => ({registerSearchIpcAdapter: vi.fn()}));
vi.mock('@electron/menu', () => ({
    showTabContextMenu: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
}));
vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: vi.fn(),
}));
vi.mock('@electron/windowTabTransfer', () => ({
    acknowledgeWindowTabTransfer: vi.fn(),
    requestWindowTabTransfer: vi.fn(),
}));
vi.mock('@electron/window/registry', () => ({getAllRegisteredAppWindows: vi.fn(() => [])}));
vi.mock('@electron/updates', () => ({
    deferDownloadedUpdate: vi.fn(),
    getUpdateStatus: vi.fn(() => ({phase: 'idle'})),
    installDownloadedUpdate: vi.fn(),
    skipUpdateVersion: vi.fn(),
    triggerManualUpdateCheck: vi.fn(),
}));
vi.mock('@electron/te', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/platform-ipc/rendererLogBridge', () => ({
    normalizeRendererLogEntry: vi.fn(),
    registerRendererLogBridge: vi.fn(),
}));

function createEvent(url: string): IRegisteredEvent {
    const mainFrame = {url};
    return {
        sender: {
            id: 7,
            isDestroyed: () => false,
            getURL: () => url,
            mainFrame,
        },
        senderFrame: mainFrame,
    };
}

function createDestroyedEvent(url = 'http://127.0.0.1:41001/electron'): IRegisteredEvent {
    const event = createEvent(url);
    return {
        ...event,
        sender: {
            ...(event.sender as object),
            isDestroyed: () => true,
        },
    };
}

function createSubframeEvent(url = 'http://127.0.0.1:41001/electron'): IRegisteredEvent {
    const event = createEvent(url);
    return {
        ...event,
        senderFrame: {url},
    };
}

async function getSettingsHandler() {
    const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
    registerIpcHandlers();

    const handler = mocks.handlers.get('settings:get');
    expect(handler).toBeTypeOf('function');
    return handler!;
}

describe('IPC registry sender trust', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.events.clear();
        mocks.browserWindowFromWebContents.mockReturnValue({isDestroyed: () => false});
    });

    it('rejects same-origin senders outside the configured renderer route', async () => {
        const handler = await getSettingsHandler();

        await expect(handler(createEvent('http://127.0.0.1:41001/admin')))
            .rejects.toThrow('IPC sender is not trusted');

        expect(mocks.loadSettings).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            '[ipc] rejected settings:get: untrusted sender URL http://127.0.0.1:41001/admin (expected http://127.0.0.1:41001/electron)',
        );
    }, ipcRegistrySecurityImportTimeoutMs);

    it('allows senders under the configured renderer route', async () => {
        const handler = await getSettingsHandler();

        await expect(handler(createEvent('http://127.0.0.1:41001/electron/settings')))
            .resolves.toEqual({theme: 'system'});

        expect(mocks.loadSettings).toHaveBeenCalledOnce();
    });

    it('rejects untrusted event-channel senders before file port attachment or rendererReady', async () => {
        const onRendererReady = vi.fn();
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers({onRendererReady});

        const filePortHandler = mocks.events.get('file:savePdfData:port');
        const rendererReadyHandler = mocks.events.get('app:rendererReady');
        expect(filePortHandler).toBeTypeOf('function');
        expect(rendererReadyHandler).toBeTypeOf('function');

        filePortHandler?.(createEvent('http://127.0.0.1:41001/admin'), 'session-1');
        filePortHandler?.(createDestroyedEvent(), 'session-2');
        rendererReadyHandler?.(createSubframeEvent());

        expect(mocks.attachSerializedPdfPersistencePort).not.toHaveBeenCalled();
        expect(onRendererReady).not.toHaveBeenCalled();

        const trustedFileEvent = createEvent('http://127.0.0.1:41001/electron/viewer');
        const trustedReadyEvent = createEvent('http://127.0.0.1:41001/electron/viewer');
        filePortHandler?.(trustedFileEvent, 'session-3');
        rendererReadyHandler?.(trustedReadyEvent);

        expect(mocks.attachSerializedPdfPersistencePort).toHaveBeenCalledWith(trustedFileEvent, 'session-3');
        expect(onRendererReady).toHaveBeenCalledWith(trustedReadyEvent);
    }, ipcRegistrySecurityImportTimeoutMs);
});
