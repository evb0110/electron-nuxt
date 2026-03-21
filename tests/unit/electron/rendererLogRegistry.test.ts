import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

interface IRegisteredEvent {
    sender: unknown;
    senderFrame?: unknown;
}

type TRegisteredHandler = (event: IRegisteredEvent, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    browserWindowFromWebContents: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: {fromWebContents: mocks.browserWindowFromWebContents},
    ipcMain: {
        on: (channel: string, handler: TRegisteredHandler) => {
            mocks.handlers.set(channel, handler);
        },
        handle: vi.fn(),
    },
    shell: {openExternal: vi.fn()},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@contracts/external-url', () => ({sanitizeAllowedExternalUrl: (value: unknown) => value}));
vi.mock('@electron/features/documents/ipc-adapter', () => ({registerDocumentsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/djvu/ipc-adapter', () => ({registerDjvuIpcAdapter: vi.fn()}));
vi.mock('@electron/features/image-export/ipc-adapter', () => ({registerImageExportIpcAdapter: vi.fn()}));
vi.mock('@electron/features/ocr/ipc-adapter', () => ({registerOcrIpcAdapter: vi.fn()}));
vi.mock('@electron/features/page-ops/ipc-adapter', () => ({registerPageOpsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/search/ipc-adapter', () => ({registerSearchIpcAdapter: vi.fn()}));
vi.mock('@electron/menu', () => ({
    showTabContextMenu: vi.fn(),
    updateRecentFilesMenu: vi.fn(),
}));
vi.mock('@electron/settings', () => ({
    loadSettings: vi.fn(async () => ({})),
    updateSettings: vi.fn(async (updater: (settings: Record<string, unknown>) => void) => {
        const settings: Record<string, unknown> = {};
        updater(settings);
        return settings;
    }),
}));
vi.mock('@electron/window-tab-transfer', () => ({
    acknowledgeWindowTabTransfer: vi.fn(),
    requestWindowTabTransfer: vi.fn(),
}));
vi.mock('@electron/window', () => ({getAllAppWindows: vi.fn(() => [])}));
vi.mock('@electron/updates', () => ({
    deferDownloadedUpdate: vi.fn(),
    getUpdateStatus: vi.fn(() => ({phase: 'idle'})),
    installDownloadedUpdate: vi.fn(),
    skipUpdateVersion: vi.fn(),
    triggerManualUpdateCheck: vi.fn(),
}));
vi.mock('@electron/i18n', () => ({te: (key: string) => key}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/config', () => ({config: {server: {url: 'https://trusted.example'}}}));

function createSender(id: number) {
    const once = vi.fn();
    return {
        id,
        once,
        isDestroyed: () => false,
        getURL: () => 'https://trusted.example/app',
        mainFrame: null,
    };
}

describe('renderer log registry', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.handlers.clear();
        mocks.browserWindowFromWebContents.mockReturnValue({isDestroyed: () => false});
    });

    it('clears sender rate-limit state when the sender is destroyed', async () => {
        vi.useFakeTimers();
        try {
            const { registerIpcHandlers } = await import('@electron/ipc/registry');
            registerIpcHandlers();

            const handler = mocks.handlers.get('renderer:log');
            expect(handler).toBeTypeOf('function');

            const firstSender = createSender(7);
            for (let index = 0; index < 41; index += 1) {
                handler?.({
                    sender: firstSender,
                    senderFrame: null,
                }, {
                    level: 'info',
                    section: 'search',
                    message: `message-${index}`,
                    timestamp: '2026-03-21T00:00:00.000Z',
                });
            }

            expect(mocks.logger.info).toHaveBeenCalledTimes(40);
            expect(firstSender.once).toHaveBeenCalledTimes(2);

            const destroyedHandler = firstSender.once.mock.calls
                .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
            destroyedHandler?.();

            const secondSender = createSender(7);
            handler?.({
                sender: secondSender,
                senderFrame: null,
            }, {
                level: 'info',
                section: 'search',
                message: 'after-destroy',
                timestamp: '2026-03-21T00:00:00.000Z',
            });

            expect(secondSender.once).toHaveBeenCalledTimes(2);
            expect(mocks.logger.info).toHaveBeenCalledTimes(41);
        } finally {
            vi.useRealTimers();
        }
    });

    it('summarizes nested payloads without walking deeply nested objects', async () => {
        const { registerIpcHandlers } = await import('@electron/ipc/registry');
        registerIpcHandlers();

        const handler = mocks.handlers.get('renderer:log');
        expect(handler).toBeTypeOf('function');

        const sender = createSender(8);
        handler?.({
            sender,
            senderFrame: null,
        }, {
            level: 'info',
            section: 'search',
            message: 'payload',
            timestamp: '2026-03-21T00:00:00.000Z',
            data: {
                nested: { value: 1 },
                items: ['child'],
            },
        });

        const loggedMessage = mocks.logger.info.mock.calls.at(-1)?.[0] as string | undefined;
        expect(loggedMessage).toContain('"nested":"[Object]"');
        expect(loggedMessage).toContain('"items":"[Array(1)]"');
    });
});
