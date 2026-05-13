import {
    describe,
    expect,
    it,
    vi,
    beforeEach,
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
    readFile: vi.fn(),
    cleanupOcrTemp: vi.fn(),
};
const mockElectronAPI = {
    ocr: mockOcr,
    documents: mockDocuments,
};

vi.mock('@app/utils/platformOcr', () => ({ getOcrCapability: () => mockElectronAPI.ocr }));
vi.mock('@app/utils/platformDocuments', () => ({ getDocumentsCapability: () => mockElectronAPI.documents }));
vi.mock('@app/utils/ocr/processing', () => ({
    loadOcrText: loadOcrTextMock,
    extractPdfText: extractPdfTextMock,
}));
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
            ocr.cancelOcr();

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
        mockDocuments.readFile.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mockOcr.acknowledgeResultFile.mockResolvedValue({ cleaned: true });

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
            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/export.docx');
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
