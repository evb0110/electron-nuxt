import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { AGENT_EVENT_CHANNELS } from '@electron/features/agent/contract';
import { DOCUMENTS_CHANNELS } from '@electron/features/documents/contract';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';
import { getPlatformDocumentCapabilityMirrors } from '@contracts/platformApi';

const documentsClientMock = vi.hoisted(() => ({
    openDocumentDialog: vi.fn(async () => null),
    openPdfDialog: vi.fn(async () => null),
    openCombineDialog: vi.fn(async () => null),
    openFolderDialog: vi.fn(async () => null),
    openFolderDialogStructured: vi.fn(async () => ({
        ok: false,
        reason: 'unsupported',
    })),
    openImageDialog: vi.fn(async () => null),
    openDocumentDirect: vi.fn(async (path: string) => ({ path })),
    openPdfDirect: vi.fn(async (path: string) => ({ path })),
    openDocumentDirectBatch: vi.fn(async (paths: string[]) => paths),
    openPdfDirectBatch: vi.fn(async (paths: string[]) => paths),
    savePdfAs: vi.fn(async () => null),
    savePdfDataAs: vi.fn(async () => ({
        path: null,
        validation: null,
    })),
    savePdfDialog: vi.fn(async () => null),
    saveDocxAs: vi.fn(async () => null),
    readFile: vi.fn(async () => new Uint8Array()),
    statFile: vi.fn(async () => ({size: 0})),
    readFileRange: vi.fn(async () => new Uint8Array()),
    getPdfNativePageSizes: vi.fn(async () => []),
    cancelPdfNativePagePreview: vi.fn(async () => ({canceled: true})),
    renderPdfNativePagePreview: vi.fn(async () => ({
        bytes: new Uint8Array(),
        height: 0,
        width: 0,
    })),
    readFileChunks: vi.fn(async () => ({
        size: 0,
        bytesRead: 0,
        chunks: 0,
    })),
    readTextFile: vi.fn(async () => ''),
    fileExists: vi.fn(async () => false),
    getDocumentRevision: vi.fn(async () => ({
        version: 1,
        documentRef: '/tmp/working-copy.pdf',
        authority: 'electron-working-copy',
        token: 'drt1:1:1:test',
        contentRevision: 1,
        mintedAt: 1,
    })),
    onDocumentRevisionChanged: vi.fn(),
    analyzePdfConformance: vi.fn(async () => ({})),
    validatePdfData: vi.fn(async () => ({valid: true})),
    validatePdfPath: vi.fn(async () => ({valid: true})),
    openPdfInDefaultAppData: vi.fn(async () => ({success: true})),
    openPdfInDefaultAppPath: vi.fn(async () => ({success: true})),
    printPdfData: vi.fn(async () => ({success: true})),
    printPdfPath: vi.fn(async () => ({success: true})),
    writeFile: vi.fn(async () => true),
    replaceWorkingCopyFromPath: vi.fn(async () => true),
    writeDocxFile: vi.fn(async () => true),
    createWorkingCopyFromData: vi.fn(async () => '/tmp/working-copy.pdf'),
    createWorkingCopyFromPath: vi.fn(async () => '/tmp/working-copy.pdf'),
    saveFileStructured: vi.fn(async () => ({
        ok: true,
        externalWriteCommitted: true,
        workingCopyRefreshed: true,
        validation: null,
    })),
    resyncWorkingCopy: vi.fn(async () => ({success: true})),
    savePdfData: vi.fn(async () => ({valid: true})),
    savePdfDataChunks: vi.fn(async () => ({valid: true})),
    repairPdf: vi.fn(async () => ({valid: true})),
    optimizePdfForInteraction: vi.fn(async () => ({valid: true})),
    optimizePdfAsCopy: vi.fn(async () => ({success: true})),
    savePdfNoteTextUpdates: vi.fn(async () => ({success: true})),
    savePdfNoteChanges: vi.fn(async () => ({success: true})),
    savePdfNativeMutations: vi.fn(async () => ({success: true})),
    applyPdfNativeMutationsToWorkingCopy: vi.fn(async () => ({success: true})),
    cleanupFile: vi.fn(async () => undefined),
    cleanupOcrTemp: vi.fn(async () => undefined),
    setWindowTitle: vi.fn(async () => undefined),
    showItemInFolder: vi.fn(async () => true),
    showItemInFolderStructured: vi.fn(async () => ({ok: true})),
    createCombinedPdfFromFiles: vi.fn(async () => new Uint8Array()),
    recentFiles: {
        get: vi.fn(async () => []),
        remove: vi.fn(async () => undefined),
        clear: vi.fn(async () => undefined),
    },
    setMenuDocumentState: vi.fn(async () => undefined),
    setMenuTabCount: vi.fn(async () => undefined),
    onPdfOptimizeProgress: vi.fn(),
    onMenuOpenPdf: vi.fn(),
    onMenuInsertImageFromFile: vi.fn(),
    onMenuPasteImageFromClipboard: vi.fn(),
    onMenuSave: vi.fn(),
    onMenuRepairSave: vi.fn(),
    onMenuOptimizePdfForInteraction: vi.fn(),
    onMenuSaveAs: vi.fn(),
    onMenuPrint: vi.fn(),
    onMenuPrintCurrentPage: vi.fn(),
    onMenuExportDocx: vi.fn(),
    onMenuExportImages: vi.fn(),
    onMenuExportMultiPageTiff: vi.fn(),
    onMenuZoomIn: vi.fn(),
    onMenuZoomOut: vi.fn(),
    onMenuActualSize: vi.fn(),
    onMenuFitWidth: vi.fn(),
    onMenuFitHeight: vi.fn(),
    onMenuViewModeSingle: vi.fn(),
    onMenuViewModeFacing: vi.fn(),
    onMenuViewModeFacingFirstSingle: vi.fn(),
    onMenuToggleAssistant: vi.fn(),
    onMenuUndo: vi.fn(),
    onMenuRedo: vi.fn(),
    onMenuDeletePages: vi.fn(),
    onMenuExtractPages: vi.fn(),
    onMenuRotateCw: vi.fn(),
    onMenuRotateCcw: vi.fn(),
    onMenuInsertPages: vi.fn(),
    onMenuOpenRecentFile: vi.fn(),
    onMenuOpenExternalPaths: vi.fn(),
    onMenuClearRecentFiles: vi.fn(),
    onOpenDocumentDirectBatchProgress: vi.fn(),
    onOpenPdfDirectBatchProgress: vi.fn(),
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

const splitDocumentCapabilityMirrors = getPlatformDocumentCapabilityMirrors();
const splitDocumentCapabilityRoots = [...new Set(
    splitDocumentCapabilityMirrors.flatMap((mirror) => {
        const root = mirror.splitPath[0];
        return root === undefined ? [] : [root];
    }),
)];

const expectedLegacyDocumentFunctionPaths = splitDocumentCapabilityMirrors.map(mirror => mirror.legacyPath);

let expectedDecodedEventWarningSpy: ReturnType<typeof vi.spyOn> | null = null;

function silenceExpectedDecodedEventWarnings() {
    expectedDecodedEventWarningSpy?.mockRestore();
    expectedDecodedEventWarningSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    return expectedDecodedEventWarningSpy;
}

function readPropertyPath(root: unknown, path: readonly string[]) {
    let value = root;
    for (const key of path) {
        if (typeof value !== 'object' || value === null || Array.isArray(value)) {
            return undefined;
        }
        value = (value as Record<string, unknown>)[key];
    }
    return value;
}

function formatPath(path: readonly string[]) {
    return path.join('.');
}

describe('createElectronApi', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        expectedDecodedEventWarningSpy?.mockRestore();
        expectedDecodedEventWarningSpy = null;
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

    it('exposes top-level document capability slices from the same preload behavior as legacy documents', async () => {
        const ipcRenderer = {
            invoke: vi.fn(async () => undefined),
            on: vi.fn(),
            send: vi.fn(),
        };
        const getPathForFile = vi.fn(() => '/tmp/split-picker.pdf');
        const { createElectronApi } = await import('@electron/preload/createElectronApi');
        const api = createElectronApi(
            ipcRenderer as never,
            { getPathForFile },
        );

        for (const splitRoot of splitDocumentCapabilityRoots) {
            expect(readPropertyPath(api, [splitRoot]), splitRoot).toBeDefined();
        }

        for (const {
            splitPath,
            legacyPath,
        } of splitDocumentCapabilityMirrors) {
            expect(readPropertyPath(api, splitPath), formatPath(splitPath)).toBe(
                readPropertyPath(api, legacyPath),
            );
        }

        expect(api.documentPicker?.getPathForFile({} as File)).toBe('/tmp/split-picker.pdf');
        await api.documentOpen?.openDocumentDirect('/tmp/direct-from-split.pdf');
        await api.documentFiles?.readTextFile('/tmp/direct-from-split.pdf');
        await api.documentPdf?.printPdfPath('/tmp/direct-from-split.pdf');

        expect(documentsClientMock.openDocumentDirect).toHaveBeenCalledWith('/tmp/direct-from-split.pdf');
        expect(documentsClientMock.readTextFile).toHaveBeenCalledWith('/tmp/direct-from-split.pdf');
        expect(documentsClientMock.printPdfPath).toHaveBeenCalledWith('/tmp/direct-from-split.pdf');
    });

    it('keeps the legacy documents facade method-compatible with the preload documents client', async () => {
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

        for (const path of expectedLegacyDocumentFunctionPaths) {
            expect(typeof readPropertyPath(api, path), formatPath(path)).toBe('function');
        }
    });

    it('keeps menu, recent-files, and window methods on split fields and the legacy facade', async () => {
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

        expect(api.documentMenu?.setMenuDocumentState).toBe(api.documents.setMenuDocumentState);
        expect(api.documentMenu?.onMenuClearRecentFiles).toBe(api.documents.onMenuClearRecentFiles);
        expect(api.documentRecentFiles?.recentFiles.get).toBe(api.documents.recentFiles.get);
        expect(api.documentRecentFiles?.recentFiles.remove).toBe(api.documents.recentFiles.remove);
        expect(api.documentRecentFiles?.recentFiles.clear).toBe(api.documents.recentFiles.clear);
        expect(api.documentWindow?.setWindowTitle).toBe(api.documents.setWindowTitle);
        expect(api.documentWindow?.showItemInFolder).toBe(api.documents.showItemInFolder);
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
        const warningSpy = silenceExpectedDecodedEventWarnings();
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
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${CORE_IPC_EVENT_CHANNELS.debugLog}`,
            expect.objectContaining({ level: 'TRACE' }),
        );
    });

    it('decodes agent renderer request events before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
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
        const snapshotListener = listeners.get(AGENT_EVENT_CHANNELS.workspaceSnapshotRequest);
        const commandListener = listeners.get(AGENT_EVENT_CHANNELS.commandRequest);
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
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${AGENT_EVENT_CHANNELS.workspaceSnapshotRequest}`,
            expect.objectContaining({ requestId: '' }),
        );
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${AGENT_EVENT_CHANNELS.commandRequest}`,
            expect.objectContaining({ requestId: 'command-bad' }),
        );
    });

    it('decodes assistant events before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
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
        const listener = listeners.get(AGENT_EVENT_CHANNELS.assistantEvent);
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
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${AGENT_EVENT_CHANNELS.assistantEvent}`,
            expect.objectContaining({ type: 'state' }),
        );
    });

    it('decodes incoming tab transfers before invoking callbacks', async () => {
        const warningSpy = silenceExpectedDecodedEventWarnings();
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
        expect(warningSpy).toHaveBeenCalledWith(
            `Dropped invalid decoded IPC event payload for ${CORE_IPC_EVENT_CHANNELS.tabsIncomingTransfer}`,
            expect.objectContaining({ transferId: 'transfer-bad' }),
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

        expect(api.documentPicker?.getPathForFile({} as File)).toBe('/tmp/from-picker.pdf');
        expect(api.documentOpen?.openPdfDirect).toBe(api.documents.openPdfDirect);
        const openPromise = api.documentOpen?.openPdfDirect('/tmp/from-picker.pdf');
        if (!openPromise) {
            throw new Error('Expected documentOpen.openPdfDirect to be available');
        }
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

        expect(api.documentPicker?.getPathForFile({} as File)).toBe('/tmp/denied-from-picker.pdf');
        expect(api.documentOpen?.openDocumentDirect).toBe(api.documents.openDocumentDirect);

        await expect(api.documentOpen?.openDocumentDirect('/tmp/denied-from-picker.pdf')).resolves.toBeNull();
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

        const paths = api.documentPicker?.getPathsForFiles([
            { path: '/tmp/batch-a.pdf' } as File & { path: string },
            { path: '/tmp/batch-b.pdf' } as File & { path: string },
        ]) ?? [];
        expect(paths).toEqual([
            '/tmp/batch-a.pdf',
            '/tmp/batch-b.pdf',
        ]);

        expect(api.documentOpen?.openPdfDirectBatch).toBe(api.documents.openPdfDirectBatch);
        const openPromise = api.documentOpen?.openPdfDirectBatch(paths, 'batch-open-1');
        if (!openPromise) {
            throw new Error('Expected documentOpen.openPdfDirectBatch to be available');
        }
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

    it('does not batch direct-open picked files when renderer file-open batch authorization is denied', async () => {
        const randomUUID = vi.fn()
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000007')
            .mockReturnValueOnce('00000000-0000-4000-8000-000000000008');
        vi.stubGlobal('crypto', {randomUUID});
        const ipcRenderer = {
            invoke: vi.fn((channel: string) => {
                if (channel === DOCUMENTS_CHANNELS.registerRendererFileOpenTokens) {
                    return Promise.resolve(true);
                }
                if (channel === DOCUMENTS_CHANNELS.allowRendererFileOpenBatch) {
                    return Promise.resolve(false);
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

        const paths = api.documentPicker?.getPathsForFiles([
            { path: '/tmp/denied-batch-a.pdf' } as File & { path: string },
            { path: '/tmp/denied-batch-b.pdf' } as File & { path: string },
        ]) ?? [];

        expect(api.documentOpen?.openDocumentDirectBatch).toBe(api.documents.openDocumentDirectBatch);
        await expect(api.documentOpen?.openDocumentDirectBatch(paths, 'batch-open-denied')).resolves.toBeNull();
        expect(documentsClientMock.openDocumentDirectBatch).not.toHaveBeenCalled();
    });
});

async function flushMicrotasks() {
    await Promise.resolve();
    await Promise.resolve();
}
