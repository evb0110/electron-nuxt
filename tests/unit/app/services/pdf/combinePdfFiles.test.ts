import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { ICombinePdfProgress } from '@app/services/pdf/combinePdfFiles';
import { combinePdfFiles } from '@app/services/pdf/combinePdfFiles';

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
        documentPicker: { getPathsForFiles: vi.fn() },
        documentOpen: { openDocumentDirectBatch: vi.fn() },
        documentMenu: { onOpenDocumentDirectBatchProgress },
        documentWorkingCopy: { createWorkingCopyFromData: vi.fn() },
        legacyDocuments: {
            getPathsForFiles: vi.fn(() => {
                throw new Error('legacy combine path extraction should not be used');
            }),
            openDocumentDirectBatch: vi.fn(() => {
                throw new Error('legacy combine direct batch open should not be used');
            }),
            createWorkingCopyFromData: vi.fn(() => {
                throw new Error('legacy combine working copy creation should not be used');
            }),
        },
        browserDocumentStore: {
            registerFile: vi.fn(),
            remove: vi.fn(),
        },
        createCombinedPdfFromPaths: vi.fn(),
    };
});

vi.mock('@app/utils/platform', () => ({hasElectronAPI: () => mocks.hasElectronAPI()}));
vi.mock('@app/utils/platformDocuments', () => ({
    getDocumentMenuCapability: () => mocks.documentMenu,
    getDocumentOpenCapability: () => mocks.documentOpen,
    getDocumentPickerCapability: () => mocks.documentPicker,
    getDocumentWorkingCopyCapability: () => mocks.documentWorkingCopy,
    getDocumentsCapability: () => mocks.legacyDocuments,
}));
vi.mock('@app/platform/browserDocumentStore', () => ({browserDocumentStore: mocks.browserDocumentStore}));
vi.mock('@app/platform/browser-api/public', () => ({createCombinedPdfFromPaths: mocks.createCombinedPdfFromPaths}));

function createFile(name: string) {
    return { name } as File;
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
        mocks.browserDocumentStore.registerFile.mockResolvedValue('browser://documents/source/input.pdf');
        mocks.browserDocumentStore.remove.mockResolvedValue(undefined);
        mocks.createCombinedPdfFromPaths.mockResolvedValue(new Uint8Array([
            1,
            2,
            3,
        ]));
        mocks.documentWorkingCopy.createWorkingCopyFromData.mockResolvedValue('browser://documents/working/combined.pdf');
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('uses split picker, open, and menu capabilities for Electron combine batches', async () => {
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
        ], 'combine-request-1');
        expect(mocks.documentMenu.onOpenDocumentDirectBatchProgress).toHaveBeenCalledOnce();
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
        expect(mocks.legacyDocuments.getPathsForFiles).not.toHaveBeenCalled();
        expect(mocks.legacyDocuments.openDocumentDirectBatch).not.toHaveBeenCalled();
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
        mocks.browserDocumentStore.registerFile
            .mockResolvedValueOnce('browser://documents/source/first.pdf')
            .mockResolvedValueOnce('browser://documents/source/second.png');
        mocks.createCombinedPdfFromPaths.mockImplementation(async (
            _refs: string[],
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
        expect(mocks.createCombinedPdfFromPaths).toHaveBeenCalledWith([
            'browser://documents/source/first.pdf',
            'browser://documents/source/second.png',
        ], {onProgress: expect.any(Function)});
        expect(mocks.documentWorkingCopy.createWorkingCopyFromData).toHaveBeenCalledWith(
            'combined.pdf',
            combinedBytes,
        );
        expect(mocks.browserDocumentStore.remove).toHaveBeenCalledWith('browser://documents/source/first.pdf');
        expect(mocks.browserDocumentStore.remove).toHaveBeenCalledWith('browser://documents/source/second.png');
        expect(mocks.legacyDocuments.createWorkingCopyFromData).not.toHaveBeenCalled();
    });
});
