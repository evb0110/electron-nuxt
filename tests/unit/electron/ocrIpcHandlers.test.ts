import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

type TRegisteredHandler = (...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
    handlers: new Map<string, TRegisteredHandler>(),
    ipcHandle: vi.fn<(channel: string, handler: TRegisteredHandler) => void>(),
    runOcr: vi.fn(),
    handleOcrCreateSearchablePdfAsync: vi.fn(),
    handleOcrCancel: vi.fn(),
    handleOcrAcknowledgeResultFile: vi.fn(),
    safeSendToWindow: vi.fn(),
    validateOcrTools: vi.fn(),
    getOcrToolPaths: vi.fn(),
    handlePreprocessingValidate: vi.fn(),
    handlePreprocessPage: vi.fn(),
    forEachConcurrent: vi.fn(),
    getOcrConcurrency: vi.fn(),
    getTesseractThreadLimit: vi.fn(),
    getSequentialProgressPage: vi.fn(),
    resolveAllowedReadPath: vi.fn<(path: string) => Promise<string | null>>(),
    requireManagedWorkingCopyPath: vi.fn<(path: string) => Promise<string>>(),
}));

vi.mock('electron', () => ({
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
    ipcMain: { handle: (channel: string, handler: TRegisteredHandler) => {
        mocks.ipcHandle(channel, handler);
        mocks.handlers.set(channel, handler);
    } },
}));
vi.mock('@electron/ocr/tesseract', () => ({runOcr: mocks.runOcr}));

vi.mock('@electron/ocr/paths', () => ({
    validateOcrTools: mocks.validateOcrTools,
    getOcrToolPaths: mocks.getOcrToolPaths,
}));

vi.mock('@electron/utils/logger', () => ({createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
})}));

vi.mock('@electron/utils/concurrency', () => ({
    forEachConcurrent: mocks.forEachConcurrent,
    getOcrConcurrency: mocks.getOcrConcurrency,
    getTesseractThreadLimit: mocks.getTesseractThreadLimit,
    getSequentialProgressPage: mocks.getSequentialProgressPage,
}));
vi.mock('@electron/utils/pathValidator', () => ({resolveAllowedReadPath: mocks.resolveAllowedReadPath}));
vi.mock('@electron/ipc/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: string) => mocks.requireManagedWorkingCopyPath(path)}));

vi.mock('@electron/ocr/jobManager', () => ({
    handleOcrCreateSearchablePdfAsync: mocks.handleOcrCreateSearchablePdfAsync,
    handleOcrCancel: mocks.handleOcrCancel,
    handleOcrAcknowledgeResultFile: mocks.handleOcrAcknowledgeResultFile,
    safeSendToWindow: mocks.safeSendToWindow,
}));

vi.mock('@electron/ocr/preprocessingHandlers', () => ({
    handlePreprocessingValidate: mocks.handlePreprocessingValidate,
    handlePreprocessPage: mocks.handlePreprocessPage,
}));

const { registerOcrHandlers } = await import('@electron/features/ocr/main/ipc');

function getHandler(channel: string) {
    const handler = mocks.handlers.get(channel);
    if (!handler) {
        throw new Error(`IPC handler is not registered for channel "${channel}"`);
    }
    return handler;
}

describe('registerOcrHandlers', () => {
    beforeEach(() => {
        mocks.handlers.clear();
        vi.clearAllMocks();
        mocks.resolveAllowedReadPath.mockResolvedValue('/tmp/working-copy.pdf');
        mocks.requireManagedWorkingCopyPath.mockImplementation(async (path: string) => path);

        mocks.getOcrToolPaths.mockReturnValue({
            tesseract: '/mock/tesseract',
            tessdata: '/mock/tessdata',
            pdftoppm: '/mock/pdftoppm',
            pdftotext: '/mock/pdftotext',
            popplerDataDir: '/mock/poppler/share',
            popplerFontConfigDir: '/mock/poppler/fonts',
            qpdf: '/mock/qpdf',
        });

        mocks.getOcrConcurrency.mockReturnValue(1);
        mocks.getTesseractThreadLimit.mockReturnValue(1);
        mocks.getSequentialProgressPage.mockImplementation((pages: Array<{ pageNumber: number }>, processedCount: number) =>
            pages[Math.max(0, processedCount - 1)]?.pageNumber ?? 0);
        mocks.forEachConcurrent.mockImplementation(async (
            pages: unknown[],
            _concurrency: number,
            worker: (page: unknown) => Promise<void>,
        ) => {
            for (const page of pages) {
                await worker(page);
            }
        });

        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: true,
            jobId: 'default-job-id',
        });
        mocks.handleOcrCancel.mockReturnValue({ canceled: true });
        mocks.handleOcrAcknowledgeResultFile.mockResolvedValue({ cleaned: true });
        registerOcrHandlers();
    });

    it('rejects malformed OCR batch payloads with stable typed envelope', async () => {
        const handler = getHandler('ocr:recognizeBatch');

        const result = await handler(
            {sender: {id: 10}},
            [{
                pageNumber: 1,
                imageData: 'not-bytes',
                languages: ['eng'],
            }],
            'batch-1',
        ) as {
            results: Record<number, string>;
            errors: string[];
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.results).toEqual({});
        expect(result.errors[0]).toContain('imageData must be a Uint8Array');
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INVALID_PAYLOAD',
            retryable: false,
        });
        expect(mocks.runOcr).not.toHaveBeenCalled();
    });

    it('returns typed worker-unavailable envelope for missing OCR worker path', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-worker-missing',
            error: 'OCR worker unavailable at path: /tmp/missing-ocr-worker.js',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: {id: 11}},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-worker-missing',
        ) as {
            started: boolean;
            jobId: string;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result).toMatchObject({
            started: false,
            jobId: 'job-worker-missing',
            error: 'OCR worker unavailable at path: /tmp/missing-ocr-worker.js',
            errorEnvelope: {
                code: 'OCR_WORKER_UNAVAILABLE',
                retryable: true,
            },
        });
    });

    it('marks timeout start failures as typed retriable errors', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-timeout',
            error: 'qpdf timed out after 5000ms',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: {id: 12}},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-timeout',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INTERNAL_ERROR',
            retryable: true,
        });
    });

    it('maps queue saturation to controlled backpressure rejection', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockResolvedValue({
            started: false,
            jobId: 'job-queue-full',
            error: 'OCR queue is full (8 jobs)',
        });

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: {id: 13}},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-queue-full',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_QUEUE_BACKPRESSURE',
            retryable: true,
        });
    });

    it('rejects disallowed sourcePdfPath before queuing OCR worker job', async () => {
        mocks.requireManagedWorkingCopyPath.mockRejectedValue(new Error('sourcePdfPath is not a managed working copy'));

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: {id: 14}},
            '/tmp/outside.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-invalid-working-copy-path',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
            error?: string;
        };

        expect(result.started).toBe(false);
        expect(result.error).toContain('sourcePdfPath');
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INVALID_PAYLOAD',
            retryable: false,
        });
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });
});
