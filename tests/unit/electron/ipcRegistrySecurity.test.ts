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
import {
    ASSISTANT_MAX_IMAGE_ATTACHMENTS,
    ASSISTANT_MAX_IMAGE_BYTES,
} from '@contracts/agent';

const ipcRegistrySecurityImportTimeoutMs = 10_000;

const mocks = vi.hoisted(() => {
    const agentState = {
        scope: null,
        status: {
            provider: 'codex',
            installState: 'missing',
            authState: 'unknown',
            runtimeState: 'stopped',
            models: [],
            providers: [],
            mcp: {
                running: false,
                enabled: false,
                toolCount: 0,
            },
        },
        messages: [],
    };
    const agentService = {
        getMcpIntegrationStatus: vi.fn(async () => ({
            enabled: false,
            running: false,
            codexRegistrationState: 'unknown',
            serverUrl: null,
            error: null,
        })),
        setMcpIntegrationEnabled: vi.fn(async () => ({
            ok: true,
            status: {
                enabled: false,
                running: false,
                codexRegistrationState: 'unknown',
                serverUrl: null,
                error: null,
            },
        })),
        getAssistantState: vi.fn(async () => agentState),
        installAssistantCodex: vi.fn(async () => ({
            ok: true,
            state: agentState,
        })),
        startAssistantLogin: vi.fn(async () => ({
            ok: true,
            state: agentState,
        })),
        cancelAssistantLogin: vi.fn(async () => agentState),
        sendAssistantMessage: vi.fn(async () => ({
            ok: true,
            state: agentState,
        })),
        interruptAssistant: vi.fn(async () => agentState),
        resetAssistantChat: vi.fn(async () => agentState),
        submitWorkspaceSnapshot: vi.fn(async () => ({accepted: true})),
        submitCommandResponse: vi.fn(async () => ({accepted: true})),
        shutdownAssistant: vi.fn(async () => undefined),
    };

    return {
        events: new Map<string, (event: IRegisteredEvent, ...args: unknown[]) => void>(),
        handlers: new Map<string, TRegisteredHandler>(),
        attachSerializedPdfPersistencePort: vi.fn(),
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        registeredWindowsById: new Map<number, unknown>(),
        browserWindowFromWebContents: vi.fn(),
        getWindowByIdFromRegistry: vi.fn(),
        loadSettings: vi.fn(async () => ({theme: 'system'})),
        updateSettings: vi.fn(),
        setElectronLocale: vi.fn(async () => {}),
        updateRecentFilesMenu: vi.fn(),
        agentService,
        createAgentService: vi.fn(() => agentService),
        createDocumentsService: vi.fn(() => ({})),
        registerDocumentRevisionEventBridge: vi.fn(),
        registerDocumentRevisionInvalidationEffects: vi.fn(),
        allowOpenPath: vi.fn(),
        isSupportedOpenPath: vi.fn((_path: unknown) => true),
        requireOpenPath: vi.fn((..._args: unknown[]) => undefined),
        requireManagedWorkingCopyPath: vi.fn((..._args: unknown[]) => undefined),
        sanitizeAllowedExternalUrl: vi.fn((value: unknown) => value),
        shellOpenExternal: vi.fn(),
        acknowledgeWindowTabTransfer: vi.fn(),
        requestWindowTabTransfer: vi.fn(),
    };
});

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
    shell: {openExternal: mocks.shellOpenExternal},
    webContents: {fromId: vi.fn(() => null)},
}));

vi.mock('@contracts/externalUrl', () => ({sanitizeAllowedExternalUrl: mocks.sanitizeAllowedExternalUrl}));
vi.mock('@electron/config', () => ({config: {renderer: {trustedUrl: 'http://127.0.0.1:41001/electron'}}}));
vi.mock('@electron/features/agent/createAgentService', () => ({createAgentService: mocks.createAgentService}));
vi.mock('@electron/features/documents/createDocumentsService', () => ({createDocumentsService: mocks.createDocumentsService}));
vi.mock('@electron/features/documents/public', () => ({
    attachSerializedPdfPersistencePort: mocks.attachSerializedPdfPersistencePort,
    registerDocumentRevisionEventBridge: mocks.registerDocumentRevisionEventBridge,
    registerDocumentRevisionInvalidationEffects: mocks.registerDocumentRevisionInvalidationEffects,
}));
vi.mock('@electron/file-access/openPathCapabilities', () => ({
    allowOpenPath: (...args: unknown[]) => mocks.allowOpenPath(...args),
    requireOpenPath: (...args: unknown[]) => mocks.requireOpenPath(...args),
}));
vi.mock('@electron/image/pdfConversion', () => ({isSupportedOpenPath: (path: unknown) => mocks.isSupportedOpenPath(path)}));
vi.mock('@electron/file-access/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: unknown, owner: unknown) => mocks.requireManagedWorkingCopyPath(path, owner)}));
vi.mock('@electron/features/image-export/public', () => ({imageExportMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/ocr/mainBindings', () => ({ocrMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/page-ops/public', () => ({pageOpsMainBindings: new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/features/search/public', () => ({prepareSearchMainBindings: () => new Proxy({}, {get: () => vi.fn()})}));
vi.mock('@electron/menu', () => ({updateRecentFilesMenu: mocks.updateRecentFilesMenu}));
vi.mock('@electron/settings', () => ({
    loadSettings: mocks.loadSettings,
    updateSettings: mocks.updateSettings,
}));
vi.mock('@electron/windowTabTransfer', () => ({
    acknowledgeWindowTabTransfer: mocks.acknowledgeWindowTabTransfer,
    requestWindowTabTransfer: mocks.requestWindowTabTransfer,
}));
vi.mock('@electron/window/registry', () => ({
    getAllRegisteredAppWindows: vi.fn(() => Array.from(mocks.registeredWindowsById.values())),
    getWindowByIdFromRegistry: mocks.getWindowByIdFromRegistry,
}));
vi.mock('@electron/updates', () => ({
    deferDownloadedUpdate: vi.fn(),
    downloadAvailableUpdate: vi.fn(),
    getUpdateStatus: vi.fn(() => ({phase: 'idle'})),
    installDownloadedUpdate: vi.fn(),
    skipUpdateVersion: vi.fn(),
    triggerManualUpdateCheck: vi.fn(),
}));
vi.mock('@electron/te', () => ({
    setElectronLocale: mocks.setElectronLocale,
    te: (key: string) => key,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/platform-ipc/rendererLogBridge', () => ({
    normalizeRendererLogEntry: vi.fn(),
    registerRendererLogBridge: vi.fn(),
}));

let nextSenderId = 7;

function createEvent(url: string): IRegisteredEvent {
    const mainFrame = {url};
    const senderId = nextSenderId;
    nextSenderId += 1;
    const sender = {
        id: senderId,
        once: vi.fn(),
        removeListener: vi.fn(),
        isDestroyed: () => false,
        getURL: () => url,
        mainFrame,
    };
    const window = {
        id: sender.id,
        webContents: sender,
        isDestroyed: () => false,
    };
    mocks.registeredWindowsById.set(sender.id, window);
    return {
        sender,
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
        mocks.registeredWindowsById.clear();
        nextSenderId = 7;
        mocks.sanitizeAllowedExternalUrl.mockImplementation((value: unknown) => value);
        mocks.browserWindowFromWebContents.mockImplementation((sender: {id?: number}) => (
            typeof sender.id === 'number'
                ? mocks.registeredWindowsById.get(sender.id) ?? {
                    id: sender.id,
                    webContents: sender,
                    isDestroyed: () => false,
                }
                : null
        ));
        mocks.getWindowByIdFromRegistry.mockImplementation((windowId: number) => (
            mocks.registeredWindowsById.get(windowId) ?? null
        ));
        mocks.updateSettings.mockImplementation(async (updater: (settings: Record<string, unknown>) => unknown) => (
            updater({
                assistantPanelEnabled: true,
                skippedUpdateVersion: 'keep-version',
                agentMcpEnabled: true,
            })
        ));
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

    it('rejects trusted-route senders whose BrowserWindow is not registered', async () => {
        const handler = await getSettingsHandler();
        const event = createEvent('http://127.0.0.1:41001/electron/settings');
        mocks.registeredWindowsById.clear();

        await expect(handler(event)).rejects.toThrow('IPC sender is not trusted');

        expect(mocks.loadSettings).not.toHaveBeenCalled();
        expect(mocks.logger.warn).toHaveBeenCalledWith(
            '[ipc] rejected settings:get: sender window is not registered',
        );
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

    it('does not consume shell open rate-limit quota for invalid external URLs', async () => {
        mocks.sanitizeAllowedExternalUrl
            .mockImplementationOnce(() => {
                throw new Error('Invalid external URL');
            })
            .mockImplementation((value: unknown) => value);
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();
        const handler = mocks.handlers.get('shell:openExternal');
        expect(handler).toBeTypeOf('function');
        const event = createEvent('http://127.0.0.1:41001/electron/viewer');

        await expect(handler?.(event, 'javascript:alert(1)')).rejects.toThrow('Invalid external URL');
        await expect(handler?.(event, 'https://example.test/')).resolves.toBeUndefined();

        expect(mocks.shellOpenExternal).toHaveBeenCalledOnce();
        expect(mocks.shellOpenExternal).toHaveBeenCalledWith('https://example.test/');
    }, ipcRegistrySecurityImportTimeoutMs);

    it('clears shell open rate-limit state when the sender is destroyed', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();
        const handler = mocks.handlers.get('shell:openExternal');
        expect(handler).toBeTypeOf('function');
        const event = createEvent('http://127.0.0.1:41001/electron/viewer');

        await expect(handler?.(event, 'https://example.test/first')).resolves.toBeUndefined();
        await expect(handler?.(event, 'https://example.test/second'))
            .rejects
            .toThrow('External URL opens are being requested too frequently.');

        const sender = event.sender as { once: ReturnType<typeof vi.fn> };
        const destroyedHandler = sender.once.mock.calls
            .find(call => call[0] === 'destroyed')?.[1] as (() => void) | undefined;
        destroyedHandler?.();

        await expect(handler?.(event, 'https://example.test/after-destroy')).resolves.toBeUndefined();
        expect(mocks.shellOpenExternal).toHaveBeenCalledTimes(2);
    }, ipcRegistrySecurityImportTimeoutMs);

    it('rejects assistant image payloads that exceed IPC attachment budgets', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();
        const handler = mocks.handlers.get('agent:sendAssistantMessage');
        expect(handler).toBeTypeOf('function');
        const event = createEvent('http://127.0.0.1:41001/electron/viewer');
        const imageAttachment = {
            type: 'image',
            id: 'image-1',
            name: 'image.png',
            mimeType: 'image/png',
            sizeBytes: 4,
            dataUrl: 'data:image/png;base64,AAAA',
        };

        await expect(handler?.(event, {
            text: 'hello',
            attachments: Array.from(
                { length: ASSISTANT_MAX_IMAGE_ATTACHMENTS + 1 },
                (_, index) => ({
                    ...imageAttachment,
                    id: `image-${index}`,
                }),
            ),
        })).rejects.toThrow('Invalid IPC arguments for agent:sendAssistantMessage');

        await expect(handler?.(event, {
            text: 'hello',
            attachments: [{
                ...imageAttachment,
                sizeBytes: ASSISTANT_MAX_IMAGE_BYTES + 1,
            }],
        })).rejects.toThrow('Invalid IPC arguments for agent:sendAssistantMessage');

        await expect(handler?.(event, {
            text: 'hello',
            attachments: [{
                ...imageAttachment,
                dataUrl: `data:image/png;base64,${'A'.repeat(Math.ceil(ASSISTANT_MAX_IMAGE_BYTES / 3) * 4 + 129)}`,
            }],
        })).rejects.toThrow('Invalid IPC arguments for agent:sendAssistantMessage');
    }, ipcRegistrySecurityImportTimeoutMs);

    it('rejects malformed tab transfer payloads before calling the transfer broker', async () => {
        const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
        registerIpcHandlers();
        const handler = mocks.handlers.get('tabs:transfer');
        expect(handler).toBeTypeOf('function');
        const event = createEvent('http://127.0.0.1:41001/electron/viewer');
        const validTab = {
            fileName: 'doc.pdf',
            originalPath: '/tmp/doc.pdf',
            isDirty: false,
            isDjvu: false,
        };

        await expect(handler?.(event, {
            target: {
                kind: 'window',
                windowId: 42,
            },
            payload: { kind: 'empty' },
        })).rejects.toThrow('Invalid IPC arguments for tabs:transfer');

        await expect(handler?.(event, {
            target: {
                kind: 'window',
                windowId: 42,
            },
            tab: validTab,
            payload: { kind: 'unsupported' },
        })).rejects.toThrow('Invalid IPC arguments for tabs:transfer');

        expect(mocks.requestWindowTabTransfer).not.toHaveBeenCalled();
    }, ipcRegistrySecurityImportTimeoutMs);

    it('coalesces trusted settings saves per sender before writing settings', async () => {
        vi.useFakeTimers();
        try {
            const { registerIpcHandlers } = await import('@electron/platform-ipc/registerIpcHandlers');
            registerIpcHandlers();
            const handler = mocks.handlers.get('settings:save');
            expect(handler).toBeTypeOf('function');
            const event = createEvent('http://127.0.0.1:41001/electron/settings');

            await expect(handler?.(event, {skippedUpdateVersion: 'renderer-stale'}))
                .rejects
                .toThrow('Invalid IPC arguments for settings:save');
            await expect(handler?.(event, {agentMcpEnabled: false}))
                .rejects
                .toThrow('Invalid IPC arguments for settings:save');

            const firstSave = handler?.(event, {theme: 'dark'});
            const secondSave = handler?.(event, {assistantPanelEnabled: true});

            expect(mocks.updateSettings).not.toHaveBeenCalled();

            await vi.advanceTimersByTimeAsync(25);
            await expect(Promise.all([
                firstSave,
                secondSave,
            ])).resolves.toEqual([
                undefined,
                undefined,
            ]);

            expect(mocks.updateSettings).toHaveBeenCalledOnce();
            expect(mocks.setElectronLocale).toHaveBeenCalledWith('en');
            expect(mocks.setElectronLocale.mock.invocationCallOrder[0]!)
                .toBeLessThan(mocks.updateRecentFilesMenu.mock.invocationCallOrder[0]!);
            const updater = mocks.updateSettings.mock.calls[0]?.[0] as (settings: Record<string, unknown>) => unknown;
            expect(updater({
                assistantPanelEnabled: true,
                skippedUpdateVersion: 'keep-version',
                agentMcpEnabled: true,
            })).toEqual(expect.objectContaining({
                theme: 'dark',
                assistantPanelEnabled: true,
                skippedUpdateVersion: 'keep-version',
                agentMcpEnabled: true,
            }));
        } finally {
            vi.useRealTimers();
        }
    }, ipcRegistrySecurityImportTimeoutMs);
});
