import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';

const mockDocuments = {
    openPdfDialog: vi.fn(),
    openPdfDirect: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    saveFile: vi.fn(),
    savePdfAs: vi.fn(),
    statFile: vi.fn(),
    cleanupFile: vi.fn(),
    analyzePdfConformance: vi.fn(async () => ({
        isSigned: false,
        isEncrypted: false,
        isTagged: false,
        pdfaLevel: null,
        hasAcroForm: false,
        hasXfa: false,
        canIncrementalSave: true,
        saveRestrictions: [] as string[],
    })),
    validatePdfData: vi.fn(),
    onOpenPdfDirectBatchProgress: vi.fn(() => vi.fn()),
};
const mockElectronAPI = { documents: mockDocuments };
const mockHasElectronAPI = vi.fn(() => true);

vi.mock('@app/utils/platform', () => ({
    getElectronAPI: () => mockElectronAPI,
    hasElectronAPI: () => mockHasElectronAPI(),
}));

vi.mock('@app/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({clearCache: vi.fn()})}));

const mockT = vi.fn((key: string) => key);
vi.stubGlobal('useI18n', () => ({ t: mockT }));

vi.stubGlobal('window', {
    ...globalThis,
    electronAPI: mockElectronAPI,
});

const { usePdfFile } = await import('@app/composables/usePdfFile');

function deferred<T>() {
    let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
    const promise = new Promise<T>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return {
        promise,
        resolve: (value: T) => resolve?.(value),
    };
}

describe('usePdfFile', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockHasElectronAPI.mockReturnValue(true);
    });

    describe('initial state', () => {
        it('starts with null pdfSrc and pdfData', () => {
            const file = usePdfFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
        });

        it('starts with no working copy path', () => {
            const file = usePdfFile();

            expect(file.workingCopyPath.value).toBeNull();
            expect(file.fileName.value).toBeNull();
        });

        it('starts clean (not dirty)', () => {
            const file = usePdfFile();

            expect(file.isDirty.value).toBe(false);
        });

        it('starts with no undo/redo available', () => {
            const file = usePdfFile();

            expect(file.canUndo.value).toBe(false);
            expect(file.canRedo.value).toBe(false);
        });
    });

    describe('openFile', () => {
        it('sets pendingDjvu for DjVu files', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/docs/scan.djvu',
            });

            const file = usePdfFile();
            await file.openFile();

            expect(file.pendingDjvu.value).toBe('/docs/scan.djvu');
            expect(file.pdfData.value).toBeNull();
        });

        it('loads PDF data for PDF files', async () => {
            const pdfBytes = new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
            ]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/docs/report.pdf',
                workingPath: '/tmp/work/report.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            await file.openFile();

            expect(file.workingCopyPath.value).toBe('/tmp/work/report.pdf');
            expect(file.originalPath.value).toBe('/docs/report.pdf');
            expect(file.pdfData.value).toBeTruthy();
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
        });

        it('does nothing when dialog is cancelled', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue(null);

            const file = usePdfFile();
            await file.openFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.error.value).toBeNull();
        });

        it('sets error on failure', async () => {
            mockDocuments.openPdfDialog.mockRejectedValue(new Error('Access denied'));

            const file = usePdfFile();
            await file.openFile();

            expect(file.error.value).toBe('Access denied');
        });

        it('loads a browser-picked PDF when Electron is unavailable', async () => {
            const pdfBytes = new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
            ]);
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: 'browser://documents/source/browser-open.pdf',
                workingPath: 'browser://documents/working/browser-open.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            await file.openFile();

            expect(file.workingCopyPath.value).toBe('browser://documents/working/browser-open.pdf');
            expect(file.originalPath.value).toBe('browser://documents/source/browser-open.pdf');
            expect(file.fileName.value).toBe('browser-open.pdf');
            expect(file.isDirty.value).toBe(false);
            expect(file.pdfData.value).toEqual(pdfBytes);
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
            expect(mockDocuments.openPdfDialog).toHaveBeenCalledOnce();
        });

        it('decodes double-encoded browser PDF names for display', async () => {
            const pdfBytes = new Uint8Array([
                0x25,
                0x50,
                0x44,
                0x46,
            ]);
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: 'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.pdf',
                workingPath: 'browser://documents/working/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            await file.openFile();

            expect(file.fileName.value).toBe('Глава.pdf');
        });

        it('keeps browser DjVu opens in the shared pending flow', async () => {
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: 'browser://documents/source/browser-open.djvu',
            });

            const file = usePdfFile();
            await file.openFile();

            expect(file.pendingDjvu.value).toBe(
                'browser://documents/source/browser-open.djvu',
            );
            expect(file.error.value).toBeNull();
        });
    });

    describe('openFileDirect', () => {
        it('detects DjVu files from direct open', async () => {
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/path/doc.djvu',
            });

            const file = usePdfFile();
            await file.openFileDirect('/path/doc.djvu');

            expect(file.pendingDjvu.value).toBe('/path/doc.djvu');
        });

        it('keeps browser DjVu direct opens in the shared pending flow', async () => {
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: 'browser://documents/source/browser-open.djvu',
            });

            const file = usePdfFile();
            await file.openFileDirect(
                'browser://documents/source/browser-open.djvu',
            );

            expect(file.pendingDjvu.value).toBe(
                'browser://documents/source/browser-open.djvu',
            );
            expect(file.error.value).toBeNull();
        });

        it('sets error when result is null', async () => {
            mockDocuments.openPdfDirect.mockResolvedValue(null);

            const file = usePdfFile();
            await file.openFileDirect('/nonexistent.pdf');

            expect(file.error.value).toBe('errors.file.invalid');
        });
    });

    describe('loadPdfFromPath', () => {
        it('keeps the previous working copy when loading the next file fails', async () => {
            const oldPdf = new Uint8Array([
                1,
                2,
            ]);

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/old.pdf',
                workingPath: '/tmp/old.pdf',
            });
            mockDocuments.statFile.mockResolvedValueOnce({ size: oldPdf.length });
            mockDocuments.readFile.mockResolvedValueOnce(oldPdf.buffer);

            const file = usePdfFile();
            await file.openFile();

            mockDocuments.statFile.mockRejectedValueOnce(new Error('read failure'));
            await expect(file.loadPdfFromPath('/tmp/new.pdf')).rejects.toThrow('read failure');

            expect(file.workingCopyPath.value).toBe('/tmp/old.pdf');
            expect(mockDocuments.cleanupFile).not.toHaveBeenCalled();
        });

        it('ignores stale concurrent loads and only keeps the latest committed file', async () => {
            const oldPdf = new Uint8Array([1]);
            const firstPdf = new Uint8Array([2]);
            const secondPdf = new Uint8Array([3]);

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/old.pdf',
                workingPath: '/tmp/old.pdf',
            });
            mockDocuments.statFile.mockResolvedValueOnce({ size: oldPdf.length });
            mockDocuments.readFile.mockResolvedValueOnce(oldPdf.buffer);
            mockDocuments.cleanupFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();

            const firstReadGate = deferred<ArrayBuffer>();
            mockDocuments.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstPdf.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondPdf.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocuments.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return firstReadGate.promise;
                }
                if (path === '/tmp/second.pdf') {
                    return secondPdf.buffer;
                }
                throw new Error(`unexpected path ${path}`);
            });

            const firstLoad = file.loadPdfFromPath('/tmp/first.pdf');
            const secondLoad = file.loadPdfFromPath('/tmp/second.pdf');

            await expect(secondLoad).resolves.toBeUndefined();
            expect(file.workingCopyPath.value).toBe('/tmp/second.pdf');

            firstReadGate.resolve(firstPdf.buffer.slice(0));
            await expect(firstLoad).resolves.toBeUndefined();

            expect(file.workingCopyPath.value).toBe('/tmp/second.pdf');
            expect(file.pdfData.value).toEqual(secondPdf);
            expect(mockDocuments.cleanupFile).toHaveBeenCalledTimes(1);
            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/old.pdf');
        });
    });

    describe('closeFile', () => {
        it('resets all state', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
                3,
            ]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/test.pdf',
                workingPath: '/tmp/test.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 3 });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocuments.cleanupFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();

            expect(file.pdfSrc.value).not.toBeNull();

            await file.closeFile();

            expect(file.pdfSrc.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
            expect(file.workingCopyPath.value).toBeNull();
            expect(file.originalPath.value).toBeNull();
            expect(file.error.value).toBeNull();
            expect(file.isDirty.value).toBe(false);
        });

        it('calls cleanupFile for the working copy', async () => {
            const pdfBytes = new Uint8Array([1]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/a.pdf',
                workingPath: '/tmp/a.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 1 });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocuments.cleanupFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            await file.closeFile();

            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/a.pdf');
        });

        it('still cleans up the working copy when Electron API is unavailable', async () => {
            const pdfBytes = new Uint8Array([1]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/a.pdf',
                workingPath: '/tmp/a.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 1 });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockHasElectronAPI.mockReturnValue(false);

            const file = usePdfFile();
            await file.openFile();
            await file.closeFile();

            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/a.pdf');
        });
    });

    describe('undo/redo', () => {
        async function setupWithHistory() {
            const bytes1 = new Uint8Array([
                1,
                2,
            ]);
            const bytes2 = new Uint8Array([
                3,
                4,
            ]);

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo.pdf',
                workingPath: '/tmp/undo.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 2 });
            mockDocuments.readFile.mockResolvedValue(bytes1.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            await file.loadPdfFromData(bytes2);

            return file;
        }

        it('can undo after pushing a snapshot', async () => {
            const file = await setupWithHistory();

            expect(file.canUndo.value).toBe(true);

            const result = await file.undo();
            expect(result).toBe(true);
        });

        it('can redo after undo', async () => {
            const file = await setupWithHistory();

            await file.undo();
            expect(file.canRedo.value).toBe(true);

            const result = await file.redo();
            expect(result).toBe(true);
        });

        it('returns false when nothing to undo', async () => {
            const file = usePdfFile();

            const result = await file.undo();
            expect(result).toBe(false);
        });

        it('returns false when nothing to redo', async () => {
            const file = usePdfFile();

            const result = await file.redo();
            expect(result).toBe(false);
        });

        it('can reload the working copy into history for external page operations', async () => {
            const bytes1 = new Uint8Array([
                1,
                2,
            ]);
            const bytes2 = new Uint8Array([
                3,
                4,
            ]);

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo.pdf',
                workingPath: '/tmp/undo.pdf',
            });
            mockDocuments.statFile
                .mockResolvedValueOnce({ size: bytes1.length })
                .mockResolvedValueOnce({ size: bytes2.length });
            mockDocuments.readFile
                .mockResolvedValueOnce(bytes1.buffer)
                .mockResolvedValueOnce(bytes2.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();

            await expect(file.reloadWorkingCopyIntoHistory({ markDirty: true })).resolves.toBe(true);
            expect(file.canUndo.value).toBe(true);
            expect(file.isDirty.value).toBe(true);

            await expect(file.undo()).resolves.toBe(true);
            expect(file.pdfData.value).toEqual(bytes1);
        });
    });

    describe('markDirty', () => {
        it('marks the file as dirty', () => {
            const file = usePdfFile();

            file.markDirty();
            expect(file.isDirty.value).toBe(true);
        });
    });

    describe('saveFile', () => {
        it('returns a failed persist result when no working copy path', async () => {
            const file = usePdfFile();

            const result = await file.saveFile(new Uint8Array([1]));
            expect(result).toEqual({
                success: false,
                outPath: null,
                saveMode: 'rewrite',
                didSaveAs: false,
            });
        });

        it('saves, commits the persisted bytes, and clears dirty flag', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
            ]);
            const savedBytes = new Uint8Array([
                9,
                9,
            ]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/save.pdf',
                workingPath: '/tmp/save.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 2 });
            mockDocuments.readFile
                .mockResolvedValueOnce(pdfBytes.buffer)
                .mockResolvedValueOnce(savedBytes.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);
            mockDocuments.saveFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();
            file.markDirty();

            expect(file.isDirty.value).toBe(true);

            const result = await file.saveFile(savedBytes);

            expect(result).toEqual({
                success: true,
                outPath: '/save.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            });
            expect(file.isDirty.value).toBe(false);
            expect(file.pdfData.value).toEqual(savedBytes);
        });

        it('routes signed-document rewrites to Save As', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
            ]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/signed.pdf',
                workingPath: '/tmp/signed.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 2 });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocuments.analyzePdfConformance.mockResolvedValueOnce({
                isSigned: true,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: true,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: ['signed_original_requires_save_as'] as string[],
            });
            mockDocuments.writeFile.mockResolvedValue(undefined);
            mockDocuments.savePdfAs.mockResolvedValue('/exports/signed-copy.pdf');

            const file = usePdfFile();
            await file.openFile();

            const result = await file.saveFile(pdfBytes, { saveMode: 'rewrite' });

            expect(mockDocuments.saveFile).not.toHaveBeenCalled();
            expect(mockDocuments.savePdfAs).toHaveBeenCalledWith('/tmp/signed.pdf');
            expect(result).toEqual({
                success: true,
                outPath: '/exports/signed-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            });
        });
    });
});
