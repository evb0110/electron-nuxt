import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mocks = vi.hoisted(() => ({
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
vi.mock('@electron/ocr/languageModels', () => ({ensureTessdataLanguages: mocks.ensureTessdataLanguages}));
vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: mocks.getOcrToolPaths}));
vi.mock('@electron/utils/createLogger', () => ({createLogger: () => mocks.logger}));
vi.mock('@electron/utils/sendToLiveWindow', () => ({sendToLiveWindow: mocks.sendToLiveWindow}));

function createEvent(senderId: number) {
    return {sender: {
        id: senderId,
        isDestroyed: vi.fn(() => false),
        once: vi.fn(),
        removeListener: vi.fn(),
    }};
}

function getResourceAcquiredMessages(worker: { postMessage: ReturnType<typeof vi.fn> }) {
    return worker.postMessage.mock.calls
        .map(([message]) => message)
        .filter((message): message is {
            type: 'resource-acquired';
            requestId: string;
        } => {
            return typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'resource-acquired';
        });
}

describe('ocr job manager preparing-stage robustness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_OCR_QUEUE_MAX_SIZE', '1');
        vi.stubEnv('EVB_OCR_WORKER_COOPERATIVE_CANCEL_DELAY_MS', '0');
        mocks.ensureTessdataLanguages.mockReset();
        mocks.workerInstances.length = 0;
        mocks.stat.mockResolvedValue({
            size: 1024,
            isFile: () => true,
        });
    });

    afterEach(async () => {
        vi.useRealTimers();
        vi.unstubAllEnvs();
        const { shutdownOcrJobManager } = await import('@electron/ocr/jobManager');
        await shutdownOcrJobManager();
    });

    it('counts preparing jobs toward queue capacity', async () => {
        const firstEvent = createEvent(11);
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
            firstEvent as never,
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
            createEvent(22) as never,
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

        expect(handleOcrCancel(firstEvent as never, 'job-1')).toEqual({ canceled: true });
        await expect(firstPromise).resolves.toMatchObject({
            started: false,
            error: 'OCR job was cancelled before it started',
        });

        resolvePreparation();
    });

    it('aborts preparing jobs on cancel and frees the slot for a later job', async () => {
        const firstEvent = createEvent(33);

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
            firstEvent as never,
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
        expect(handleOcrCancel(firstEvent as never, 'job-3')).toEqual({ canceled: true });
        await expect(firstPromise).resolves.toMatchObject({
            started: false,
            error: 'OCR job was cancelled before it started',
        });
        expect(firstSignal.aborted).toBe(true);

        const secondResult = await handleOcrCreateSearchablePdfAsync(
            createEvent(44) as never,
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
            createEvent(55) as never,
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
        vi.useRealTimers();
    });

    it('ignores progress and completion messages emitted after active cancellation', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const event = createEvent(66);
        const result = await handleOcrCreateSearchablePdfAsync(
            event as never,
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

        expect(handleOcrCancel(event as never, 'job-6')).toEqual({ canceled: true });

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

    it('still forwards completion from the current active worker', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const { handleOcrCreateSearchablePdfAsync } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createEvent(77) as never,
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

    it('removes a successful result file when canceled before worker cleanup completes', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCancel,
            handleOcrCreateSearchablePdfAsync,
        } = await import('@electron/ocr/jobManager');

        const event = createEvent(78);
        const result = await handleOcrCreateSearchablePdfAsync(
            event as never,
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

        expect(handleOcrCancel(event as never, 'job-78')).toEqual({ canceled: true });
        expect(mocks.unlink).toHaveBeenCalledWith('/tmp/work-78-ocr.pdf');
    });

    it('sends renderer request ids when canceling active jobs during shutdown', async () => {
        mocks.ensureTessdataLanguages.mockResolvedValueOnce(undefined);

        const {
            handleOcrCreateSearchablePdfAsync,
            shutdownOcrJobManager,
        } = await import('@electron/ocr/jobManager');

        const result = await handleOcrCreateSearchablePdfAsync(
            createEvent(88) as never,
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

        const firstEvent = createEvent(99);
        const firstResult = await handleOcrCreateSearchablePdfAsync(
            firstEvent as never,
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

        expect(handleOcrCancel(firstEvent as never, 'job-99')).toEqual({ canceled: true });
        await vi.waitFor(() => {
            expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('OCR resource request cancelled for job 99:job-99'));
        });

        const secondResult = await handleOcrCreateSearchablePdfAsync(
            createEvent(100) as never,
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
