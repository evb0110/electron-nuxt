import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { effectScope } from 'vue';
import { retry } from 'es-toolkit/function';
import { withTimeout } from 'es-toolkit/promise';

const loadOcrTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const extractPdfTextMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>(async () => null));
const createDocxFromTextMock = vi.hoisted(() => vi.fn(() => new Uint8Array([
    7,
    8,
    9,
])));
const toastAddMock = vi.hoisted(() => vi.fn());
const mockOcr = {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    createSearchablePdf: vi.fn(),
    cancel: vi.fn(),
    getLanguages: vi.fn(),
    acknowledgeResultFile: vi.fn(),
};
const mockDocuments = {
    saveDocxAs: vi.fn(),
    writeDocxFile: vi.fn(),
    cleanupFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
};
const mockElectronAPI = {
    ocr: mockOcr,
    documents: mockDocuments,
};

vi.mock('@app/utils/getOcrCapability', () => ({ getOcrCapability: () => mockElectronAPI.ocr }));
vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => mockElectronAPI.documents }));
vi.mock('@app/utils/ocr/loadOcrText', () => ({ loadOcrText: loadOcrTextMock }));
vi.mock('@app/utils/ocr/extractPdfText', () => ({ extractPdfText: extractPdfTextMock }));
vi.mock('@app/utils/docx', () => ({createDocxFromText: createDocxFromTextMock}));
vi.stubGlobal('useToast', () => ({ add: toastAddMock }));

vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
});

const { useOcr } = await import('@app/composables/useOcr');

async function waitForCondition(
    condition: () => boolean,
    timeoutMs = 500,
) {
    const intervalMs = 5;
    try {
        await retry(async () => {
            if (!condition()) {
                throw new Error('Condition not met');
            }
        }, {
            retries: Math.max(0, Math.ceil(timeoutMs / intervalMs) - 1),
            delay: intervalMs,
        });
    } catch {
        throw new Error('Timed out waiting for condition');
    }
}

describe('useOcr', () => {
    beforeEach(() => {
        vi.useRealTimers();
        vi.stubGlobal('useToast', () => ({ add: toastAddMock }));
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        vi.clearAllMocks();
        mockOcr.onProgress.mockReturnValue(vi.fn());
        mockOcr.onComplete.mockReturnValue(vi.fn());
        mockOcr.createSearchablePdf.mockResolvedValue({
            started: true,
            jobId: 'job-1',
        });
        mockOcr.cancel.mockResolvedValue({ canceled: true });
    });

    it('settles runOcr when canceled before completion', async () => {
        const progressUnsubscribe = vi.fn();
        const completeUnsubscribe = vi.fn();
        mockOcr.onProgress.mockReturnValue(progressUnsubscribe);
        mockOcr.onComplete.mockReturnValue(completeUnsubscribe);

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            void ocr.cancelOcr();

            const settled = await withTimeout(
                () => runPromise.then(() => 'resolved' as const),
                100,
            ).catch((error: unknown) => {
                if (error instanceof Error && error.name === 'TimeoutError') {
                    return 'timeout' as const;
                }
                throw error;
            });

            expect(settled).toBe('resolved');
            expect(mockOcr.cancel).toHaveBeenCalledTimes(1);
            expect(progressUnsubscribe).toHaveBeenCalledTimes(1);
            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
            expect(ocr.progress.value.isRunning).toBe(false);
            expect(ocr.error.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('acknowledges late canceled OCR results that require cleanup', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const completeUnsubscribe = vi.fn();
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return completeUnsubscribe;
        });
        mockOcr.cancel.mockResolvedValueOnce({
            canceled: false,
            reason: 'not-found',
        });
        mockOcr.acknowledgeResultFile.mockResolvedValueOnce({ cleaned: true });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const cancelResult = await ocr.cancelOcr();

            expect(cancelResult).toMatchObject({
                canceled: false,
                reason: 'not-found',
            });
            expect(completeUnsubscribe).not.toHaveBeenCalled();

            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: true,
                pdfPath: '/tmp/late-ocr-result.pdf',
                requiresCleanupAck: true,
                errors: [],
            });

            await waitForCondition(() => mockOcr.acknowledgeResultFile.mock.calls.length > 0);
            await runPromise;

            expect(mockOcr.acknowledgeResultFile).toHaveBeenCalledWith(requestId, '/tmp/late-ocr-result.pdf');
            expect(completeUnsubscribe).toHaveBeenCalledTimes(1);
            expect(ocr.results.value.searchablePdfResult).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('clears previous searchable PDF results when a later OCR run fails', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const emitComplete = (result: IOcrCompleteTestResult) => {
            const handler = completeHandler;
            if (!handler) {
                throw new Error('OCR completion handler was not registered');
            }
            handler(result);
        };
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const firstRunPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const firstRequestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            emitComplete({
                requestId: firstRequestId,
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                requiresCleanupAck: true,
                errors: [],
            });
            await firstRunPromise;
            expect(ocr.hasResults.value).toBe(true);
            expect(ocr.results.value.searchablePdfResult).toEqual({
                requestId: firstRequestId,
                pdfPath: '/tmp/ocr-result.pdf',
                requiresCleanupAck: true,
            });
            expect(mockOcr.acknowledgeResultFile).not.toHaveBeenCalled();

            const secondRunPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');
            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 1);
            expect(ocr.hasResults.value).toBe(false);
            const secondRequestId = mockOcr.createSearchablePdf.mock.calls[1]?.[2] as string;
            emitComplete({
                requestId: secondRequestId,
                success: false,
                errors: ['OCR job idle timed out after 15000ms without worker activity'],
            });
            await secondRunPromise;

            expect(ocr.hasResults.value).toBe(false);
            expect(ocr.error.value).toContain('OCR job idle timed out');
        } finally {
            scope.stop();
        }
    });

    it('freezes run languages for backend dispatch and result metadata', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        const emitComplete = (result: IOcrCompleteTestResult) => {
            const handler = completeHandler;
            if (!handler) {
                throw new Error('OCR completion handler was not registered');
            }
            handler(result);
        };
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: ['eng'],
            };
            const runPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            expect(ocr.activeRunSettings.value?.selectedLanguages).toEqual(['eng']);

            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: ['rus'],
            };

            const call = mockOcr.createSearchablePdf.mock.calls[0] ?? [];
            const pageRequests = call[1];
            const requestId = call[2];
            const options = call[3];
            expect(pageRequests).toEqual([{
                pageNumber: 1,
                languages: ['eng'],
            }]);
            expect(options).toEqual({
                qualityProfile: 'balanced',
                preprocessingMode: 'off',
            });
            emitComplete({
                requestId: requestId as string,
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                requiresCleanupAck: true,
                errors: [],
            });
            await runPromise;

            expect(ocr.results.value.languages).toEqual(['eng']);
            expect(ocr.lastCompletedRunSettings.value?.selectedLanguages).toEqual(['eng']);
            expect(ocr.lastCompletedRunSettings.value?.qualityProfile).toBe('balanced');
            expect(ocr.activeRunSettings.value).toBeNull();
        } finally {
            scope.stop();
        }
    });

    it('passes poor scan OCR profile as clean searchable PDF options', async () => {
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        mockOcr.onComplete.mockImplementation((handler) => {
            queueMicrotask(() => handler({
                requestId: 'ocr-00000000-0000-4000-8000-000000000001',
                success: true,
                pdfPath: '/tmp/ocr-result.pdf',
                requiresCleanupAck: true,
                errors: [],
            }));
            return vi.fn();
        });
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                qualityProfile: 'poor-scan',
            };

            await ocr.runOcr(1, 1, '/tmp/work.pdf');

            expect(mockOcr.createSearchablePdf.mock.calls[0]?.[3]).toEqual({
                qualityProfile: 'poor-scan',
                preprocessingMode: 'clean',
            });
        } finally {
            scope.stop();
            vi.unstubAllGlobals();
        }
    });

    it('rejects runs with no selected languages before dispatching to the backend', async () => {
        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            ocr.settings.value = {
                ...ocr.settings.value,
                selectedLanguages: [],
            };

            await ocr.runOcr(1, 1, '/tmp/work.pdf');

            expect(mockOcr.createSearchablePdf).not.toHaveBeenCalled();
            expect(ocr.error.value).toBe('errors.ocr.noLanguages');
            expect(ocr.progress.value.isRunning).toBe(false);
        } finally {
            scope.stop();
        }
    });

    it('cancels the active backend job when OCR times out', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('crypto', { randomUUID: () => '00000000-0000-4000-8000-000000000001' });
        mockOcr.onComplete.mockReturnValue(vi.fn());

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');

            await vi.waitFor(() => {
                expect(mockOcr.createSearchablePdf).toHaveBeenCalledTimes(1);
            });
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;

            await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
            await runPromise;

            expect(mockOcr.cancel).toHaveBeenCalledWith(requestId);
            expect(ocr.progress.value.isRunning).toBe(false);
            expect(ocr.error.value).not.toBeNull();
        } finally {
            scope.stop();
            vi.useRealTimers();
        }
    });

    it('preserves searchable PDF start envelopes as start failures', async () => {
        mockOcr.createSearchablePdf.mockResolvedValueOnce({
            started: false,
            jobId: 'job-start-failure',
            error: 'fallback start failure',
            errorEnvelope: {
                code: 'OCR_QUEUE_BACKPRESSURE',
                message: 'OCR queue is full',
                retryable: true,
                timestamp: 123,
            },
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            await ocr.runOcr(1, 1, '/tmp/work.pdf');

            expect(ocr.error.value).toBe('errors.ocr.start: OCR queue is full');
        } finally {
            scope.stop();
        }
    });

    it('prefers terminal completion envelopes over plain OCR error strings', async () => {
        interface IOcrCompleteTestResult {
            requestId: string;
            success: boolean;
            pdfPath?: string;
            requiresCleanupAck?: boolean;
            errors: string[];
            errorEnvelope?: {
                code: 'OCR_WORKER_UNAVAILABLE';
                message: string;
                retryable: boolean;
                timestamp: number;
            };
        }
        let completeHandler: ((result: IOcrCompleteTestResult) => void) | null = null;
        mockOcr.onComplete.mockImplementation((handler) => {
            completeHandler = handler;
            return vi.fn();
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            const runPromise = ocr.runOcr(1, 1, '/tmp/work.pdf');

            await waitForCondition(() => mockOcr.createSearchablePdf.mock.calls.length > 0);
            const requestId = mockOcr.createSearchablePdf.mock.calls[0]?.[2] as string;
            const registeredCompleteHandler = mockOcr.onComplete.mock.calls[0]?.[0] ?? completeHandler;
            if (!registeredCompleteHandler) {
                throw new Error('OCR completion handler was not registered');
            }
            registeredCompleteHandler({
                requestId,
                success: false,
                errors: ['low-level worker detail'],
                errorEnvelope: {
                    code: 'OCR_WORKER_UNAVAILABLE',
                    message: 'OCR worker unavailable',
                    retryable: true,
                    timestamp: 123,
                },
            });
            await runPromise;

            expect(ocr.error.value).toBe('errors.ocr.createSearchablePdf: OCR worker unavailable');
        } finally {
            scope.stop();
        }
    });

    it('opens the DOCX save dialog before gathering text for export', async () => {
        const callOrder: string[] = [];
        mockDocuments.saveDocxAs.mockImplementationOnce(async () => {
            callOrder.push('saveDocxAs');
            return '/tmp/export.docx';
        });
        mockDocuments.writeDocxFile.mockResolvedValueOnce(undefined);
        mockDocuments.cleanupFile.mockResolvedValueOnce(undefined);
        loadOcrTextMock.mockImplementationOnce(async () => {
            callOrder.push('loadOcrText');
            return null;
        });
        extractPdfTextMock.mockImplementationOnce(async () => {
            callOrder.push('extractPdfText');
            return 'pdf text';
        });

        const scope = effectScope();
        const ocr = scope.run(() => useOcr());
        if (!ocr) {
            throw new Error('Failed to create OCR composable scope');
        }

        try {
            await expect(ocr.exportDocx('/tmp/work.pdf', {} as never)).resolves.toBe(true);

            expect(callOrder).toEqual([
                'saveDocxAs',
                'loadOcrText',
                'extractPdfText',
            ]);
            expect(createDocxFromTextMock).toHaveBeenCalledWith('pdf text', false);
            expect(mockDocuments.writeDocxFile).toHaveBeenCalledWith(
                '/tmp/export.docx',
                new Uint8Array([
                    7,
                    8,
                    9,
                ]),
            );
            expect(mockDocuments.cleanupFile).not.toHaveBeenCalled();
            expect(toastAddMock).toHaveBeenCalledWith(expect.objectContaining({
                color: 'success',
                title: expect.any(String),
                description: expect.any(String),
            }));
        } finally {
            scope.stop();
        }
    });
});
