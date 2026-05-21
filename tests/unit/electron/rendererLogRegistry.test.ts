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

vi.mock('@contracts/externalUrl', () => ({sanitizeAllowedExternalUrl: (value: unknown) => value}));
vi.mock('@electron/features/documents/ipcAdapter', () => ({registerDocumentsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/djvu/ipcAdapter', () => ({registerDjvuIpcAdapter: vi.fn()}));
vi.mock('@electron/features/image-export/ipcAdapter', () => ({registerImageExportIpcAdapter: vi.fn()}));
vi.mock('@electron/features/ocr/ipcAdapter', () => ({registerOcrIpcAdapter: vi.fn()}));
vi.mock('@electron/features/page-ops/ipcAdapter', () => ({registerPageOpsIpcAdapter: vi.fn()}));
vi.mock('@electron/features/search/ipcAdapter', () => ({registerSearchIpcAdapter: vi.fn()}));
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
vi.mock('@electron/windowTabTransfer', () => ({
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
vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: 'https://trusted.example/electron'}}}));

function createSender(id: number) {
    const once = vi.fn();
    const removeListener = vi.fn();
    return {
        id,
        once,
        removeListener,
        isDestroyed: () => false,
        getURL: () => 'https://trusted.example/electron',
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

    it('removes the counterpart cleanup listener when a sender lifecycle event fires', async () => {
        const { registerIpcHandlers } = await import('@electron/ipc/registry');
        registerIpcHandlers();

        const handler = mocks.handlers.get('renderer:log');
        expect(handler).toBeTypeOf('function');

        const sender = createSender(9);
        handler?.({
            sender,
            senderFrame: null,
        }, {
            level: 'info',
            section: 'search',
            message: 'before-destroy',
            timestamp: '2026-03-21T00:00:00.000Z',
        });

        const destroyedHandler = sender.once.mock.calls
            .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
        const renderGoneHandler = sender.once.mock.calls
            .find(call => call[0] === 'render-process-gone')?.[1] as (() => void) | undefined;

        destroyedHandler?.();

        expect(sender.removeListener).toHaveBeenCalledWith('destroyed', destroyedHandler);
        expect(sender.removeListener).toHaveBeenCalledWith('render-process-gone', renderGoneHandler);
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

describe('normalizeRendererLogEntry', () => {
    it('falls back to info level when level is an unknown string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry({
            level: 'critical',
            section: 'search',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
        });
        expect(entry.level).toBe('info');
    });

    it('falls back to info level when level is missing or non-string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        expect(normalizeRendererLogEntry({message: 'm'}).level).toBe('info');
        expect(normalizeRendererLogEntry({
            level: 5,
            message: 'm',
        }).level).toBe('info');
        expect(normalizeRendererLogEntry({
            level: null,
            message: 'm',
        }).level).toBe('info');
    });

    it('preserves all four known log levels', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        for (const level of [
            'debug',
            'info',
            'warn',
            'error',
        ] as const) {
            expect(normalizeRendererLogEntry({
                level,
                message: 'm',
            }).level).toBe(level);
        }
    });

    it('uses <empty> message default when message is missing or null', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        expect(normalizeRendererLogEntry({level: 'info'}).message).toBe('<empty>');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: null,
        }).message).toBe('<empty>');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 42,
        }).message).toBe('<empty>');
    });

    it('uses unknown section default when section is missing or non-string', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
        }).section).toBe('unknown');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
            section: null,
        }).section).toBe('unknown');
        expect(normalizeRendererLogEntry({
            level: 'info',
            message: 'm',
            section: 7,
        }).section).toBe('unknown');
    });

    it('drops extra metadata fields not in the canonical entry shape', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry({
            level: 'info',
            section: 'search',
            message: 'm',
            timestamp: '2026-03-21T00:00:00.000Z',
            extra: 'should-be-dropped',
            anotherField: {nested: true},
        });
        expect(entry).toEqual({
            level: 'info',
            section: 'search',
            message: 'm',
            timestamp: '2026-03-21T00:00:00.000Z',
            serializedData: '',
        });
        expect(Object.keys(entry).sort()).toEqual([
            'level',
            'message',
            'section',
            'serializedData',
            'timestamp',
        ]);
    });

    it('uses defaults for null payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry(null);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
        expect(entry.timestamp).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('uses defaults for undefined payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry(undefined);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for string payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry('not-a-record');
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for number payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry(42);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('uses defaults for array payload', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry([
            'debug',
            'msg',
        ]);
        expect(entry.level).toBe('info');
        expect(entry.section).toBe('unknown');
        expect(entry.message).toBe('<empty>');
        expect(entry.serializedData).toBe('');
    });

    it('serializes data into serializedData with leading data= marker', async () => {
        const { normalizeRendererLogEntry } = await import('@electron/ipc/registry');
        const entry = normalizeRendererLogEntry({
            level: 'info',
            section: 'search',
            message: 'm',
            data: {a: 1},
        });
        expect(entry.serializedData).toBe(' data={"a":1}');
    });
});
