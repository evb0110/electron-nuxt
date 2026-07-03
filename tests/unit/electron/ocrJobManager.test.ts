import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
    ensureRuntimeTessdataSeeded: vi.fn(),
    ensureTessdataLanguages: vi.fn(),
    existsSync: vi.fn(() => true),
    workerInstances: [] as Array<{
        listeners: Map<string, Array<(...args: unknown[]) => void>>;
        postMessage: ReturnType<typeof vi.fn>;
        terminate: ReturnType<typeof vi.fn>;
        emit: (event: string, ...args: unknown[]) => void;
        on: (event: string, listener: (...args: unknown[]) => void) => unknown;
        removeAllListeners: () => unknown;
    }>,
    getOcrToolPaths: vi.fn(() => ({
        tesseract: '/mock/tesseract',
        tessdata: '/mock/tessdata',
        pdftoppm: '/mock/pdftoppm',
        pdftotext: '/mock/pdftotext',
        pdfimages: '/mock/pdfimages',
        popplerDataDir: '/mock/poppler/share',
        popplerFontConfigDir: '/mock/poppler/fonts',
        qpdf: '/mock/qpdf',
        unpaper: '/mock/unpaper',
    })),
    logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
    },
    stat: vi.fn(async () => ({
        size: 1024,
        isFile: () => true,
    })),
    unlink: vi.fn(async () => {}),
    sendToLiveWindow: vi.fn(),
    getWorkingCopyRevision: vi.fn(),
}));

vi.mock('electron', () => ({
    BrowserWindow: {getAllWindows: vi.fn(() => [])},
    app: {getPath: vi.fn(() => '/tmp')},
}));

vi.mock('worker_threads', () => ({Worker: class {
    listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    postMessage = vi.fn();
    terminate = vi.fn(async () => 0);

    constructor() {
        mocks.workerInstances.push(this);
    }

    on(event: string, listener: (...args: unknown[]) => void) {
        const listeners = this.listeners.get(event) ?? [];
        listeners.push(listener);
        this.listeners.set(event, listeners);
        return this;
    }

    removeAllListeners() {
        this.listeners.clear();
        return this;
    }

    emit(event: string, ...args: unknown[]) {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(...args);
        }
    }
}}));

vi.mock('fs', () => ({
    chmodSync: vi.fn(),
    existsSync: mocks.existsSync,
    lstatSync: vi.fn(() => ({isSymbolicLink: () => false})),
    mkdirSync: vi.fn(),
}));
vi.mock('fs/promises', () => ({
    stat: mocks.stat,
    unlink: mocks.unlink,
}));
vi.mock('@electron/ocr/languageModels', () => ({
    ensureRuntimeTessdataSeeded: mocks.ensureRuntimeTessdataSeeded,
    ensureTessdataLanguages: mocks.ensureTessdataLanguages,
}));
vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: mocks.getOcrToolPaths}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/utils/sendToLiveWindow', () => ({sendToLiveWindow: mocks.sendToLiveWindow}));
vi.mock('@electron/file-access/documentRevisionStore', () => ({getWorkingCopyRevision: mocks.getWorkingCopyRevision}));

function createDocumentRevision(documentRef: string) {
    return {
        version: 1 as const,
        documentRef,
        authority: 'electron-working-copy' as const,
        token: `revision-token:${documentRef}`,
        contentRevision: 1,
        mintedAt: 1,
    };
}

function createContext(senderId: number) {
    const sender = {
        id: senderId,
        isDestroyed: vi.fn(() => false),
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
    };
    return {
        sender,
        senderId,
    };
}

function getResourceAcquiredMessages(worker: { postMessage: ReturnType<typeof vi.fn> }) {
    return worker.postMessage.mock.calls
        .flatMap(([message]) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'resource-acquired'
                && 'requestId' in message
                && typeof message.requestId === 'string'
            ) {
                return [{
                    type: message.type,
                    requestId: message.requestId,
                }];
            }

            return [];
        });
}

function getResourceDeniedMessages(worker: { postMessage: ReturnType<typeof vi.fn> }) {
    return worker.postMessage.mock.calls
        .flatMap(([message]) => {
            if (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'resource-denied'
                && 'requestId' in message
                && typeof message.requestId === 'string'
            ) {
                return [{
                    type: message.type,
                    requestId: message.requestId,
                }];
            }

            return [];
        });
}

describe('ocr job manager preparing-stage robustness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_OCR_QUEUE_MAX_SIZE', '1');
        vi.stubEnv('EVB_OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS', '0');
        mocks.ensureRuntimeTessdataSeeded.mockResolvedValue(undefined);
        mocks.ensureTessdataLanguages.mockReset();
        mocks.workerInstances.length = 0;
        mocks.stat.mockResolvedValue({
            size: 1024,
            isFile: () => true,
        });
        mocks.getWorkingCopyRevision.mockImplementation(async (documentRef: string) => createDocumentRevision(documentRef));
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        const { shutdownOcrJobManager } = await import('@electron/ocr/jobManager');
        await shutdownOcrJobManager();
    });

    it('counts preparing jobs toward queue capacity', async () => {
        const firstContext = createContext(11);
        let resolvePreparation!: () => void;

        mocks.ensureTessdataLanguages.mockImplementationOnce((_languages, options?: { signal?: AbortSignal }) => {
            return new Promise<void>((resolve, reject) => {
                resolvePreparation = resolve;
                options?.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason ?? new Error('aborted'));
                }, { once: true });
            });
        });

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const firstPromise = handleOcrCreateSearchablePdfAsync(
            firstContext,
            '/tmp/work-1.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'], 
            }],
            'job-1',
        );

        await vi.waitFor(() => {
            expect(mocks.ensureTessdataLanguages).toHaveBeenCalledTimes(1);
        });

        const secondResult = await handleOcrCreateSearchablePdfAsync(
            createContext(22),
            '/tmp/work-2.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'], 
            }],
            'job-2',
        );

        expect(secondResult).toMatchObject({
            started: false,
            error: 'OCR queue is full (1 jobs)',
        });

        expect(handleOcrCancel(firstContext, 'job-1')).toEqual({ canceled: true });
        await expect(firstPromise).resolves.toMatchObject({
            started: false,
            error: 'OCR job was cancelled before it started',
        });

        resolvePreparation();
    });

    it('enforces the buffered byte cap for the admitting job', async () => {
        vi.stubEnv('EVB_OCR_QUEUE_MAX_BUFFERED_MB', '32');
        mocks.stat.mockResolvedValueOnce({
            size: 34 * 1024 * 1024,
            isFile: () => true,
        });

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createContext(23),
            '/tmp/work-large.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-large',
        );

        expect(result).toMatchObject({
            started: false,
            error: 'OCR queue is full (buffer cap 32MB reached)',
        });
        expect(mocks.ensureTessdataLanguages).not.toHaveBeenCalled();
    });

    it('aborts preparing jobs on cancel and frees the slot for a later job', async () => {
        const firstContext = createContext(33);

        mocks.ensureTessdataLanguages.mockImplementationOnce((_languages, options?: { signal?: AbortSignal }) => {
            return new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason ?? new Error('aborted'));
                }, { once: true });
            });
        });
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const firstPromise = handleOcrCreateSearchablePdfAsync(
            firstContext,
            '/tmp/work-3.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'], 
            }],
            'job-3',
        );

        await vi.waitFor(() => {
            expect(mocks.ensureTessdataLanguages).toHaveBeenCalledTimes(1);
        });

        const firstSignal = mocks.ensureTessdataLanguages.mock.calls[0]?.[1]?.signal as AbortSignal;
        expect(handleOcrCancel(firstContext, 'job-3')).toEqual({ canceled: true });
        await expect(firstPromise).resolves.toMatchObject({
            started: false,
            error: 'OCR job was cancelled before it started',
        });
        expect(firstSignal.aborted).toBe(true);

        const secondResult = await handleOcrCreateSearchablePdfAsync(
            createContext(44),
            '/tmp/work-4.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'], 
            }],
            'job-4',
        );

        expect(secondResult).toMatchObject({
            started: true,
            jobId: 'job-4',
        });
    });

    it('uses worker activity as the OCR job watchdog heartbeat', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_OCR_JOB_IDLE_TIMEOUT_MS', '15000');
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createContext(55),
            '/tmp/work-5.pdf',
            [
                {
                    pageNumber: 1,
                    languages: ['eng'],
                },
                {
                    pageNumber: 2,
                    languages: ['eng'],
                },
            ],
            'job-5',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-5',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();

        await vi.advanceTimersByTimeAsync(14_000);
        expect(worker?.terminate).not.toHaveBeenCalled();

        worker?.emit('message', {
            type: 'progress',
            jobId: 'job-5',
            progress: {
                requestId: 'job-5',
                currentPage: 1,
                processedCount: 1,
                totalPages: 2,
            },
        });

        await vi.advanceTimersByTimeAsync(14_000);
        expect(worker?.terminate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1_251);
        expect(worker?.terminate).toHaveBeenCalledTimes(1);
        const completeCalls = mocks.sendToLiveWindow.mock.calls.filter(([
            ,
            channel,
        ]) => channel === 'ocr:complete');
        expect(completeCalls).toHaveLength(1);
        expect(completeCalls[0]?.[2]).toEqual([expect.objectContaining({
            requestId: 'job-5',
            success: false,
            errors: [expect.stringContaining('OCR job idle timed out')],
            errorEnvelope: expect.objectContaining({
                code: 'OCR_INTERNAL_ERROR',
                message: expect.stringContaining('OCR job idle timed out'),
                retryable: false,
                timestamp: expect.any(Number),
            }),
        })]);
        vi.useRealTimers();
    });

    it('does not treat malformed worker messages as watchdog heartbeat', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_OCR_JOB_IDLE_TIMEOUT_MS', '15000');
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await handleOcrCreateSearchablePdfAsync(
            createContext(56),
            '/tmp/work-6.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-6',
        );

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();

        await vi.advanceTimersByTimeAsync(14_000);
        worker?.emit('message', {
            type: 'progress',
            jobId: 'job-6',
            progress: {
                requestId: 'job-6',
                currentPage: Number.NaN,
                processedCount: 0,
                totalPages: 1,
            },
        });

        await vi.advanceTimersByTimeAsync(1_251);

        expect(worker?.terminate).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });

    it('does not re-arm the idle watchdog after a terminal result', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_OCR_JOB_IDLE_TIMEOUT_MS', '15000');
        vi.stubEnv('EVB_OCR_WORKER_CLEANUP_GRACE_MS', '60000');
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await handleOcrCreateSearchablePdfAsync(
            createContext(57),
            '/tmp/work-7.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-7',
        );

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-7',
            result: {
                success: false,
                errors: ['done'],
            },
        });
        const terminalCalls = () => mocks.sendToLiveWindow.mock.calls.filter(([
            ,
            channel,
        ]) => channel === 'ocr:complete');
        expect(terminalCalls()).toHaveLength(1);

        worker?.emit('message', {
            type: 'progress',
            jobId: 'job-7',
            progress: {
                requestId: 'job-7',
                currentPage: 1,
                processedCount: 1,
                totalPages: 1,
            },
        });
        await vi.advanceTimersByTimeAsync(15_001);

        expect(worker?.terminate).not.toHaveBeenCalled();
        expect(terminalCalls()).toHaveLength(1);
        vi.useRealTimers();
    });

    it('ignores progress and completion messages emitted after active cancellation', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const context = createContext(66);
        const result = await handleOcrCreateSearchablePdfAsync(
            context,
            '/tmp/work-6.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-6',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-6',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        expect(handleOcrCancel(context, 'job-6')).toEqual({ canceled: true });

        worker?.emit('message', {
            type: 'progress',
            jobId: 'job-6',
            progress: {
                requestId: 'job-6',
                currentPage: 1,
                processedCount: 1,
                totalPages: 1,
            },
        });
        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-6',
            result: {
                success: false,
                errors: ['cancelled'],
            },
        });

        expect(mocks.sendToLiveWindow).not.toHaveBeenCalled();
    });

    it('keeps active cancellation in the worker pool until termination settles', async () => {
        vi.stubEnv('EVB_OCR_WORKER_POOL_SIZE', '1');
        mocks.ensureTessdataLanguages.mockResolvedValue(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const firstContext = createContext(67);
        await expect(handleOcrCreateSearchablePdfAsync(
            firstContext,
            '/tmp/work-67.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-67',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-67',
        });

        const firstWorker = mocks.workerInstances[0];
        expect(firstWorker).toBeDefined();
        let resolveTerminate!: () => void;
        firstWorker?.terminate.mockImplementationOnce(() => new Promise<number>((resolve) => {
            resolveTerminate = () => resolve(0);
        }));

        const secondPromise = handleOcrCreateSearchablePdfAsync(
            createContext(68),
            '/tmp/work-68.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-68',
        );
        await Promise.resolve();

        expect(handleOcrCancel(firstContext, 'job-67')).toEqual({ canceled: true });
        await Promise.resolve();
        expect(mocks.workerInstances).toHaveLength(1);

        resolveTerminate();
        await vi.waitFor(() => {
            expect(mocks.workerInstances).toHaveLength(2);
        });
        await expect(secondPromise).resolves.toMatchObject({
            started: true,
            jobId: 'job-68',
        });
    });

    it('still forwards completion from the current active worker', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createContext(77),
            '/tmp/work-7.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-7',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-7',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-7',
            result: {
                success: true,
                pdfPath: '/tmp/work-7-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });
        worker?.emit('message', {
            type: 'cleanup-complete',
            jobId: 'job-7',
        });

        expect(mocks.sendToLiveWindow).toHaveBeenCalledWith(
            undefined,
            'ocr:complete',
            [{
                requestId: 'job-7',
                success: true,
                pdfPath: '/tmp/work-7-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            }],
            expect.any(Function),
        );
    });

    it('adds typed envelopes when forwarding worker failure completions', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createContext(79),
            '/tmp/work-79.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-79',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-79',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-79',
            result: {
                success: false,
                errors: ['Worker failed before producing OCR output'],
            },
        });

        expect(mocks.sendToLiveWindow).toHaveBeenCalledWith(
            undefined,
            'ocr:complete',
            [{
                requestId: 'job-79',
                success: false,
                errors: ['Worker failed before producing OCR output'],
                errorEnvelope: expect.objectContaining({
                    code: 'OCR_INTERNAL_ERROR',
                    message: 'Worker failed before producing OCR output',
                    retryable: false,
                    timestamp: expect.any(Number),
                }),
            }],
            expect.any(Function),
        );
    });

    it('forwards successful completion even when cleanup completion never arrives', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await expect(handleOcrCreateSearchablePdfAsync(
            createContext(177),
            '/tmp/work-177.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-177',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-177',
        });

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-177',
            result: {
                success: true,
                pdfPath: '/tmp/work-177-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });
        worker?.emit('exit', 0);

        const completeCalls = mocks.sendToLiveWindow.mock.calls.filter(([
            ,
            channel,
        ]) => channel === 'ocr:complete');
        expect(completeCalls).toHaveLength(1);
        expect(mocks.sendToLiveWindow).toHaveBeenCalledWith(
            undefined,
            'ocr:complete',
            [{
                requestId: 'job-177',
                success: true,
                pdfPath: '/tmp/work-177-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            }],
            expect.any(Function),
        );
    });

    it('bounds worker cleanup after a terminal result when cleanup completion never arrives', async () => {
        vi.useFakeTimers();
        vi.stubEnv('EVB_OCR_WORKER_CLEANUP_GRACE_MS', '1000');
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await expect(handleOcrCreateSearchablePdfAsync(
            createContext(178),
            '/tmp/work-178.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-178',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-178',
        });

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-178',
            result: {
                success: true,
                pdfPath: '/tmp/work-178-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });

        expect(worker?.terminate).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1000);

        expect(worker?.terminate).toHaveBeenCalledTimes(1);
        const completeCalls = mocks.sendToLiveWindow.mock.calls.filter(([
            ,
            channel,
        ]) => channel === 'ocr:complete');
        expect(completeCalls).toHaveLength(1);
        vi.useRealTimers();
    });

    it('does not send a failure completion when a worker errors after success', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await expect(handleOcrCreateSearchablePdfAsync(
            createContext(179),
            '/tmp/work-179.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-179',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-179',
        });

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        mocks.sendToLiveWindow.mockClear();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-179',
            result: {
                success: true,
                pdfPath: '/tmp/work-179-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });
        worker?.emit('error', new Error('late worker failure'));

        const completeCalls = mocks.sendToLiveWindow.mock.calls.filter(([
            ,
            channel,
        ]) => channel === 'ocr:complete');
        expect(completeCalls).toHaveLength(1);
        expect(completeCalls[0]?.[2]).toEqual([expect.objectContaining({
            requestId: 'job-179',
            success: true,
        })]);
    });

    it('denies resource acquires after a terminal result has been sent', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        await expect(handleOcrCreateSearchablePdfAsync(
            createContext(180),
            '/tmp/work-180.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-180',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-180',
        });

        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();
        if (!worker) {
            throw new Error('Expected OCR worker to be created');
        }

        worker.emit('message', {
            type: 'complete',
            jobId: 'job-180',
            result: {
                success: true,
                pdfPath: '/tmp/work-180-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });

        worker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-180',
            requestId: 'page-after-terminal',
            pageNumber: 1,
            requestedDpi: 300,
        });

        expect(getResourceAcquiredMessages(worker)).toEqual([]);
        expect(getResourceDeniedMessages(worker)).toEqual([expect.objectContaining({ requestId: 'page-after-terminal' })]);
    });

    it('accepts owned resource releases while an active cancellation is terminating', async () => {
        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '1');
        mocks.ensureTessdataLanguages.mockResolvedValue(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const firstContext = createContext(181);
        await expect(handleOcrCreateSearchablePdfAsync(
            firstContext,
            '/tmp/work-181.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-181',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-181',
        });

        const firstWorker = mocks.workerInstances[0];
        expect(firstWorker).toBeDefined();
        if (!firstWorker) {
            throw new Error('Expected first OCR worker to be created');
        }

        firstWorker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-181',
            requestId: 'page-1',
            pageNumber: 1,
            requestedDpi: 300,
        });
        await vi.waitFor(() => {
            expect(getResourceAcquiredMessages(firstWorker)).toEqual([expect.objectContaining({ requestId: 'page-1' })]);
        });
        const firstLeaseMessage = firstWorker.postMessage.mock.calls
            .map(([message]) => message)
            .find(message =>
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'resource-acquired'
                && 'token' in message
                && typeof message.token === 'string');
        if (
            typeof firstLeaseMessage !== 'object'
            || firstLeaseMessage === null
            || !('token' in firstLeaseMessage)
            || typeof firstLeaseMessage.token !== 'string'
        ) {
            throw new Error('Expected first OCR worker to receive a resource lease token');
        }

        let resolveTerminate!: () => void;
        firstWorker.terminate.mockImplementationOnce(() => new Promise<number>((resolve) => {
            resolveTerminate = () => resolve(0);
        }));

        expect(handleOcrCancel(firstContext, 'job-181')).toEqual({ canceled: true });
        firstWorker.emit('message', {
            type: 'resource-release',
            jobId: 'job-181',
            token: firstLeaseMessage.token,
        });

        await expect(handleOcrCreateSearchablePdfAsync(
            createContext(182),
            '/tmp/work-182.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-182',
        )).resolves.toMatchObject({
            started: true,
            jobId: 'job-182',
        });

        const secondWorker = mocks.workerInstances[1];
        expect(secondWorker).toBeDefined();
        if (!secondWorker) {
            throw new Error('Expected second OCR worker to be created');
        }

        secondWorker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-182',
            requestId: 'page-1',
            pageNumber: 1,
            requestedDpi: 300,
        });
        await vi.waitFor(() => {
            expect(getResourceAcquiredMessages(secondWorker)).toEqual([expect.objectContaining({ requestId: 'page-1' })]);
        });

        resolveTerminate();
    });

    it('keeps a delivered successful result file when canceled before worker cleanup completes', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const context = createContext(78);
        const result = await handleOcrCreateSearchablePdfAsync(
            context,
            '/tmp/work-78.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-78',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-78',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();

        worker?.emit('message', {
            type: 'complete',
            jobId: 'job-78',
            result: {
                success: true,
                pdfPath: '/tmp/work-78-ocr.pdf',
                requiresCleanupAck: true,
                errors: [],
            },
        });

        expect(handleOcrCancel(context, 'job-78')).toEqual({ canceled: true });
        expect(mocks.unlink).not.toHaveBeenCalledWith('/tmp/work-78-ocr.pdf');
    });

    it('clears preparing progress pump timers when canceling before queueing', async () => {
        vi.useFakeTimers();
        const context = createContext(80);

        mocks.ensureTessdataLanguages.mockImplementationOnce((_languages, options?: { signal?: AbortSignal }) => {
            return new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener('abort', () => {
                    reject(options.signal?.reason ?? new Error('aborted'));
                }, { once: true });
            });
        });

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const startPromise = handleOcrCreateSearchablePdfAsync(
            context,
            '/tmp/work-80.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-80',
        );

        await vi.waitFor(() => {
            expect(mocks.ensureTessdataLanguages).toHaveBeenCalledTimes(1);
        });
        expect(vi.getTimerCount()).toBeGreaterThan(0);

        expect(handleOcrCancel(context, 'job-80')).toEqual({ canceled: true });
        await expect(startPromise).resolves.toMatchObject({
            started: false,
            error: 'OCR job was cancelled before it started',
        });

        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('sends renderer request ids when canceling active jobs during shutdown', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCreateSearchablePdfAsync,
            shutdownOcrJobManager,
        } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createContext(88),
            '/tmp/work-8.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-8',
        );

        expect(result).toMatchObject({
            started: true,
            jobId: 'job-8',
        });
        const worker = mocks.workerInstances[0];
        expect(worker).toBeDefined();

        await shutdownOcrJobManager();

        expect(worker?.postMessage).toHaveBeenCalledWith({
            type: 'cancel',
            jobId: 'job-8',
        });
    });

    it('releases active OCR resource leases and rejects queued resource acquires when canceling an active job', async () => {
        vi.stubEnv('OCR_GLOBAL_PAGE_SLOTS', '1');
        mocks.ensureTessdataLanguages.mockResolvedValue(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const firstContext = createContext(99);
        const firstResult = await handleOcrCreateSearchablePdfAsync(
            firstContext,
            '/tmp/work-99.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-99',
        );

        expect(firstResult).toMatchObject({
            started: true,
            jobId: 'job-99',
        });
        const firstWorker = mocks.workerInstances[0];
        expect(firstWorker).toBeDefined();
        if (!firstWorker) {
            throw new Error('Expected first OCR worker to be created');
        }

        firstWorker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-99',
            requestId: 'page-1',
            pageNumber: 1,
            requestedDpi: 300,
        });
        await vi.waitFor(() => {
            expect(getResourceAcquiredMessages(firstWorker)).toEqual([expect.objectContaining({ requestId: 'page-1' })]);
        });

        firstWorker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-99',
            requestId: 'page-2',
            pageNumber: 2,
            requestedDpi: 300,
        });
        await Promise.resolve();

        expect(getResourceAcquiredMessages(firstWorker)).toEqual([expect.objectContaining({ requestId: 'page-1' })]);

        expect(handleOcrCancel(firstContext, 'job-99')).toEqual({ canceled: true });
        await vi.waitFor(() => {
            expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OCR resource request cancelled for job 99:job-99'));
        });
        expect(getResourceDeniedMessages(firstWorker)).toEqual([expect.objectContaining({ requestId: 'page-2' })]);

        const secondResult = await handleOcrCreateSearchablePdfAsync(
            createContext(100),
            '/tmp/work-100.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-100',
        );

        expect(secondResult).toMatchObject({
            started: true,
            jobId: 'job-100',
        });
        const secondWorker = mocks.workerInstances[1];
        expect(secondWorker).toBeDefined();
        if (!secondWorker) {
            throw new Error('Expected second OCR worker to be created');
        }

        secondWorker.emit('message', {
            type: 'resource-acquire',
            jobId: 'job-100',
            requestId: 'page-1',
            pageNumber: 1,
            requestedDpi: 300,
        });

        await vi.waitFor(() => {
            expect(getResourceAcquiredMessages(secondWorker)).toEqual([expect.objectContaining({ requestId: 'page-1' })]);
        });
    });
});
