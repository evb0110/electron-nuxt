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
    isAllowedDjvuViewingPath: vi.fn(),
    getDjvuPageSizesForViewing: vi.fn(),
    renderDjvuPagePreview: vi.fn(),
    releaseDjvuViewingPath: vi.fn(),
    cleanupDjvuTempPdfPath: vi.fn(),
    sweepStaleDjvuTempPdfs: vi.fn(),
}));

vi.mock('electron', () => ({
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
    sweepStaleDjvuTempPdfs: mocks.sweepStaleDjvuTempPdfs,
}));
vi.mock('@electron/features/djvu/main/pagePreview', () => ({
    getDjvuPageSizesForViewing: mocks.getDjvuPageSizesForViewing,
    renderDjvuPagePreview: mocks.renderDjvuPagePreview,
}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

const { registerDjvuIpcAdapter } = await import('@electron/features/djvu/registerDjvuIpcAdapter');

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

describe('registerDjvuIpcAdapter', () => {
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
        mocks.isAllowedDjvuViewingPath.mockReturnValue(true);
        mocks.getDjvuPageSizesForViewing.mockResolvedValue([{
            width: 100,
            height: 200,
            dpi: 300,
        }]);
        mocks.renderDjvuPagePreview.mockResolvedValue({
            bytes: new Uint8Array([1]),
            width: 100,
            height: 200,
        });
        mocks.releaseDjvuViewingPath.mockReturnValue(undefined);
        mocks.cleanupDjvuTempPdfPath.mockResolvedValue(undefined);
        mocks.sweepStaleDjvuTempPdfs.mockResolvedValue(0);
    });

    it('triggers stale DjVu temp sweep during handler registration by default', () => {
        registerDjvuIpcAdapter();

        expect(mocks.sweepStaleDjvuTempPdfs).toHaveBeenCalledTimes(1);
    });

    it('skips stale sweep when explicitly disabled', () => {
        process.env.EVB_DJVU_SWEEP_STALE_TEMP = '0';

        registerDjvuIpcAdapter();

        expect(mocks.sweepStaleDjvuTempPdfs).not.toHaveBeenCalled();
    });

    it('delegates cleanupTemp to tracked temp cleanup helper', async () => {
        registerDjvuIpcAdapter();
        const handler = getHandler('djvu:cleanupTemp');

        await handler({sender: {id: 1}}, '/tmp/djvu-123.pdf');

        expect(mocks.cleanupDjvuTempPdfPath).toHaveBeenCalledWith('/tmp/djvu-123.pdf');
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
                    cancelGroup: expect.stringMatching(/^djvu-preview:djvu-preview-/u),
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

            await Promise.resolve();
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);

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
                cancelGroup: 'djvu-preview:preview-4',
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

            await Promise.resolve();
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
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

            await Promise.resolve();
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);

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
                cancelGroup: 'djvu-preview:1:3:1',
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
                cancelGroup: 'djvu-preview:1:8:1',
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

            await Promise.resolve();
            expect(mocks.renderDjvuPagePreview).toHaveBeenCalledTimes(2);
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
                cancelGroup: 'djvu-preview:2:3:1',
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
