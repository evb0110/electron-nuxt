import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
import {
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {ISearchDjvuTextOptions} from '@electron/djvu/textSearch';


const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    estimateSizes: vi.fn(),
    getDjvuPageCount: vi.fn(),
    getDjvuResolution: vi.fn(),
    getDjvuOutline: vi.fn(),
    getDjvuHasText: vi.fn(),
    getDjvuMetadata: vi.fn(),
    parseDjvuOutline: vi.fn(),
    handleDjvuConvertToPdf: vi.fn(),
    handleDjvuCancel: vi.fn(),
    handleDjvuOpenForViewing: vi.fn(),
    cancelConversion: vi.fn(),
    isAllowedDjvuViewingPath: vi.fn(),
    getDjvuPageSizesForViewing: vi.fn(),
    getDjvuPageSizeForViewing: vi.fn(),
    renderDjvuPagePreview: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    pruneStaleDjvuArtifactJobs: vi.fn(),
    getRecentFiles: vi.fn(),
    searchDjvuText: vi.fn(),
    safeSendToWindow: vi.fn(),
    senderSend: vi.fn(),
}));

vi.mock('electron', () => ({
    app: {
        isPackaged: false,
        getPath: vi.fn(() => '/tmp'),
    },
    BrowserWindow: {fromWebContents: vi.fn(() => null)},
    ipcMain: {handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.ipcHandle(channel, handler);
        mocks.handlers.set(channel, handler);
    }},
}));

vi.mock('@electron/djvu/estimateSizes', () => ({estimateSizes: mocks.estimateSizes}));
vi.mock('@electron/djvu/metadata', () => ({
    getDjvuPageCount: mocks.getDjvuPageCount,
    getDjvuResolution: mocks.getDjvuResolution,
    getDjvuOutline: mocks.getDjvuOutline,
    getDjvuHasText: mocks.getDjvuHasText,
    getDjvuMetadata: mocks.getDjvuMetadata,
}));
vi.mock('@electron/djvu/parseDjvuOutline', () => ({parseDjvuOutline: mocks.parseDjvuOutline}));
vi.mock('@electron/features/djvu/main/pdfExport', () => ({
    handleDjvuConvertToPdf: mocks.handleDjvuConvertToPdf,
    handleDjvuCancel: mocks.handleDjvuCancel,
}));
vi.mock('@electron/features/djvu/main/viewing', () => ({
    handleDjvuOpenForViewing: mocks.handleDjvuOpenForViewing,
    isAllowedDjvuViewingPath: mocks.isAllowedDjvuViewingPath,
    releaseDjvuViewingPath: mocks.releaseDjvuViewingPath,
    cleanupDjvuTempPdfPath: mocks.cleanupDjvuTempPdfPath,
}));
vi.mock('@electron/features/djvu/main/djvuArtifactManifest', () => ({pruneStaleDjvuArtifactJobs: mocks.pruneStaleDjvuArtifactJobs}));
vi.mock('@electron/recentFiles', () => ({getRecentFiles: mocks.getRecentFiles}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    getDjvuPageSizeForViewing: mocks.getDjvuPageSizeForViewing,
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
    renderDjvuPagePreview: mocks.renderDjvuPagePreview,
}));
vi.mock('@electron/features/djvu/main/ddjvuConversion', () => ({cancelConversion: mocks.cancelConversion}));
vi.mock('@electron/djvu/textSearch', () => ({searchDjvuText: mocks.searchDjvuText}));
vi.mock('@electron/djvu/safeSendToWindow', () => ({safeSendToWindow: mocks.safeSendToWindow}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { registerDjvuIpcAdapter } = await import('@electron/features/djvu/registerDjvuIpcAdapter');
const { resolveDjvuPreviewBrokerPriority } = await import('@electron/features/djvu/main/djvuOperations');
const { configureMainJobBroker } = await import('@electron/resources/jobBroker');

configureMainJobBroker({
    logicalCpus: 8,
    totalRamBytes: 16 * 1024 * 1024 * 1024,
    safeMode: false,
    detectedTier: 'high',
    performanceMode: 'auto',
    tier: 'high',
});

function createIpcEvent(senderId: number) {
    type TListener = (...args: unknown[]) => void;
    const listeners = new Map<string, TListener[]>();
    let isDestroyed = false;
    const sender = {
        id: senderId,
        on: vi.fn(),
        emit: (event: string, ...args: unknown[]) => {
            if (event === 'destroyed') {
                isDestroyed = true;
            }
            const eventListeners = listeners.get(event) ?? [];
            listeners.delete(event);
            for (const listener of eventListeners) {
                listener(...args);
            }
            return eventListeners.length > 0;
        },
        isDestroyed: vi.fn(() => isDestroyed),
        once: vi.fn(),
        removeListener: vi.fn(),
        send: mocks.senderSend,
    };
    sender.on.mockImplementation((event: string, listener: TListener) => {
        listeners.set(event, [
            ...(listeners.get(event) ?? []),
            listener,
        ]);
        return sender;
    });
    sender.once.mockImplementation((event: string, listener: TListener) => {
        listeners.set(event, [
            ...(listeners.get(event) ?? []),
            listener,
        ]);
        return sender;
    });
    sender.removeListener.mockImplementation((event: string, listener: TListener) => {
        listeners.set(event, (listeners.get(event) ?? []).filter(candidate => candidate !== listener));
        return sender;
    });

    return {sender};
}

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

function createDeferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });

    return {
        promise,
        reject,
        resolve,
    };
}

async function createAuthorizedSearchHarness(senderId: number) {
    const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-search-progress-test-'));
    const realPath = join(tempRoot, 'real.djvu');
    writeFileSync(realPath, new Uint8Array([1]));
    const event = createIpcEvent(senderId);
    const {allowOpenPath} = await import('@electron/file-access/openPathCapabilities');
    allowOpenPath(realPath, event.sender as never);
    registerDjvuIpcAdapter();
    return {
        event,
        realPath,
        cleanup() {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        },
    };
}

function getSentTextSearchProgress() {
    return mocks.senderSend.mock.calls.flatMap(([
        channel,
        payload,
    ]) => channel === 'djvu:text:progress' ? [payload as {
        processed: number;
        status: string
    }] : []);
}

describe('registerDjvuIpcAdapter', () => {
    it('prioritizes visible page previews ahead of nearby and background work', () => {
        expect(resolveDjvuPreviewBrokerPriority(100)).toBe('visible');
        expect(resolveDjvuPreviewBrokerPriority(90)).toBe('visible');
        expect(resolveDjvuPreviewBrokerPriority(50)).toBe('foreground');
        expect(resolveDjvuPreviewBrokerPriority(20)).toBe('user');
        expect(resolveDjvuPreviewBrokerPriority(10)).toBe('background');
    });

    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();
        delete process.env.EVB_DJVU_SWEEP_STALE_TEMP;

        mocks.getDjvuPageCount.mockResolvedValue(1);
        mocks.getDjvuResolution.mockResolvedValue(300);
        mocks.getDjvuOutline.mockResolvedValue('');
        mocks.getDjvuHasText.mockResolvedValue(true);
        mocks.getDjvuMetadata.mockResolvedValue({});
        mocks.parseDjvuOutline.mockReturnValue([]);
        mocks.estimateSizes.mockReturnValue([]);
        mocks.handleDjvuConvertToPdf.mockResolvedValue({success: true});
        mocks.handleDjvuCancel.mockResolvedValue({canceled: true});
        mocks.handleDjvuOpenForViewing.mockResolvedValue({success: true});
        mocks.cancelConversion.mockResolvedValue(true);
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
        mocks.getDjvuPageSizeForViewing.mockResolvedValue({
            width: 100,
            height: 200,
            dpi: 300,
        });
        mocks.renderDjvuPagePreview.mockResolvedValue({
            bytes: new Uint8Array([1]),
            width: 100,
            height: 200,
        });
        mocks.releaseDjvuViewingPath.mockReturnValue(undefined);
        mocks.cleanupDjvuTempPdfPath.mockResolvedValue(undefined);
        mocks.pruneStaleDjvuArtifactJobs.mockResolvedValue(0);
        mocks.getRecentFiles.mockResolvedValue([]);
        mocks.searchDjvuText.mockResolvedValue({
            results: [],
            truncated: false,
        });
    });

    it('prunes only manifest-owned stale artifact jobs during registration', () => {
        registerDjvuIpcAdapter();

        expect(mocks.pruneStaleDjvuArtifactJobs).toHaveBeenCalledOnce();
    });

    it('allows manifest pruning to be disabled for deterministic hosts', () => {
        process.env.EVB_DJVU_SWEEP_STALE_TEMP = '0';

        registerDjvuIpcAdapter();

        expect(mocks.pruneStaleDjvuArtifactJobs).not.toHaveBeenCalled();
    });

    it('delegates cleanupTemp to tracked temp cleanup helper', async () => {
        registerDjvuIpcAdapter();
        const handler = getHandler('djvu:cleanupTemp');

        await handler({sender: {id: 1}}, '/tmp/djvu-123.pdf');

        expect(mocks.cleanupDjvuTempPdfPath).toHaveBeenCalledWith('/tmp/djvu-123.pdf');
    });

    it('runs a full-document text search through one authorized native operation', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-text-search-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            mocks.searchDjvuText.mockResolvedValue({
                results: [{
                    pageNumber: 9,
                    pageMatchIndex: 0,
                    matchIndex: 0,
                    startOffset: 0,
                    endOffset: 6,
                    excerpt: {
                        before: '',
                        match: 'needle',
                        after: '',
                    },
                }],
                truncated: false,
            });

            await expect(getHandler('djvu:text:search')(
                event,
                realPath,
                'needle',
                {
                    requestId: 'native-search',
                    pageCount: 431,
                    matchCase: false,
                    wholeWord: true,
                    useRegex: false,
                },
            )).resolves.toMatchObject({results: [{pageNumber: 9}]});

            expect(mocks.searchDjvuText).toHaveBeenCalledOnce();
            expect(mocks.searchDjvuText).toHaveBeenCalledWith(
                canonicalRealPath,
                expect.objectContaining({
                    requestId: 'native-search',
                    pageCount: 431,
                    query: 'needle',
                    matchOptions: {
                        matchCase: false,
                        wholeWord: true,
                        useRegex: false,
                    },
                    signal: expect.any(AbortSignal),
                }),
            );
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('reports the actual early-truncation page without inflating terminal success progress', async () => {
        const harness = await createAuthorizedSearchHarness(21);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 32,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(37);
                return {
                    results: [],
                    truncated: true,
                };
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'truncated-progress',
                    pageCount: 431,
                },
            )).resolves.toMatchObject({truncated: true});

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                32,
                37,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 37,
                status: 'success',
            }));
        } finally {
            harness.cleanup();
        }
    });

    it('keeps canceled terminal progress at the last actually processed page', async () => {
        const harness = await createAuthorizedSearchHarness(22);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 16,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(23);
                throw new DOMException('Operation aborted', 'AbortError');
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'canceled-progress',
                    pageCount: 431,
                },
            )).resolves.toMatchObject({canceled: true});

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                16,
                23,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 23,
                status: 'canceled',
            }));
        } finally {
            harness.cleanup();
        }
    });

    it('suppresses stale progress and terminal events after a native request ID is superseded', async () => {
        const harness = await createAuthorizedSearchHarness(24);
        const runs = [
            createDeferred<{
                results: [];
                truncated: false
            }>(),
            createDeferred<{
                results: [];
                truncated: false
            }>(),
            createDeferred<{
                results: [];
                truncated: false
            }>(),
        ];
        const searchOptions: ISearchDjvuTextOptions[] = [];
        try {
            mocks.searchDjvuText.mockImplementation((
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                searchOptions.push(options);
                return runs[searchOptions.length - 1]!.promise;
            });
            const handler = getHandler('djvu:text:search');
            const request = {
                requestId: 'reused-native-search',
                pageCount: 431,
            };

            const firstRun = handler(harness.event, harness.realPath, 'first', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(1));
            const secondRun = handler(harness.event, harness.realPath, 'second', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(2));
            const currentRun = handler(harness.event, harness.realPath, 'current', request);
            await vi.waitFor(() => expect(searchOptions).toHaveLength(3));

            expect(searchOptions[0]!.signal!.aborted).toBe(true);
            expect(searchOptions[1]!.signal!.aborted).toBe(true);
            expect(searchOptions[2]!.signal!.aborted).toBe(false);

            searchOptions[0]!.onProgress?.({
                requestId: request.requestId,
                processed: 101,
                total: request.pageCount,
                status: 'running',
            });
            searchOptions[1]!.onProgress?.({
                requestId: request.requestId,
                processed: 202,
                total: request.pageCount,
                status: 'running',
            });
            searchOptions[2]!.onProgress?.({
                requestId: request.requestId,
                processed: 3,
                total: request.pageCount,
                status: 'running',
            });

            runs[0]!.reject(new DOMException('Operation aborted', 'AbortError'));
            runs[1]!.resolve({
                results: [],
                truncated: false,
            });
            runs[2]!.resolve({
                results: [],
                truncated: false,
            });

            await expect(firstRun).resolves.toMatchObject({canceled: true});
            await expect(secondRun).resolves.toMatchObject({canceled: true});
            await expect(currentRun).resolves.toEqual({
                results: [],
                truncated: false,
            });

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                3,
                3,
            ]);
            expect(progress.map(item => item.status)).toEqual([
                'running',
                'success',
            ]);
        } finally {
            harness.cleanup();
        }
    });

    it('keeps failed terminal progress at the last actually processed page', async () => {
        const harness = await createAuthorizedSearchHarness(23);
        try {
            mocks.searchDjvuText.mockImplementation(async (
                _path: string,
                options: ISearchDjvuTextOptions,
            ) => {
                options.onProgress?.({
                    requestId: options.requestId,
                    processed: 24,
                    total: options.pageCount,
                    status: 'running',
                });
                options.onPageProcessed?.(41);
                throw new Error('native parser failed');
            });

            await expect(getHandler('djvu:text:search')(
                harness.event,
                harness.realPath,
                'needle',
                {
                    requestId: 'failed-progress',
                    pageCount: 431,
                },
            )).rejects.toThrow('native parser failed');

            const progress = getSentTextSearchProgress();
            expect(progress.map(item => item.processed)).toEqual([
                24,
                41,
            ]);
            expect(progress.at(-1)).toEqual(expect.objectContaining({
                processed: 41,
                status: 'failed',
            }));
        } finally {
            harness.cleanup();
        }
    });

    it('releases viewing paths without requiring the source file to still exist', () => {
        registerDjvuIpcAdapter();
        const handler = getHandler('djvu:releaseViewingPath');
        const event = createIpcEvent(1);

        handler(event, '/tmp/missing.djvu');

        expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(
            expect.objectContaining({
                sender: event.sender,
                senderId: 1,
                parentWindow: null,
            }),
            '/tmp/missing.djvu',
        );
    });

    it('releases symlinked viewing paths using the granted realpath while the source still exists', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-release-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            const symlinkPath = join(tempRoot, 'link.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            symlinkSync(realPath, symlinkPath);
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(symlinkPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:releaseViewingPath');

            handler(event, symlinkPath);

            expect(mocks.releaseDjvuViewingPath).toHaveBeenCalledWith(
                expect.objectContaining({
                    sender: event.sender,
                    senderId: 1,
                    parentWindow: null,
                }),
                canonicalRealPath,
            );
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('forwards the selected PDF strategy through the convert handler', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-convert-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:convertToPdf');

            await handler(event, realPath, '/tmp/output.pdf', {
                subsample: 1,
                preserveBookmarks: true,
                pdfStrategy: 'compact-djvu-aware',
            });

            expect(mocks.handleDjvuConvertToPdf).toHaveBeenCalledWith(
                expect.objectContaining({
                    sender: event.sender,
                    senderId: 1,
                    parentWindow: null,
                }),
                canonicalRealPath,
                '/tmp/output.pdf',
                {
                    subsample: 1,
                    preserveBookmarks: true,
                    pdfStrategy: 'compact-djvu-aware',
                },
            );
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('requires an active viewing grant before probing page sizes', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-size-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.isAllowedDjvuViewingPath.mockReturnValue(false);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:getPageSizes');

            await expect(handler(event, realPath)).rejects.toThrow('DjVu viewing path is not active');

            expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('probes only the prioritized page size when creating a viewing source', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            mocks.getDjvuPageCount.mockResolvedValue(431);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(event, realPath, 7)).resolves.toEqual({
                pageCount: 431,
                pageNumber: 7,
                pageSize: {
                    width: 100,
                    height: 200,
                    dpi: 300,
                },
                sourceSize: 1,
                sourceModifiedAt: expect.any(Number),
            });

            expect(mocks.getDjvuPageSizeForViewing).toHaveBeenCalledWith(canonicalRealPath, 7);
            expect(mocks.getDjvuPageSizesForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('allows read-only opening geometry prewarm for a persisted Recent DjVu without granting file access', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-recent-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'recent.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            mocks.getRecentFiles.mockResolvedValue([{
                originalPath: realPath,
                fileName: 'recent.djvu',
                timestamp: 1,
            }]);
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(
                createIpcEvent(1),
                realPath,
                1,
            )).resolves.toMatchObject({
                pageCount: 1,
                pageNumber: 1,
            });

            expect(mocks.getDjvuPageSizeForViewing).toHaveBeenCalledWith(canonicalRealPath, 1);
            expect(mocks.isAllowedDjvuViewingPath).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects opening geometry prewarm for an ungranted DjVu outside the persisted Recent list', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-untrusted-source-info-test-'));
        try {
            const realPath = join(tempRoot, 'untrusted.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            registerDjvuIpcAdapter();

            await expect(getHandler('djvu:getPageSourceInfo')(
                createIpcEvent(1),
                realPath,
                1,
            )).rejects.toThrow('Path not allowed');

            expect(mocks.getDjvuPageSizeForViewing).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('renders a page preview only for an active viewing path', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(1);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            await expect(handler(event, realPath, 1, {subsample: 3})).resolves.toEqual({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledWith(
                canonicalRealPath,
                1,
                expect.objectContaining({
                    previewRequestId: expect.stringMatching(/^djvu-preview-/u),
                    subsample: 3,
                }),
                expect.objectContaining({
                    cancelGroup: expect.stringMatching(/^djvu-preview:1:djvu-preview-/u),
                    signal: expect.any(AbortSignal),
                }),
            );
            expect(mocks.getDjvuPageCount).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('isolates identical preview request ids and cancellation across senders', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-sender-key-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const firstEvent = createIpcEvent(21);
            const secondEvent = createIpcEvent(22);
            allowOpenPath(realPath, firstEvent.sender as never);
            allowOpenPath(realPath, secondEvent.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');

            const firstRun = renderHandler(firstEvent, realPath, 1, {
                previewRequestId: 'shared-preview-id',
                subsample: 3,
            });
            const secondRun = renderHandler(secondEvent, realPath, 1, {
                previewRequestId: 'shared-preview-id',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const firstOperation = mocks.renderDjvuPagePreview.mock.calls[0]?.[3];
            const secondOperation = mocks.renderDjvuPagePreview.mock.calls[1]?.[3];
            expect(firstOperation).toMatchObject({
                cancelGroup: 'djvu-preview:21:shared-preview-id',
                signal: expect.any(AbortSignal),
            });
            expect(secondOperation).toMatchObject({
                cancelGroup: 'djvu-preview:22:shared-preview-id',
                signal: expect.any(AbortSignal),
            });

            await expect(cancelHandler(firstEvent, 'shared-preview-id')).resolves.toEqual({canceled: true});

            expect(firstOperation?.signal.aborted).toBe(true);
            expect(secondOperation?.signal.aborted).toBe(false);
            expect(mocks.cancelConversion).toHaveBeenCalledWith('djvu-preview:21:shared-preview-id');
            expect(mocks.cancelConversion).not.toHaveBeenCalledWith('djvu-preview:22:shared-preview-id');

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });
            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('keeps a newer matching preview operation registered when the older operation completes', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-operation-identity-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(24);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');

            const firstRun = renderHandler(event, realPath, 1, {
                previewRequestId: 'reused-preview-id',
                subsample: 3,
            });
            const secondRun = renderHandler(event, realPath, 2, {
                previewRequestId: 'reused-preview-id',
                subsample: 3,
            });
            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const secondSignal = mocks.renderDjvuPagePreview.mock.calls[1]?.[3]?.signal as AbortSignal | undefined;

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });
            await expect(firstRun).resolves.toMatchObject({width: 100});

            await expect(cancelHandler(event, 'reused-preview-id')).resolves.toEqual({canceled: true});
            expect(secondSignal?.aborted).toBe(true);

            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            await expect(secondRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects oversized preview request ids in main before starting native work', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-id-limit-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(23);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            await expect(handler(event, realPath, 1, {previewRequestId: 'x'.repeat(129)}))
                .rejects.toThrow('renderPagePreview.options.previewRequestId exceeds maximum length (128)');

            expect(mocks.renderDjvuPagePreview).not.toHaveBeenCalled();
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('drops superseded queued native preview requests per sender before spawning conversion', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-coalesce-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const fourthPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise)
                .mockReturnValueOnce(fourthPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(9);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-2',
                subsample: 3,
            });
            const thirdRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-3',
                subsample: 3,
            });
            const thirdRejection = expect(thirdRun).rejects.toThrow('DjVu preview request superseded');
            const fourthRun = handler(event, realPath, 1, {
                previewRequestId: 'preview-4',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            await thirdRejection;
            await Promise.resolve();

            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3);
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 1, {
                previewRequestId: 'preview-4',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:9:preview-4',
                signal: expect.any(AbortSignal),
            }));

            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            fourthPreview.resolve({
                bytes: new Uint8Array([4]),
                width: 100,
                height: 200,
            });

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(fourthRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('rejects queued native preview requests when their sender is destroyed', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-destroy-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(12);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewRequestId: 'destroy-preview-1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewRequestId: 'destroy-preview-2',
                subsample: 3,
            });
            const queuedRun = handler(event, realPath, 3, {
                previewRequestId: 'destroy-preview-3',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            const firstSignal = mocks.renderDjvuPagePreview.mock.calls[0]?.[3]?.signal as AbortSignal | undefined;
            const secondSignal = mocks.renderDjvuPagePreview.mock.calls[1]?.[3]?.signal as AbortSignal | undefined;

            const queuedRejection = expect(queuedRun).rejects.toThrow('Renderer lifecycle ended');
            event.sender.emit('destroyed');

            await queuedRejection;
            expect(firstSignal?.aborted).toBe(true);
            expect(secondSignal?.aborted).toBe(true);
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });
            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('cancels a queued native preview before it consumes a native-process slot', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-cancel-queued-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(14);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const renderHandler = getHandler('djvu:renderPagePreview');
            const cancelHandler = getHandler('djvu:cancelPagePreview');
            const firstRun = renderHandler(event, realPath, 1, {previewRequestId: 'preview-active-1'});
            const secondRun = renderHandler(event, realPath, 2, {previewRequestId: 'preview-active-2'});
            const queuedRun = renderHandler(event, realPath, 3, {previewRequestId: 'preview-queued'});

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            await expect(cancelHandler(event, 'preview-queued')).resolves.toEqual({canceled: true});
            await expect(queuedRun).rejects.toThrow('DjVu preview request canceled');

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });
            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('aborts active estimate size requests when their sender is destroyed', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-estimate-destroy-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const estimateState: {signal: AbortSignal | undefined} = {signal: undefined};
            mocks.estimateSizes.mockImplementation((
                _djvuPath: string,
                _pageCount: number,
                options?: {signal?: AbortSignal},
            ) => new Promise((_resolve, reject) => {
                const signal = options?.signal;
                estimateState.signal = signal;
                signal?.addEventListener('abort', () => {
                    reject(signal.reason);
                }, {once: true});
            }));

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(13);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:estimateSizes');

            const estimateRun = handler(event, realPath);

            await vi.waitFor(() => expect(mocks.estimateSizes).toHaveBeenCalledTimes(1));
            event.sender.emit('destroyed');

            expect(estimateState.signal?.aborted).toBe(true);
            await expect(estimateRun).rejects.toThrow('Renderer lifecycle ended');
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('prioritizes visible native preview waiters over retained queued pages', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-priority-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const visiblePreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const retainedPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise)
                .mockReturnValueOnce(visiblePreview.promise)
                .mockReturnValueOnce(retainedPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(10);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewPriority: 10,
                previewRequestId: '1:1:1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewPriority: 9,
                previewRequestId: '1:2:1',
                subsample: 3,
            });
            const retainedRun = handler(event, realPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            });
            const visibleRun = handler(event, realPath, 3, {
                previewPriority: 20,
                previewRequestId: '1:3:1',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 3, {
                previewPriority: 20,
                previewRequestId: '1:3:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:10:1:3:1',
                signal: expect.any(AbortSignal),
            }));

            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(4));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(4, canonicalRealPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:10:1:8:1',
                signal: expect.any(AbortSignal),
            }));

            visiblePreview.resolve({
                bytes: new Uint8Array([3]),
                width: 100,
                height: 200,
            });
            retainedPreview.resolve({
                bytes: new Uint8Array([8]),
                width: 100,
                height: 200,
            });

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(visibleRun).resolves.toMatchObject({width: 100});
            await expect(retainedRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });

    it('drops older generation native preview waiters before they consume render slots', async () => {
        const tempRoot = mkdtempSync(join(tmpdir(), 'evb-djvu-preview-generation-test-'));
        try {
            const realPath = join(tempRoot, 'real.djvu');
            writeFileSync(realPath, new Uint8Array([1]));
            const canonicalRealPath = realpathSync.native(realPath);
            const firstPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const secondPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            const nextGenerationPreview = createDeferred<{
                bytes: Uint8Array;
                width: number;
                height: number;
            }>();
            mocks.renderDjvuPagePreview
                .mockReturnValueOnce(firstPreview.promise)
                .mockReturnValueOnce(secondPreview.promise)
                .mockReturnValueOnce(nextGenerationPreview.promise);

            const { allowOpenPath } = await import('@electron/file-access/openPathCapabilities');
            const event = createIpcEvent(11);
            allowOpenPath(realPath, event.sender as never);
            registerDjvuIpcAdapter();
            const handler = getHandler('djvu:renderPagePreview');

            const firstRun = handler(event, realPath, 1, {
                previewPriority: 10,
                previewRequestId: '1:1:1',
                subsample: 3,
            });
            const secondRun = handler(event, realPath, 2, {
                previewPriority: 9,
                previewRequestId: '1:2:1',
                subsample: 3,
            });
            const staleRun = handler(event, realPath, 8, {
                previewPriority: 1,
                previewRequestId: '1:8:1',
                subsample: 3,
            });
            const staleRejection = expect(staleRun).rejects.toThrow('DjVu preview request superseded');
            const nextGenerationRun = handler(event, realPath, 3, {
                previewPriority: 20,
                previewRequestId: '2:3:1',
                subsample: 3,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2));
            await staleRejection;

            firstPreview.resolve({
                bytes: new Uint8Array([1]),
                width: 100,
                height: 200,
            });

            await vi.waitFor(() => expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(3));
            expect(mocks.renderDjvuPagePreview).toHaveBeenNthCalledWith(3, canonicalRealPath, 3, {
                previewPriority: 20,
                previewRequestId: '2:3:1',
                subsample: 3,
            }, expect.objectContaining({
                cancelGroup: 'djvu-preview:11:2:3:1',
                signal: expect.any(AbortSignal),
            }));

            secondPreview.resolve({
                bytes: new Uint8Array([2]),
                width: 100,
                height: 200,
            });
            nextGenerationPreview.resolve({
                bytes: new Uint8Array([3]),
                width: 100,
                height: 200,
            });

            await expect(firstRun).resolves.toMatchObject({width: 100});
            await expect(secondRun).resolves.toMatchObject({width: 100});
            await expect(nextGenerationRun).resolves.toMatchObject({width: 100});
        } finally {
            rmSync(tempRoot, {
                force: true,
                recursive: true,
            });
        }
    });
});
