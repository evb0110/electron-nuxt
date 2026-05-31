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
    openPdfDirectBatch: vi.fn(),
    readFile: vi.fn(),
    readFileRange: vi.fn(),
    writeFile: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
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
    getPlatformAPI: () => mockElectronAPI,
    getElectronAPI: () => mockElectronAPI,
    hasElectronAPI: () => mockHasElectronAPI(),
    isDesktopPlatformActive: () => mockHasElectronAPI(),
    isBrowserPlatformActive: () => !mockHasElectronAPI(),
    isElectronRoutePath: (path: string | null | undefined) => path === '/electron' || path?.startsWith('/electron/') === true,
    resolveInitialDesktopRuntime: (_routePath: string | null | undefined) => mockHasElectronAPI(),
    shouldPreferDesktopPlatform: (
        routePath: string | null | undefined,
        desktopRuntime = false,
        electronApiAvailable = mockHasElectronAPI(),
    ) => electronApiAvailable || desktopRuntime || routePath === '/electron' || routePath?.startsWith('/electron/') === true,
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
        mockDocuments.cleanupFile.mockResolvedValue(undefined);
        mockDocuments.createWorkingCopyFromPath.mockReset();
        mockDocuments.openPdfDirectBatch.mockResolvedValue(null);
        mockDocuments.validatePdfData.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
    });

    describe('openFile', () => {
        it('sets pendingDjvu for DjVu files', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/docs/scan.djvu',
            });

            const file = usePdfFile();
            const outcome = await file.openFile();

            expect(outcome.status).toBe('opened');
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
            const outcome = await file.openFile();

            expect(outcome.status).toBe('opened');
            expect(file.workingCopyPath.value).toBe('/tmp/work/report.pdf');
            expect(file.originalPath.value).toBe('/docs/report.pdf');
            expect(file.pdfData.value).toBeTruthy();
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
        });

        it('rejects zero-byte PDFs before committing viewer state', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/docs/empty.pdf',
                workingPath: '/tmp/work/empty.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 0 });

            const file = usePdfFile();
            const outcome = await file.openFile();

            expect(outcome).toEqual({
                status: 'failed',
                error: 'errors.file.emptyPdf',
            });
            expect(file.error.value).toBe('errors.file.emptyPdf');
            expect(file.workingCopyPath.value).toBeNull();
            expect(file.originalPath.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
            expect(file.pdfSrc.value).toBeNull();
            expect(mockDocuments.readFile).not.toHaveBeenCalled();
            expect(mockDocuments.readFileRange).not.toHaveBeenCalled();
        });

        it('reads large PDF files in chunks when loading from a path', async () => {
            const firstChunk = new Uint8Array(4 * 1024 * 1024).fill(1);
            const secondChunk = Uint8Array.from([
                2,
                3,
                4,
                5,
            ]);
            const expected = new Uint8Array(firstChunk.length + secondChunk.length);
            expected.set(firstChunk, 0);
            expected.set(secondChunk, firstChunk.length);

            mockDocuments.statFile.mockResolvedValue({ size: expected.length });
            mockDocuments.readFileRange
                .mockResolvedValueOnce(firstChunk)
                .mockResolvedValueOnce(secondChunk);
            mockDocuments.analyzePdfConformance.mockResolvedValue({
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: false,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: [] as string[],
            });

            const file = usePdfFile();
            await file.loadPdfFromPath('/tmp/large.pdf');

            expect(mockDocuments.readFile).not.toHaveBeenCalled();
            expect(mockDocuments.readFileRange).toHaveBeenCalledTimes(2);
            expect(file.pdfData.value).toBeTruthy();
            expect(file.pdfData.value?.byteLength).toBe(expected.length);
            expect(file.pdfData.value?.[0]).toBe(1);
            expect(file.pdfData.value?.[firstChunk.length - 1]).toBe(1);
            expect(Array.from(file.pdfData.value?.slice(firstChunk.length) ?? [])).toEqual(Array.from(secondChunk));
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
        });

        it('does nothing when dialog is cancelled', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue(null);

            const file = usePdfFile();
            const outcome = await file.openFile();

            expect(outcome.status).toBe('cancelled');
            expect(file.pdfSrc.value).toBeNull();
            expect(file.error.value).toBeNull();
        });

        it('sets error on failure', async () => {
            mockDocuments.openPdfDialog.mockRejectedValue(new Error('Access denied'));

            const file = usePdfFile();
            const outcome = await file.openFile();

            expect(outcome).toEqual({
                status: 'failed',
                error: 'Access denied',
            });
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

        it('does not let a stale picker PDF result replace a newer PDF open', async () => {
            const newPdfBytes = new Uint8Array([6]);
            const pickerGate = deferred<{
                kind: 'pdf';
                originalPath: string;
                workingPath: string;
            }>();

            mockDocuments.openPdfDialog.mockImplementation(async () => pickerGate.promise);
            mockDocuments.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/new.pdf') {
                    return { size: newPdfBytes.length };
                }
                throw new Error(`unexpected stat path ${path}`);
            });
            mockDocuments.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/new.pdf') {
                    return newPdfBytes.buffer;
                }
                throw new Error(`unexpected read path ${path}`);
            });

            const file = usePdfFile();
            const stalePickerOpen = file.openFile();
            await expect(file.openFile({
                kind: 'pdf',
                originalPath: '/new.pdf',
                workingPath: '/tmp/new.pdf',
            })).resolves.toMatchObject({status: 'opened'});

            pickerGate.resolve({
                kind: 'pdf',
                originalPath: '/old.pdf',
                workingPath: '/tmp/old.pdf',
            });
            await expect(stalePickerOpen).resolves.toMatchObject({status: 'stale'});

            expect(file.workingCopyPath.value).toBe('/tmp/new.pdf');
            expect(file.originalPath.value).toBe('/new.pdf');
            expect(file.pdfData.value).toEqual(newPdfBytes);
            expect(mockDocuments.statFile).not.toHaveBeenCalledWith('/tmp/old.pdf');
            expect(mockDocuments.readFile).not.toHaveBeenCalledWith('/tmp/old.pdf');
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
            const outcome = await file.openFileDirect('/nonexistent.pdf');

            expect(outcome).toEqual({
                status: 'failed',
                error: 'errors.file.invalid',
            });
            expect(file.error.value).toBe('errors.file.invalid');
        });

        it('does not let a stale direct DjVu result replace a newer PDF open', async () => {
            const pdfBytes = new Uint8Array([7]);
            const staleDirectGate = deferred<{
                kind: 'djvu';
                originalPath: string;
            }>();

            mockDocuments.openPdfDirect.mockImplementation(async (path: string) => {
                if (path === '/stale.djvu') {
                    return staleDirectGate.promise;
                }
                if (path === '/new.pdf') {
                    return {
                        kind: 'pdf',
                        originalPath: '/new.pdf',
                        workingPath: '/tmp/new.pdf',
                    };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            const staleOpen = file.openFileDirect('/stale.djvu');
            await expect(file.openFileDirect('/new.pdf')).resolves.toMatchObject({status: 'opened'});

            staleDirectGate.resolve({
                kind: 'djvu',
                originalPath: '/stale.djvu',
            });
            await expect(staleOpen).resolves.toMatchObject({status: 'stale'});

            expect(file.pendingDjvu.value).toBeNull();
            expect(file.workingCopyPath.value).toBe('/tmp/new.pdf');
            expect(file.originalPath.value).toBe('/new.pdf');
            expect(file.pdfData.value).toEqual(pdfBytes);
        });
    });

    describe('openFileDirectBatch', () => {
        it('does not let a stale batch result replace a newer PDF open', async () => {
            const pdfBytes = new Uint8Array([8]);
            const staleBatchGate = deferred<{
                kind: 'djvu';
                originalPath: string;
            }>();

            mockDocuments.openPdfDirectBatch.mockImplementation(async () => staleBatchGate.promise);
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/new.pdf',
                workingPath: '/tmp/new.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = usePdfFile();
            const staleBatch = file.openFileDirectBatch(['/stale.djvu']);
            await expect(file.openFileDirect('/new.pdf')).resolves.toMatchObject({status: 'opened'});

            staleBatchGate.resolve({
                kind: 'djvu',
                originalPath: '/stale.djvu',
            });
            await expect(staleBatch).resolves.toMatchObject({status: 'stale'});

            expect(file.openBatchProgress.value).toBeNull();
            expect(file.pendingDjvu.value).toBeNull();
            expect(file.workingCopyPath.value).toBe('/tmp/new.pdf');
            expect(file.originalPath.value).toBe('/new.pdf');
            expect(file.pdfData.value).toEqual(pdfBytes);
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

        it('does not apply a history restore after the file is closed', async () => {
            const bytes1 = new Uint8Array([1]);
            const bytes2 = new Uint8Array([2]);
            const writeGate = deferred<undefined>();

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo.pdf',
                workingPath: '/tmp/undo.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: bytes1.length });
            mockDocuments.readFile.mockResolvedValue(bytes1.buffer);
            mockDocuments.writeFile.mockImplementation(async () => writeGate.promise);

            const file = usePdfFile();
            await file.openFile();
            await file.loadPdfFromData(bytes2);

            const undo = file.undo();
            file.closeFile();
            writeGate.resolve(undefined);

            await expect(undo).resolves.toBe(true);
            expect(file.workingCopyPath.value).toBeNull();
            expect(file.pdfData.value).toBeNull();
            expect(file.pdfSrc.value).toBeNull();
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

        it('can snapshot and undo large path-backed working copies', async () => {
            const largeSize = 70 * 1024 * 1024;

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo-large.pdf',
                workingPath: '/tmp/undo-large.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: largeSize });
            mockDocuments.createWorkingCopyFromPath
                .mockResolvedValueOnce('/tmp/history-large-base.pdf')
                .mockResolvedValueOnce('/tmp/history-large-crop.pdf')
                .mockResolvedValueOnce('/tmp/history-large-restored.pdf');

            const file = usePdfFile();
            await file.openFile();

            expect(file.pdfData.value).toBeNull();
            expect(file.canUndo.value).toBe(false);

            await expect(file.ensureHistoryBaselineForExternalMutation()).resolves.toBe(true);
            await expect(file.reloadWorkingCopyIntoHistory({ markDirty: true })).resolves.toBe(true);

            expect(file.canUndo.value).toBe(true);
            expect(file.isDirty.value).toBe(true);
            expect(mockDocuments.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
                1,
                '/tmp/undo-large.pdf',
                '/undo-large.pdf',
            );
            expect(mockDocuments.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
                2,
                '/tmp/undo-large.pdf',
                '/undo-large.pdf',
            );

            await expect(file.undo()).resolves.toBe(true);

            expect(file.workingCopyPath.value).toBe('/tmp/history-large-restored.pdf');
            expect(file.pdfData.value).toBeNull();
            expect(file.pdfSrc.value).toEqual({
                kind: 'path',
                path: '/tmp/history-large-restored.pdf',
                size: largeSize,
            });
            expect(mockDocuments.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
                3,
                '/tmp/history-large-base.pdf',
                '/undo-large.pdf',
            );
            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/undo-large.pdf');
        });

        it('cleans path-backed history snapshots when closing a large document', async () => {
            const largeSize = 70 * 1024 * 1024;

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo-large.pdf',
                workingPath: '/tmp/undo-large.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: largeSize });
            mockDocuments.createWorkingCopyFromPath
                .mockResolvedValueOnce('/tmp/history-large-base.pdf')
                .mockResolvedValueOnce('/tmp/history-large-crop.pdf');

            const file = usePdfFile();
            await file.openFile();
            await file.ensureHistoryBaselineForExternalMutation();
            await file.reloadWorkingCopyIntoHistory({ markDirty: true });

            file.closeFile();

            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/history-large-base.pdf');
            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/history-large-crop.pdf');
            expect(mockDocuments.cleanupFile).toHaveBeenCalledWith('/tmp/undo-large.pdf');
        });

        it('updates the live PDF source blob when persisting silently', async () => {
            const bytes1 = new Uint8Array([
                1,
                2,
            ]);
            const bytes2 = new Uint8Array([
                3,
                4,
                5,
            ]);

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/persist.pdf',
                workingPath: '/tmp/persist.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: bytes1.length });
            mockDocuments.readFile.mockResolvedValue(bytes1.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.openFile();

            await file.persistPdfDataSilently(bytes2);

            expect(file.pdfData.value).toEqual(bytes2);
            expect(mockDocuments.writeFile).toHaveBeenCalledWith('/tmp/persist.pdf', expect.any(Uint8Array));
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
            expect(new Uint8Array(await (file.pdfSrc.value as Blob).arrayBuffer())).toEqual(bytes2);
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

        it('resolves after committing saved bytes without waiting for deferred conformance analysis', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
            ]);
            const savedBytes = new Uint8Array([
                9,
                9,
            ]);
            const unsignedProfile = {
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: false,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: [] as string[],
            };
            const postSaveProfile = {
                ...unsignedProfile,
                isTagged: true,
            };
            const conformanceGate = deferred<typeof postSaveProfile>();
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/save.pdf',
                workingPath: '/tmp/save.pdf',
            });
            mockDocuments.statFile.mockResolvedValue({ size: 2 });
            mockDocuments.readFile.mockResolvedValueOnce(pdfBytes.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);
            mockDocuments.saveFile.mockResolvedValue(undefined);
            mockDocuments.analyzePdfConformance
                .mockResolvedValueOnce(unsignedProfile)
                .mockImplementationOnce(() => conformanceGate.promise);

            const file = usePdfFile();
            await file.openFile();
            await vi.waitFor(() => {
                expect(file.pdfConformanceProfile.value).toEqual(unsignedProfile);
            });
            file.markDirty();

            let saveSettled = false;
            let saveResult: Awaited<ReturnType<typeof file.saveFile>> | null = null;
            const savePromise = file.saveFile(savedBytes).then((result) => {
                saveSettled = true;
                saveResult = result;
                return result;
            });

            await vi.waitFor(() => {
                expect(file.pdfData.value).toEqual(savedBytes);
            });
            await vi.waitFor(() => {
                expect(saveSettled).toBe(true);
            });
            expect(saveResult).toEqual({
                success: true,
                outPath: '/save.pdf',
                saveMode: 'rewrite',
                didSaveAs: false,
            });
            expect(file.pdfConformanceProfile.value).toBeNull();

            conformanceGate.resolve(postSaveProfile);
            await savePromise;
            await vi.waitFor(() => {
                expect(file.pdfConformanceProfile.value).toEqual(postSaveProfile);
            });
        });

        it('ignores stale deferred conformance results for the same working path', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
            ]);
            const savedBytes = new Uint8Array([
                8,
                8,
            ]);
            const staleProfile = {
                isSigned: true,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: false,
                hasXfa: false,
                canIncrementalSave: false,
                saveRestrictions: ['signed'] as string[],
            };
            const latestProfile = {
                ...staleProfile,
                isSigned: false,
                canIncrementalSave: true,
                saveRestrictions: [] as string[],
            };
            const staleConformanceGate = deferred<typeof staleProfile>();
            const latestConformanceGate = deferred<typeof latestProfile>();
            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);
            mockDocuments.analyzePdfConformance
                .mockImplementationOnce(() => staleConformanceGate.promise)
                .mockImplementationOnce(() => latestConformanceGate.promise);

            const file = usePdfFile();
            await file.loadPdfFromPath('/tmp/save.pdf');
            expect(file.pdfConformanceProfile.value).toBeNull();

            await file.persistPdfDataSilently(savedBytes);

            staleConformanceGate.resolve(staleProfile);
            await Promise.resolve();
            await Promise.resolve();
            expect(file.pdfConformanceProfile.value).toBeNull();

            latestConformanceGate.resolve(latestProfile);
            await vi.waitFor(() => {
                expect(file.pdfConformanceProfile.value).toEqual(latestProfile);
            });
        });

        it('does not apply save completion state after another document opens', async () => {
            const firstBytes = new Uint8Array([1]);
            const secondBytes = new Uint8Array([2]);
            const savedBytes = new Uint8Array([9]);

            mockDocuments.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstBytes.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondBytes.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocuments.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return firstBytes.buffer;
                }
                if (path === '/tmp/second.pdf') {
                    return secondBytes.buffer;
                }
                throw new Error(`unexpected path ${path}`);
            });
            const saveGate = deferred<undefined>();
            mockDocuments.writeFile.mockResolvedValue(undefined);
            mockDocuments.saveFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    await saveGate.promise;
                    return;
                }
                throw new Error(`unexpected save path ${path}`);
            });

            const file = usePdfFile();
            await file.openFile({
                kind: 'pdf',
                originalPath: '/first.pdf',
                workingPath: '/tmp/first.pdf',
            });
            file.markDirty();

            const save = file.saveFile(savedBytes);
            await file.openFile({
                kind: 'pdf',
                originalPath: '/second.pdf',
                workingPath: '/tmp/second.pdf',
            });

            saveGate.resolve(undefined);
            await expect(save).resolves.toEqual({
                success: false,
                outPath: null,
                saveMode: 'rewrite',
                didSaveAs: false,
            });

            expect(file.workingCopyPath.value).toBe('/tmp/second.pdf');
            expect(file.originalPath.value).toBe('/second.pdf');
            expect(file.pdfData.value).toEqual(secondBytes);
            expect(file.isDirty.value).toBe(false);
            expect(file.lastSaveMode.value).toBe('rewrite');
        });

        it('does not write serialized bytes when the expected working copy is no longer active', async () => {
            const pdfBytes = new Uint8Array([1]);
            const savedBytes = new Uint8Array([9]);

            mockDocuments.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocuments.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocuments.writeFile.mockResolvedValue(undefined);

            const file = usePdfFile();
            await file.loadPdfFromPath('/tmp/active.pdf');

            const result = await file.saveFile(savedBytes, { expectedWorkingPath: '/tmp/stale.pdf' });

            expect(result).toEqual({
                success: false,
                outPath: null,
                saveMode: 'rewrite',
                didSaveAs: false,
            });
            expect(mockDocuments.writeFile).not.toHaveBeenCalledWith('/tmp/active.pdf', expect.any(Uint8Array));
            expect(file.workingCopyPath.value).toBe('/tmp/active.pdf');
            expect(file.pdfData.value).toEqual(pdfBytes);
        });

        it('does not apply Save As completion state after another document opens', async () => {
            const firstBytes = new Uint8Array([1]);
            const secondBytes = new Uint8Array([2]);
            const saveAsGate = deferred<string>();

            mockDocuments.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstBytes.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondBytes.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocuments.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return firstBytes.buffer;
                }
                if (path === '/tmp/second.pdf') {
                    return secondBytes.buffer;
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocuments.savePdfAs.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return saveAsGate.promise;
                }
                throw new Error(`unexpected Save As path ${path}`);
            });

            const file = usePdfFile();
            await file.openFile({
                kind: 'pdf',
                originalPath: '/first.pdf',
                workingPath: '/tmp/first.pdf',
            });

            const saveAs = file.saveWorkingCopyAs();
            await file.openFile({
                kind: 'pdf',
                originalPath: '/second.pdf',
                workingPath: '/tmp/second.pdf',
            });

            saveAsGate.resolve('/exports/first-copy.pdf');
            await expect(saveAs).resolves.toEqual({
                success: false,
                outPath: null,
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            });

            expect(file.workingCopyPath.value).toBe('/tmp/second.pdf');
            expect(file.originalPath.value).toBe('/second.pdf');
            expect(file.pdfData.value).toEqual(secondBytes);
            expect(mockDocuments.createWorkingCopyFromPath).not.toHaveBeenCalled();
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
