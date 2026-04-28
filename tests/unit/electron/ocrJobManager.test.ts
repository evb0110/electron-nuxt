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

vi.mock('fs', () => ({existsSync: mocks.existsSync}));
vi.mock('fs/promises', () => ({
    stat: mocks.stat,
    unlink: mocks.unlink,
}));
vi.mock('@electron/ocr/language-models', () => ({ensureTessdataLanguages: mocks.ensureTessdataLanguages}));
vi.mock('@electron/ocr/paths', () => ({getOcrToolPaths: mocks.getOcrToolPaths}));
vi.mock('@electron/utils/logger', () => ({createLogger: () => mocks.logger}));

function createEvent(senderId: number) {
    return {sender: {
        id: senderId,
        isDestroyed: vi.fn(() => false),
        once: vi.fn(),
        removeListener: vi.fn(),
    }};
}

describe('ocr job manager preparing-stage robustness', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubEnv('EVB_OCR_QUEUE_MAX_SIZE', '1');
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

        await vi.advanceTimersByTimeAsync(1_001);
        expect(worker?.terminate).toHaveBeenCalledTimes(1);
        vi.useRealTimers();
    });
});
