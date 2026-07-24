import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {
    ICombinePdfProgress ,
    CombinePdfError,
} from '@app/services/pdf/combinePdfFiles';
import {combinePdfFiles} from '@app/services/pdf/combinePdfFiles';

interface IMenuProgress {
    operation: 'document-open';
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

const mocks = vi.hoisted(() => {
    const progress = { handler: null as null | ((nextProgress: IMenuProgress) => void) };
    const stopProgress = vi.fn();
    const onOpenDocumentDirectBatchProgress = vi.fn((handler: (nextProgress: IMenuProgress) => void) => {
        progress.handler = handler;
        return stopProgress;
    });

    return {
        progress,
        stopProgress,
        hasElectronAPI: vi.fn(() => true),
        documentPicker: {
            getPathsForFiles: vi.fn(),
            createCombinedPdfFromFiles: vi.fn(),
        },
        documentOpen: {
            openDocumentDirectBatch: vi.fn(),
            cancelOpenDocumentDirectBatch: vi.fn(async () => true),
            onOpenDocumentDirectBatchProgress,
        },
        documentWorkingCopy: { createWorkingCopyFromData: vi.fn() },
    };
});

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mocks.hasElectronAPI()}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentOpenCapability: () => mocks.documentOpen,
    getDocumentPickerCapability: () => mocks.documentPicker,
    getDocumentWorkingCopyCapability: () => mocks.documentWorkingCopy,
}));

function createFile(name: string) {
    return {
        name,
        size: 1,
    } as File;
}

describe('combinePdfFiles', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.stubGlobal('crypto', {randomUUID: () => 'combine-request-1'});
        mocks.progress.handler = null;
        mocks.hasElectronAPI.mockReturnValue(true);
        mocks.documentPicker.getPathsForFiles.mockReturnValue([]);
        mocks.documentOpen.openDocumentDirectBatch.mockResolvedValue({
            kind: 'pdf',
            originalPath: '/tmp/combined.pdf',
            workingPath: '/tmp/combined-working.pdf',
            isGenerated: true,
        });
        mocks.documentPicker.createCombinedPdfFromFiles.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.documentWorkingCopy.createWorkingCopyFromData.mockResolvedValue('browser://documents/working/combined.pdf');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses split picker and open capabilities for Electron combine batches', async () => {
        const firstFile = createFile('first.pdf');
        const secondFile = createFile('second.pdf');
        const onProgress = vi.fn<(progress: ICombinePdfProgress) => void>();
        mocks.documentPicker.getPathsForFiles.mockReturnValue([
            '/tmp/first.pdf',
            '/tmp/second.pdf',
        ]);
        mocks.documentOpen.openDocumentDirectBatch.mockImplementation(async (_paths: string[], requestId: string) => {
            mocks.progress.handler?.({
                operation: 'document-open',
                requestId,
                processed: 1,
                total: 2,
                percent: 50,
                elapsedMs: 25,
                estimatedRemainingMs: 25,
            });
            return {
                kind: 'pdf',
                originalPath: '/tmp/combined.pdf',
                workingPath: '/tmp/combined-working.pdf',
                isGenerated: true,
            };
        });

        const result = await combinePdfFiles({
            files: [
                {file: firstFile},
                {file: secondFile},
            ],
            outputName: 'combined.pdf',
            openErrorMessage: 'Could not open combined PDF',
            onProgress,
        });

        expect(result).toEqual({
            kind: 'pdf',
            originalPath: '/tmp/combined.pdf',
            workingPath: '/tmp/combined-working.pdf',
            isGenerated: true,
        });
        expect(mocks.documentPicker.getPathsForFiles).toHaveBeenCalledWith([
            firstFile,
            secondFile,
        ]);
        expect(mocks.documentOpen.openDocumentDirectBatch).toHaveBeenCalledWith([
            '/tmp/first.pdf',
            '/tmp/second.pdf',
        ], 'combine-request-1', {forceCombine: true});
        expect(mocks.documentOpen.onOpenDocumentDirectBatchProgress).toHaveBeenCalledOnce();
        expect(mocks.stopProgress).toHaveBeenCalledOnce();
        expect(onProgress).toHaveBeenNthCalledWith(1, {
            processed: 1,
            total: 2,
            percent: 50,
            elapsedMs: 25,
            estimatedRemainingMs: 25,
        });
        expect(onProgress).toHaveBeenNthCalledWith(2, {
            processed: 2,
            total: 2,
            percent: 100,
            elapsedMs: 25,
            estimatedRemainingMs: null,
        });
    });

    it('creates browser generated output through the split working-copy capability', async () => {
        mocks.hasElectronAPI.mockReturnValue(false);
        const firstFile = createFile('first.pdf');
        const secondFile = createFile('second.png');
        const combinedBytes = new Uint8Array([
            4,
            5,
            6,
        ]);
        mocks.documentPicker.createCombinedPdfFromFiles.mockImplementation(async (
            _files: File[],
            options: { onProgress?: (progress: ICombinePdfProgress) => void },
        ) => {
            options.onProgress?.({
                processed: 1,
                total: 2,
                percent: 50,
                elapsedMs: 10,
                estimatedRemainingMs: 10,
            });
            return combinedBytes;
        });

        const result = await combinePdfFiles({
            files: [
                {file: firstFile},
                {file: secondFile},
            ],
            outputName: 'combined.pdf',
            openErrorMessage: 'Could not open combined PDF',
        });

        expect(result).toEqual({
            kind: 'pdf',
            workingPath: 'browser://documents/working/combined.pdf',
            originalPath: 'browser://documents/working/combined.pdf',
            isGenerated: true,
        });
        expect(mocks.documentPicker.createCombinedPdfFromFiles).toHaveBeenCalledWith([
            firstFile,
            secondFile,
        ], {onProgress: expect.any(Function)});
        expect(mocks.documentWorkingCopy.createWorkingCopyFromData).toHaveBeenCalledWith(
            'combined.pdf',
            combinedBytes,
        );
    });

    it('keeps fallback progress monotonic and reserves 100 percent for completion', async () => {
        const onProgress = vi.fn<(progress: ICombinePdfProgress) => void>();
        mocks.documentPicker.getPathsForFiles.mockReturnValue(['/tmp/first.pdf']);
        mocks.documentOpen.openDocumentDirectBatch.mockImplementation(async (_paths: string[], requestId: string) => {
            for (const percent of [
                80,
                20,
                100,
            ]) {
                mocks.progress.handler?.({
                    operation: 'document-open',
                    requestId,
                    processed: 1,
                    total: 1,
                    percent,
                    elapsedMs: percent,
                    estimatedRemainingMs: null,
                });
            }
            return {
                kind: 'pdf',
                originalPath: '/tmp/combined.pdf',
                workingPath: '/tmp/combined-working.pdf',
                isGenerated: true,
            };
        });

        await combinePdfFiles({
            files: [{file: createFile('first.pdf')}],
            outputName: 'combined.pdf',
            openErrorMessage: 'open failed',
            onProgress,
        });

        expect(onProgress.mock.calls.map(([progress]) => progress.percent)).toEqual([
            80,
            80,
            95,
            100,
        ]);
    });

    it('routes renderer cancellation to the active Electron combine request', async () => {
        const controller = new AbortController();
        mocks.documentPicker.getPathsForFiles.mockReturnValue(['/tmp/first.pdf']);
        let rejectOpen: ((error: Error) => void) | null = null;
        mocks.documentOpen.openDocumentDirectBatch.mockImplementation(() => new Promise((_resolve, reject) => {
            rejectOpen = reject;
        }));
        mocks.documentOpen.cancelOpenDocumentDirectBatch.mockImplementation(async () => {
            rejectOpen?.(new DOMException('Canceled', 'AbortError'));
            return true;
        });
        const pending = combinePdfFiles({
            files: [{file: createFile('first.pdf')}],
            outputName: 'combined.pdf',
            openErrorMessage: 'open failed',
            signal: controller.signal,
        });
        await Promise.resolve();

        controller.abort(new DOMException('Canceled', 'AbortError'));

        await expect(pending).rejects.toMatchObject({code: 'canceled'});
        expect(mocks.documentOpen.cancelOpenDocumentDirectBatch).toHaveBeenCalledWith('combine-request-1');
    });

    it('rejects oversized browser inputs with a structured limit code before starting work', async () => {
        mocks.hasElectronAPI.mockReturnValue(false);
        const oversized = {
            name: 'huge.png',
            size: (32 * 1024 * 1024) + 1,
        } as File;

        await expect(combinePdfFiles({
            files: [{file: oversized}],
            outputName: 'combined.pdf',
            openErrorMessage: 'open failed',
        })).rejects.toEqual(expect.objectContaining<Partial<CombinePdfError>>({code: 'limit'}));
        expect(mocks.documentPicker.createCombinedPdfFromFiles).not.toHaveBeenCalled();
    });
});
