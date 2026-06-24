import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';

const documentsClientMock = vi.hoisted(() => ({
    openDocumentDirect: vi.fn(async (path: string) => ({ path })),
    openPdfDirect: vi.fn(async (path: string) => ({ path })),
    openDocumentDirectBatch: vi.fn(async (paths: string[]) => paths),
    openPdfDirectBatch: vi.fn(async (paths: string[]) => paths),
    recentFiles: { get: vi.fn(async () => []) },
}));
const pageOpsClientMock = vi.hoisted(() => ({ rotate: vi.fn() }));
const imageExportClientMock = vi.hoisted(() => ({ exportPdfToImages: vi.fn() }));

vi.mock('@electron/features/documents/createDocumentsPreloadClient', () => ({createDocumentsPreloadClient: () => documentsClientMock}));
vi.mock('@electron/features/documents/createDocumentsPreloadPageOpsClient', () => ({createDocumentsPreloadPageOpsClient: () => pageOpsClientMock}));
vi.mock('@electron/features/image-export/createImageExportPreloadClient', () => ({createImageExportPreloadClient: () => imageExportClientMock}));
vi.mock('@electron/features/ocr/createOcrPreloadClient', () => ({ createOcrPreloadClient: () => ({}) }));
vi.mock('@electron/features/search/createSearchPreloadClient', () => ({ createSearchPreloadClient: () => ({}) }));
vi.mock('@electron/features/djvu/createDjvuPreloadClient', () => ({ createDjvuPreloadClient: () => ({}) }));
vi.mock('@electron/preload/debugLogBuffer', () => ({ getDebugLogMessages: () => [] }));

describe('createElectronApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    it('keeps page operations and image export out of the documents capability', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        expect('pageOps' in api.documents).toBe(false);
        expect('exportPdfToImages' in api.documents).toBe(false);
        expect(api.pageOps).toBe(pageOpsClientMock);
        expect(api.imageExport).toBe(imageExportClientMock);
        expect(typeof api.system.getMemoryInfo).toBe('function');
    });

    it('routes window tab context menu through the preload IPC contract', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const { CORE_IPC_CHANNELS } = await import('@electron/platform-ipc/coreContract');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );

        await api.windowTabs.showContextMenu('tab-1');

        expect(ipcRenderer.invoke).toHaveBeenCalledWith(CORE_IPC_CHANNELS.tabsShowContextMenu, 'tab-1');
    });

    it('decodes settings debug-log events before invoking callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        const callback = vi.fn();

        api.settings.onDebugLog(callback);
        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.debugLog);
        if (!listener) {
            throw new Error('Expected debug-log listener to be registered');
        }

        listener({}, {
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });
        listener({}, {
            source: 'main',
            message: 'bad level',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'TRACE',
        });

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith({
            source: 'main',
            message: 'hello',
            timestamp: '2026-03-21T00:00:00.000Z',
            level: 'INFO',
        });
    });

    it('decodes agent renderer request events before invoking callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        const snapshotCallback = vi.fn();
        const commandCallback = vi.fn();

        api.agent.onWorkspaceSnapshotRequest(snapshotCallback);
        api.agent.onCommandRequest(commandCallback);
        const snapshotListener = listeners.get(CORE_IPC_EVENT_CHANNELS.agentWorkspaceSnapshotRequest);
        const commandListener = listeners.get(CORE_IPC_EVENT_CHANNELS.agentCommandRequest);
        if (!snapshotListener || !commandListener) {
            throw new Error('Expected agent request listeners to be registered');
        }

        snapshotListener({}, {
            requestId: '',
            windowId: 1,
        });
        snapshotListener({}, {
            requestId: ' snapshot-1 ',
            windowId: 12,
            lastSeenRevision: 3,
        });
        commandListener({}, {
            requestId: 'command-bad',
            windowId: 12,
            command: {
                name: 'go_to_page',
                arguments: {page: '2'},
            },
        });
        commandListener({}, {
            requestId: ' command-1 ',
            windowId: 12,
            command: {
                name: 'run_action',
                arguments: {
                    id: 'ui.close_popups',
                    tabId: ' tab-1 ',
                    input: {ok: true},
                    dryRun: true,
                },
            },
        });

        expect(snapshotCallback).toHaveBeenCalledOnce();
        expect(snapshotCallback).toHaveBeenCalledWith({
            requestId: 'snapshot-1',
            windowId: 12,
            lastSeenRevision: 3,
        });
        expect(commandCallback).toHaveBeenCalledOnce();
        expect(commandCallback).toHaveBeenCalledWith({
            requestId: 'command-1',
            windowId: 12,
            command: {
                name: 'run_action',
                arguments: {
                    id: 'ui.close_popups',
                    tabId: 'tab-1',
                    input: {ok: true},
                    dryRun: true,
                },
            },
        });
    });

    it('decodes assistant events before invoking callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        const callback = vi.fn();

        api.agent.onAssistantEvent(callback);
        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.agentAssistantEvent);
        if (!listener) {
            throw new Error('Expected assistant event listener to be registered');
        }

        listener({}, {
            type: 'state',
            state: {
                status: {provider: 'codex'},
                messages: [],
            },
        });
        listener({}, {
            type: 'message-delta',
            messageId: ' message-1 ',
            delta: 'hello',
        });

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            type: 'message-delta',
            messageId: 'message-1',
            delta: 'hello',
        });
    });

    it('decodes incoming tab transfers before invoking callbacks', async () => {
        const listeners = new Map<string, (_event: unknown, payload: unknown) => void>();
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn((channel: string, handler: (_event: unknown, payload: unknown) => void) => {
                listeners.set(channel, handler);
            }),
            removeListener: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '' },
        );
        const callback = vi.fn();

        const unsubscribe = api.windowTabs.onIncomingTransfer(callback);
        const listener = listeners.get(CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer);
        if (!listener) {
            throw new Error('Expected incoming tab transfer listener to be registered');
        }

        listener({}, {
            transferId: 'transfer-bad',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: { kind: 'unsupported' },
        });
        listener({}, {
            transferId: ' transfer-1 ',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                snapshotPath: '/tmp/doc.snapshot.pdf',
                isDirty: true,
                currentPage: 2,
            },
        });
        unsubscribe();

        expect(callback).toHaveBeenCalledOnce();
        expect(callback).toHaveBeenCalledWith({
            transferId: 'transfer-1',
            sourceWindowId: 1,
            targetWindowId: 2,
            tab: {
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                isDirty: false,
                isDjvu: false,
            },
            payload: {
                kind: 'pdfSnapshot',
                fileName: 'doc.pdf',
                originalPath: '/tmp/doc.pdf',
                snapshotPath: '/tmp/doc.snapshot.pdf',
                isDirty: true,
                currentPage: 2,
            },
        });
        expect(ipcRenderer.removeListener).toHaveBeenCalledWith(
            CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer,
            listener,
        );
    });

    it('awaits renderer file-open authorization before single-file direct open', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        const invocations: string[] = [];
        const allowDeferred: { resolve?: (allowed: boolean) => void } = {};
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                invocations.push(channel);
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve();
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen) {
                    return new Promise<boolean>((resolve) => {
                        allowDeferred.resolve = resolve;
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/from-picker.pdf' },
        );

        expect(api.documents.getPathForFile({} as File)).toBe('/tmp/from-picker.pdf');
        const openPromise = api.documents.openPdfDirect('/tmp/from-picker.pdf');
        for (let i = 0; i < 5 && !allowDeferred.resolve; i += 1) {
            await Promise.resolve();
        }
        expect(documentsClientMock.openPdfDirect).not.toHaveBeenCalled();

        if (!allowDeferred.resolve) {
            throw new Error('Expected renderer file-open authorization to be pending');
        }
        allowDeferred.resolve(true);
        await expect(openPromise).resolves.toEqual({ path: '/tmp/from-picker.pdf' });
        expect(invocations).toContain(DOCUMENTS_CHANNELS.allowRendererFileOpen);
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/from-picker.pdf');
    });

    it('does not direct-open a picked file when renderer file-open authorization is denied', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000002' });
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve();
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen) {
                    return Promise.resolve(false);
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/denied-from-picker.pdf' },
        );

        expect(api.documents.getPathForFile({} as File)).toBe('/tmp/denied-from-picker.pdf');

        await expect(api.documents.openPdfDirect('/tmp/denied-from-picker.pdf')).resolves.toBeNull();
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();
    });

    it('keeps the newest renderer file-open authorization pending for repeated picks of the same path', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000003')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000004');
        vi.stubGlobal('crypto', {randomUUID});
        const allowResolvers = new Map<string, (allowed: boolean) => void>();
        const ipcRenderer = {
            invoke: vi.fn((channel: string, payload?: { token?: string }) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenToken) {
                    return Promise.resolve();
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpen && payload?.token) {
                    return new Promise<boolean>((resolve) => {
                        allowResolvers.set(payload.token!, resolve);
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile: () => '/tmp/repeated-picker.pdf' },
        );

        expect(api.documents.getPathForFile({} as File)).toBe('/tmp/repeated-picker.pdf');
        expect(api.documents.getPathForFile({} as File)).toBe('/tmp/repeated-picker.pdf');
        await flushMicrotasks();

        const openPromise = api.documents.openPdfDirect('/tmp/repeated-picker.pdf');
        allowResolvers.get('00000000-0000-4000-8000-000000000003')?.(true);
        await flushMicrotasks();
        expect(documentsClientMock.openDocumentDirect).not.toHaveBeenCalled();

        allowResolvers.get('00000000-0000-4000-8000-000000000004')?.(true);
        await expect(openPromise).resolves.toEqual({ path: '/tmp/repeated-picker.pdf' });
        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/repeated-picker.pdf');
    });

    it('batches renderer file-open authorization for file arrays', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000005')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000006');
        vi.stubGlobal('crypto', {randomUUID});
        const allowDeferred: { resolve?: (allowed: boolean) => void } = {};
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenTokens) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpenBatch) {
                    return new Promise<boolean>((resolve) => {
                        allowDeferred.resolve = resolve;
                    });
                }
                return Promise.resolve();
            }),
            on: vi.fn(),
            send: vi.fn(),
        };
        const getPathForFile = vi.fn((file: File) => (file as File & { path: string }).path);
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile },
        );

        const paths = api.documents.getPathsForFiles([
            { path: '/tmp/batch-a.pdf' } as File & { path: string },
            { path: '/tmp/batch-b.pdf' } as File & { path: string },
        ]);
        expect(paths).toEqual([
            '/tmp/batch-a.pdf',
            '/tmp/batch-b.pdf',
        ]);

        const openPromise = api.documents.openPdfDirectBatch(paths, 'batch-open-1');
        await flushMicrotasks();
        expect(documentsClientMock.openDocumentDirectBatch).not.toHaveBeenCalled();

        if (!allowDeferred.resolve) {
            throw new Error('Expected renderer file-open batch authorization to be pending');
        }
        allowDeferred.resolve(true);

        await expect(openPromise).resolves.toEqual(paths);
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.registerRendererFileOpenTokens,
            [
                '00000000-0000-4000-8000-000000000005',
                '00000000-0000-4000-8000-000000000006',
            ],
        );
        expect(ipcRenderer.invoke).toHaveBeenCalledWith(
            DOCUMENTS_CHANNELS.allowRendererFileOpenBatch,
            [
                {
                    filePath: '/tmp/batch-a.pdf',
                    token: '00000000-0000-4000-8000-000000000005',
                },
                {
                    filePath: '/tmp/batch-b.pdf',
                    token: '00000000-0000-4000-8000-000000000006',
                },
            ],
        );
        expect(documentsClientMock.openDocumentDirectBatch).toHaveBeenCalledWith(paths, 'batch-open-1');
    });
});

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}
