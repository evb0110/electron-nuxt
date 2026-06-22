import type { TRegisteredHandler } from '@tests/unit/electron/helpers/ipcRegistryHarness';
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
vi.mock('@electron/ocr/runOcr', () => ({runOcr: mocks.runOcr}));

vi.mock('@electron/ocr/paths', () => ({
    validateOcrTools: mocks.validateOcrTools,
    getOcrToolPaths: mocks.getOcrToolPaths,
}));

vi.mock('@electron/utils/createLogger', () => ({createLogger: () => ({
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
vi.mock('@electron/file-access/workingCopyCreation', () => ({requireManagedWorkingCopyPath: (path: string) => mocks.requireManagedWorkingCopyPath(path)}));

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

const { registerOcrHandlers } = await import('@electron/features/ocr/main/registerOcrHandlers');

function createMockSender(id: number) {
    return {
        id,
        isDestroyed: vi.fn(() => false),
        once: vi.fn(),
        on: vi.fn(),
        removeListener: vi.fn(),
    };
}

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
            {sender: createMockSender(10)},
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
            {sender: createMockSender(11)},
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
            {sender: createMockSender(12)},
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
            {sender: createMockSender(13)},
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

    it('normalizes searchable PDF OCR options before queuing the worker job', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(16)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-options',
            {
                renderDpi: 299.6,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 11,
            },
        ) as { started: boolean };

        expect(result.started).toBe(true);
        expect(mocks.handleOcrCreateSearchablePdfAsync).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-options',
            {
                renderDpi: 300,
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
                pageSegmentationMode: 11,
            },
        );
    });

    it('preserves legacy numeric render DPI for searchable PDF jobs', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        await handler(
            {sender: createMockSender(17)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-legacy-dpi',
            240,
        );

        expect(mocks.handleOcrCreateSearchablePdfAsync).toHaveBeenCalledWith(
            expect.anything(),
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-legacy-dpi',
            { renderDpi: 240 },
        );
    });

    it('rejects invalid searchable PDF OCR options before queuing the worker job', async () => {
        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(18)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-invalid-options',
            { pageSegmentationMode: 99 },
        ) as {
            started: boolean;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result.started).toBe(false);
        expect(result.error).toContain('pageSegmentationMode');
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INVALID_PAYLOAD',
            retryable: false,
        });
        expect(mocks.handleOcrCreateSearchablePdfAsync).not.toHaveBeenCalled();
    });

    it('rejects disallowed sourcePdfPath before queuing OCR worker job', async () => {
        mocks.requireManagedWorkingCopyPath.mockRejectedValue(new Error('sourcePdfPath is not a managed working copy'));

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(14)},
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

    it('does not expose stack details in generic searchable PDF failures', async () => {
        mocks.handleOcrCreateSearchablePdfAsync.mockRejectedValue(new Error('worker exploded with a private stack'));

        const handler = getHandler('ocr:createSearchablePdf');
        const result = await handler(
            {sender: createMockSender(19)},
            '/tmp/working-copy.pdf',
            [{
                pageNumber: 1,
                languages: ['eng'],
            }],
            'job-generic-failure',
        ) as {
            started: boolean;
            errorEnvelope?: {
                code: string;
                message: string;
                details?: string;
            };
        };

        expect(result.started).toBe(false);
        expect(result.errorEnvelope).toMatchObject({
            code: 'OCR_INTERNAL_ERROR',
            message: 'worker exploded with a private stack',
        });
        expect(result.errorEnvelope).not.toHaveProperty('details');
    });

    it('returns typed invalid-request details for malformed OCR cancel payloads', async () => {
        const handler = getHandler('ocr:cancel');

        const result = await handler(
            {sender: createMockSender(20)},
            '',
        ) as {
            canceled: boolean;
            reason?: string;
            error?: string;
            errorEnvelope?: {
                code: string;
                retryable: boolean;
            };
        };

        expect(result).toMatchObject({
            canceled: false,
            reason: 'invalid-request',
            errorEnvelope: {
                code: 'OCR_INVALID_PAYLOAD',
                retryable: false,
            },
        });
        expect(result.error).toContain('requestId');
        expect(mocks.handleOcrCancel).not.toHaveBeenCalled();
    });

    it('passes a renderer-lifetime abort signal into synchronous batch OCR', async () => {
        const handler = getHandler('ocr:recognizeBatch');
        mocks.runOcr.mockResolvedValue({
            success: true,
            text: 'done',
        });
        const sender = createMockSender(15);

        const result = await handler(
            {sender},
            [{
                pageNumber: 1,
                imageData: new Uint8Array([1]),
                languages: ['eng'],
            }],
            'batch-with-signal',
        ) as {
            results: Record<number, string>;
            errors: string[];
        };

        expect(result).toEqual({
            results: {1: 'done'},
            errors: [],
        });
        expect(sender.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.once).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(sender.on).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
        expect(mocks.runOcr).toHaveBeenCalledWith(
            Buffer.from([1]),
            ['eng'],
            expect.objectContaining({
                signal: expect.any(AbortSignal),
                threads: 1,
            }),
        );
        expect(sender.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
        expect(sender.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
        expect(sender.removeListener).toHaveBeenCalledWith('did-start-navigation', expect.any(Function));
    });
});
