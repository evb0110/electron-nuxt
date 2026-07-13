import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { Ref } from 'vue';
import type { IPdfConformanceProfile } from '@contracts/pdfConformance';

const mockOpenPdfDialog = vi.fn();
const mockOpenPdfDirect = vi.fn();
const mockOpenPdfDirectBatch = vi.fn();
const mockOnOpenPdfDirectBatchProgress = vi.fn(() => vi.fn());

const forwardToOpenPdfDialog = (...args: unknown[]) => mockOpenPdfDialog(...args);
const forwardToOpenPdfDirect = (...args: unknown[]) => mockOpenPdfDirect(...args);
const forwardToOpenPdfDirectBatch = (...args: unknown[]) => mockOpenPdfDirectBatch(...args);

const mockDocumentPicker = {openDocumentDialog: vi.fn(forwardToOpenPdfDialog)};
const mockDocumentOpen = {
    openDocumentDirect: vi.fn(forwardToOpenPdfDirect),
    openPdfDirect: mockOpenPdfDirect,
    openDocumentDirectBatch: vi.fn(forwardToOpenPdfDirectBatch),
    openPdfDirectBatch: mockOpenPdfDirectBatch,
};
const failLegacyDocumentsCall = (method: string): never => {
    throw new Error(`legacy documents.${method} should not be used`);
};
const mockDocumentFiles = {
    readFile: vi.fn(),
    readFileRange: vi.fn(),
    writeFile: vi.fn(),
    saveFileStructured: vi.fn(),
    savePdfNoteTextUpdates: vi.fn(),
    savePdfNoteChanges: vi.fn(),
    savePdfAs: vi.fn(),
    statFile: vi.fn(),
    getDocumentRevision: vi.fn(),
    repairPdf: vi.fn(),
    optimizePdfForInteraction: vi.fn(),
    optimizePdfAsCopy: vi.fn(),
};
const mockDocumentPdf = {
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
};
const mockDocumentWorkingCopy = {
    cleanupFile: vi.fn(),
    createWorkingCopyFromData: vi.fn(),
    createWorkingCopyFromPath: vi.fn(),
};
const mockDocuments = {
    openDocumentDialog: vi.fn(forwardToOpenPdfDialog),
    openPdfDialog: mockOpenPdfDialog,
    openDocumentDirect: vi.fn(forwardToOpenPdfDirect),
    openPdfDirect: mockOpenPdfDirect,
    openDocumentDirectBatch: vi.fn(forwardToOpenPdfDirectBatch),
    openPdfDirectBatch: mockOpenPdfDirectBatch,
    readFile: vi.fn(() => failLegacyDocumentsCall('readFile')),
    readFileRange: vi.fn(() => failLegacyDocumentsCall('readFileRange')),
    writeFile: vi.fn(() => failLegacyDocumentsCall('writeFile')),
    createWorkingCopyFromData: vi.fn(() => failLegacyDocumentsCall('createWorkingCopyFromData')),
    createWorkingCopyFromPath: vi.fn(() => failLegacyDocumentsCall('createWorkingCopyFromPath')),
    saveFileStructured: vi.fn(() => failLegacyDocumentsCall('saveFileStructured')),
    savePdfNoteTextUpdates: vi.fn(() => failLegacyDocumentsCall('savePdfNoteTextUpdates')),
    savePdfNoteChanges: vi.fn(() => failLegacyDocumentsCall('savePdfNoteChanges')),
    savePdfAs: vi.fn(() => failLegacyDocumentsCall('savePdfAs')),
    statFile: vi.fn(() => failLegacyDocumentsCall('statFile')),
    getDocumentRevision: vi.fn(() => failLegacyDocumentsCall('getDocumentRevision')),
    cleanupFile: vi.fn(() => failLegacyDocumentsCall('cleanupFile')),
    analyzePdfConformance: vi.fn(() => failLegacyDocumentsCall('analyzePdfConformance')),
    validatePdfData: vi.fn(() => failLegacyDocumentsCall('validatePdfData')),
    onOpenDocumentDirectBatchProgress: mockOnOpenPdfDirectBatchProgress,
    onOpenPdfDirectBatchProgress: mockOnOpenPdfDirectBatchProgress,
};
const mockElectronAPI = {
    documentFiles: mockDocumentFiles,
    documentOpen: mockDocumentOpen,
    documentPdf: mockDocumentPdf,
    documentPicker: mockDocumentPicker,
    documentWorkingCopy: mockDocumentWorkingCopy,
    documents: mockDocuments,
};
const mockHasElectronAPI = vi.fn(() => true);

vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => mockElectronAPI,
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

vi.mock('@app/modules/pdf-viewer/runtime/composables/pdf/useOcrTextContent', () => ({useOcrTextContent: () => ({clearCache: vi.fn()})}));

const mockT = vi.fn((key: string) => key);
vi.stubGlobal('useI18n', () => ({ t: mockT }));

vi.stubGlobal('window', {
    ...globalThis,
    electronAPI: mockElectronAPI,
});

const { usePdfFile } = await import('@app/modules/workspace-shell/composables/usePdfFile');

interface IPdfFileTestOpenOutcome {
    error?: string;
    status: string;
}

interface IPdfFileTestSaveResult {
    didSaveAs: boolean;
    outPath: string | null;
    saveMode: string;
    success: boolean;
}

interface IPdfFileTestSourcePath {
    kind: 'path';
    path: string;
    size: number;
}

interface IPdfFileTestApi {
    canRedo: Ref<boolean>;
    canUndo: Ref<boolean>;
    closeFile: () => void;
    ensureHistoryBaselineForExternalMutation: () => Promise<boolean>;
    error: Ref<string | null>;
    fileName: Ref<string | null>;
    isDirty: Ref<boolean>;
    lastSaveMode: Ref<string>;
    loadPdfFromData: (data: Uint8Array) => Promise<void>;
    loadPdfFromPath: (path: string) => Promise<void>;
    markDirty: () => void;
    openBatchProgress: Ref<unknown | null>;
    openFile: (result?: unknown) => Promise<IPdfFileTestOpenOutcome>;
    openFileDirect: (path: string) => Promise<IPdfFileTestOpenOutcome>;
    openFileDirectBatch: (paths: string[]) => Promise<IPdfFileTestOpenOutcome>;
    originalPath: Ref<string | null>;
    pdfConformanceProfile: Ref<IPdfConformanceProfile | null>;
    pdfData: Ref<Uint8Array | null>;
    pdfSrc: Ref<Blob | IPdfFileTestSourcePath | null>;
    documentRevisionToken: Ref<string | null>;
    pendingDjvu: Ref<string | null>;
    persistPdfDataSilently: (data: Uint8Array) => Promise<boolean>;
    redo: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (options?: { markDirty?: boolean }) => Promise<boolean>;
    saveFile: (
        data: Uint8Array,
        options?: {
            expectedWorkingPath?: string;
            saveMode?: string;
        },
    ) => Promise<IPdfFileTestSaveResult>;
    saveWorkingCopyAs: () => Promise<IPdfFileTestSaveResult>;
    trySaveEmbeddedNoteTextUpdates: (updates: unknown[], options: unknown) => Promise<IPdfFileTestSaveResult>;
    undo: () => Promise<boolean>;
    workingCopyPath: Ref<string | null>;
}

function createTestPdfFile() {
    return usePdfFile() as IPdfFileTestApi;
}

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
        mockDocumentPicker.openDocumentDialog.mockReset();
        mockDocumentPicker.openDocumentDialog.mockImplementation(forwardToOpenPdfDialog);
        mockDocumentOpen.openDocumentDirect.mockReset();
        mockDocumentOpen.openDocumentDirect.mockImplementation(forwardToOpenPdfDirect);
        mockDocumentOpen.openDocumentDirectBatch.mockReset();
        mockDocumentOpen.openDocumentDirectBatch.mockImplementation(forwardToOpenPdfDirectBatch);
        mockDocuments.openDocumentDialog.mockReset();
        mockDocuments.openDocumentDialog.mockImplementation(forwardToOpenPdfDialog);
        mockDocuments.openDocumentDirect.mockReset();
        mockDocuments.openDocumentDirect.mockImplementation(forwardToOpenPdfDirect);
        mockDocuments.openDocumentDirectBatch.mockReset();
        mockDocuments.openDocumentDirectBatch.mockImplementation(forwardToOpenPdfDirectBatch);
        mockDocuments.openPdfDialog.mockReset();
        mockDocuments.openPdfDirect.mockReset();
        mockDocuments.openPdfDirectBatch.mockReset();
        mockDocumentFiles.readFile.mockReset();
        mockDocumentFiles.readFileRange.mockReset();
        mockDocumentFiles.writeFile.mockReset();
        mockDocumentFiles.saveFileStructured.mockReset();
        mockDocumentFiles.saveFileStructured.mockResolvedValue({
            ok: true,
            externalWriteCommitted: true,
            workingCopyRefreshed: true,
            validation: null,
        });
        mockDocumentFiles.savePdfNoteTextUpdates.mockReset();
        mockDocumentFiles.savePdfNoteChanges.mockReset();
        mockDocumentFiles.savePdfAs.mockReset();
        mockDocumentFiles.statFile.mockReset();
        mockDocumentFiles.getDocumentRevision.mockReset();
        mockDocumentFiles.getDocumentRevision.mockResolvedValue({
            version: 1,
            documentRef: '/tmp/work.pdf',
            authority: 'electron-working-copy',
            contentRevision: 1,
            mintedAt: 1,
            token: 'revision-token',
        });
        mockDocumentFiles.repairPdf.mockReset();
        mockDocumentFiles.optimizePdfForInteraction.mockReset();
        mockDocumentFiles.optimizePdfAsCopy.mockReset();
        mockDocumentWorkingCopy.cleanupFile.mockReset();
        mockDocumentWorkingCopy.cleanupFile.mockResolvedValue(undefined);
        mockDocumentWorkingCopy.createWorkingCopyFromData.mockReset();
        mockDocumentWorkingCopy.createWorkingCopyFromPath.mockReset();
        mockDocuments.openPdfDirectBatch.mockResolvedValue(null);
        mockDocumentPdf.analyzePdfConformance.mockReset();
        mockDocumentPdf.analyzePdfConformance.mockResolvedValue({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [] as string[],
        });
        mockDocumentPdf.validatePdfData.mockReset();
        mockDocumentPdf.validatePdfData.mockResolvedValue({
            isValid: true,
            tool: 'qpdf',
            errors: [],
            warnings: [],
        });
    });

    it('uses the split file capability for repair and optimization feature detection', () => {
        const file = usePdfFile() as IPdfFileTestApi & {
            optimizeWorkingCopy?: unknown;
            optimizeWorkingCopyAsCopy?: unknown;
            repairWorkingCopy?: unknown;
        };

        expect('repairPdf' in mockDocuments).toBe(false);
        expect('optimizePdfForInteraction' in mockDocuments).toBe(false);
        expect('optimizePdfAsCopy' in mockDocuments).toBe(false);
        expect(typeof file.repairWorkingCopy).toBe('function');
        expect(typeof file.optimizeWorkingCopy).toBe('function');
        expect(typeof file.optimizeWorkingCopyAsCopy).toBe('function');
    });

    describe('openFile', () => {
        it('uses the split picker capability for UI document picks', async () => {
            mockDocuments.openDocumentDialog.mockRejectedValue(new Error('legacy picker should not be used'));
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/docs/split-picker.djvu',
            });

            const file = createTestPdfFile();
            const outcome = await file.openFile();

            expect(outcome.status).toBe('prepared');
            expect(file.pendingDjvu.value).toBe('/docs/split-picker.djvu');
            expect(mockDocumentPicker.openDocumentDialog).toHaveBeenCalledOnce();
            expect(mockDocuments.openDocumentDialog).not.toHaveBeenCalled();
        });

        it('sets pendingDjvu for DjVu files', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/docs/scan.djvu',
            });

            const file = createTestPdfFile();
            const outcome = await file.openFile();

            expect(outcome.status).toBe('prepared');
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 0 });

            const file = createTestPdfFile();
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
            expect(mockDocumentFiles.readFile).not.toHaveBeenCalled();
            expect(mockDocumentFiles.readFileRange).not.toHaveBeenCalled();
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

            mockDocumentFiles.statFile.mockResolvedValue({ size: expected.length });
            mockDocumentFiles.readFileRange
                .mockResolvedValueOnce(firstChunk)
                .mockResolvedValueOnce(secondChunk);
            mockDocumentPdf.analyzePdfConformance.mockResolvedValue({
                isSigned: false,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: false,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: [] as string[],
            });

            const file = createTestPdfFile();
            await file.loadPdfFromPath('/tmp/large.pdf');

            expect(mockDocumentFiles.readFile).not.toHaveBeenCalled();
            expect(mockDocumentFiles.readFileRange).toHaveBeenCalledTimes(2);
            expect(file.pdfData.value).toBeTruthy();
            expect(file.pdfData.value?.byteLength).toBe(expected.length);
            expect(file.pdfData.value?.[0]).toBe(1);
            expect(file.pdfData.value?.[firstChunk.length - 1]).toBe(1);
            expect(Array.from(file.pdfData.value?.slice(firstChunk.length) ?? [])).toEqual(Array.from(secondChunk));
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
        });

        it('does nothing when dialog is cancelled', async () => {
            mockDocuments.openPdfDialog.mockResolvedValue(null);

            const file = createTestPdfFile();
            const outcome = await file.openFile();

            expect(outcome.status).toBe('cancelled');
            expect(file.pdfSrc.value).toBeNull();
            expect(file.error.value).toBeNull();
        });

        it('sets error on failure', async () => {
            mockDocuments.openPdfDialog.mockRejectedValue(new Error('Access denied'));

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = createTestPdfFile();
            await file.openFile();

            expect(file.fileName.value).toBe('Глава.pdf');
        });

        it('keeps browser DjVu opens in the shared pending flow', async () => {
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'djvu',
                originalPath: 'browser://documents/source/browser-open.djvu',
            });

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/new.pdf') {
                    return { size: newPdfBytes.length };
                }
                throw new Error(`unexpected stat path ${path}`);
            });
            mockDocumentFiles.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/new.pdf') {
                    return newPdfBytes.buffer;
                }
                throw new Error(`unexpected read path ${path}`);
            });

            const file = createTestPdfFile();
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
            expect(mockDocumentFiles.statFile).not.toHaveBeenCalledWith('/tmp/old.pdf');
            expect(mockDocumentFiles.readFile).not.toHaveBeenCalledWith('/tmp/old.pdf');
        });
    });

    describe('openFileDirect', () => {
        it('uses the split open capability for direct document opens', async () => {
            mockDocuments.openDocumentDirect.mockRejectedValue(new Error('legacy direct open should not be used'));
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/path/split-direct.djvu',
            });

            const file = createTestPdfFile();
            const outcome = await file.openFileDirect('/path/split-direct.djvu');

            expect(outcome.status).toBe('prepared');
            expect(file.pendingDjvu.value).toBe('/path/split-direct.djvu');
            expect(mockDocumentOpen.openDocumentDirect).toHaveBeenCalledWith('/path/split-direct.djvu');
            expect(mockDocuments.openDocumentDirect).not.toHaveBeenCalled();
        });

        it('detects DjVu files from direct open', async () => {
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/path/doc.djvu',
            });

            const file = createTestPdfFile();
            await file.openFileDirect('/path/doc.djvu');

            expect(file.pendingDjvu.value).toBe('/path/doc.djvu');
        });

        it('keeps browser DjVu direct opens in the shared pending flow', async () => {
            mockHasElectronAPI.mockReturnValue(false);
            mockDocuments.openPdfDirect.mockResolvedValue({
                kind: 'djvu',
                originalPath: 'browser://documents/source/browser-open.djvu',
            });

            const file = createTestPdfFile();
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

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = createTestPdfFile();
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
        it('uses the split open capability for direct batch document opens', async () => {
            mockDocuments.openDocumentDirectBatch.mockRejectedValue(new Error('legacy direct batch should not be used'));
            mockDocuments.openPdfDirectBatch.mockResolvedValue({
                kind: 'djvu',
                originalPath: '/path/split-batch.djvu',
            });

            const file = createTestPdfFile();
            const outcome = await file.openFileDirectBatch(['/path/split-batch.djvu']);

            expect(outcome.status).toBe('prepared');
            expect(file.pendingDjvu.value).toBe('/path/split-batch.djvu');
            expect(mockDocumentOpen.openDocumentDirectBatch).toHaveBeenCalledWith(
                ['/path/split-batch.djvu'],
                expect.any(String),
            );
            expect(mockDocuments.openDocumentDirectBatch).not.toHaveBeenCalled();
        });

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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);

            const file = createTestPdfFile();
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
        it('keeps large PDFs path-backed without eager conformance analysis', async () => {
            const largePdfSize = 128 * 1024 * 1024;
            mockDocumentFiles.statFile.mockResolvedValue({ size: largePdfSize });

            const file = createTestPdfFile();
            await file.loadPdfFromPath('/tmp/large.pdf');

            expect(file.workingCopyPath.value).toBe('/tmp/large.pdf');
            expect(file.pdfData.value).toBeNull();
            expect(file.pdfSrc.value).toEqual({
                kind: 'path',
                path: '/tmp/large.pdf',
                size: largePdfSize,
            });
            expect(file.pdfConformanceProfile.value).toBeNull();
            expect(mockDocumentFiles.readFile).not.toHaveBeenCalled();
            expect(mockDocumentPdf.analyzePdfConformance).not.toHaveBeenCalled();
        });

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
            mockDocumentFiles.statFile.mockResolvedValueOnce({ size: oldPdf.length });
            mockDocumentFiles.readFile.mockResolvedValueOnce(oldPdf.buffer);

            const file = createTestPdfFile();
            await file.openFile();

            mockDocumentFiles.statFile.mockRejectedValueOnce(new Error('read failure'));
            await expect(file.loadPdfFromPath('/tmp/new.pdf')).rejects.toThrow('read failure');

            expect(file.workingCopyPath.value).toBe('/tmp/old.pdf');
            expect(mockDocumentWorkingCopy.cleanupFile).not.toHaveBeenCalled();
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
            mockDocumentFiles.statFile.mockResolvedValueOnce({ size: oldPdf.length });
            mockDocumentFiles.readFile.mockResolvedValueOnce(oldPdf.buffer);
            mockDocumentWorkingCopy.cleanupFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
            await file.openFile();

            const firstReadGate = deferred<ArrayBuffer>();
            mockDocumentFiles.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstPdf.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondPdf.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocumentFiles.readFile.mockImplementation(async (path: string) => {
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
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledTimes(1);
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/old.pdf');
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 3 });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentWorkingCopy.cleanupFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
            await file.openFile();

            expect(file.pdfSrc.value).not.toBeNull();

            file.closeFile();

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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 1 });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentWorkingCopy.cleanupFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
            await file.openFile();
            file.closeFile();

            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/a.pdf');
        });

        it('still cleans up the working copy when Electron API is unavailable', async () => {
            const pdfBytes = new Uint8Array([1]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/a.pdf',
                workingPath: '/tmp/a.pdf',
            });
            mockDocumentFiles.statFile.mockResolvedValue({ size: 1 });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockHasElectronAPI.mockReturnValue(false);

            const file = createTestPdfFile();
            await file.openFile();
            file.closeFile();

            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/a.pdf');
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 2 });
            mockDocumentFiles.readFile.mockResolvedValue(bytes1.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
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

        it('refreshes conformance after byte-history undo restores the working copy', async () => {
            const bytes1 = new Uint8Array([1]);
            const bytes2 = new Uint8Array([2]);
            const staleProfile = {
                isSigned: true,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: true,
                hasXfa: false,
                canIncrementalSave: false,
                saveRestrictions: ['signed_original_requires_save_as'] as string[],
            };
            const restoredProfile = {
                ...staleProfile,
                isSigned: false,
                hasAcroForm: false,
                canIncrementalSave: true,
                saveRestrictions: [] as string[],
            };
            const conformanceGate = deferred<typeof restoredProfile>();

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo.pdf',
                workingPath: '/tmp/undo.pdf',
            });
            mockDocumentFiles.statFile.mockResolvedValue({ size: bytes1.length });
            mockDocumentFiles.readFile.mockResolvedValue(bytes1.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentPdf.analyzePdfConformance.mockResolvedValue(staleProfile);

            const file = createTestPdfFile();
            await file.openFile();
            await vi.waitFor(() => {
                expect(file.pdfConformanceProfile.value).toEqual(staleProfile);
            });
            await file.loadPdfFromData(bytes2);
            file.pdfConformanceProfile.value = staleProfile;
            mockDocumentPdf.analyzePdfConformance.mockClear();
            mockDocumentPdf.analyzePdfConformance.mockImplementationOnce(() => conformanceGate.promise);

            await expect(file.undo()).resolves.toBe(true);

            expect(file.pdfConformanceProfile.value).toBeNull();
            expect(mockDocumentPdf.analyzePdfConformance).toHaveBeenCalledWith('/tmp/undo.pdf');

            conformanceGate.resolve(restoredProfile);
            await vi.waitFor(() => {
                expect(file.pdfConformanceProfile.value).toEqual(restoredProfile);
            });
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: bytes1.length });
            mockDocumentFiles.readFile.mockResolvedValue(bytes1.buffer);
            mockDocumentFiles.writeFile.mockImplementation(async () => writeGate.promise);

            const file = createTestPdfFile();
            await file.openFile();
            await file.loadPdfFromData(bytes2);

            const undo = file.undo();
            file.closeFile();
            writeGate.resolve(undefined);

            await expect(undo).resolves.toBe(false);
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
            mockDocumentFiles.statFile
                .mockResolvedValue({ size: bytes2.length })
                .mockResolvedValueOnce({ size: bytes1.length });
            mockDocumentFiles.readFile
                .mockResolvedValue(bytes2.buffer)
                .mockResolvedValueOnce(bytes1.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: largeSize });
            mockDocumentWorkingCopy.createWorkingCopyFromPath
                .mockResolvedValueOnce('/tmp/history-large-base.pdf')
                .mockResolvedValueOnce('/tmp/history-large-crop.pdf')
                .mockResolvedValueOnce('/tmp/history-large-restored.pdf');

            const file = createTestPdfFile();
            await file.openFile();

            expect(file.pdfData.value).toBeNull();
            expect(file.canUndo.value).toBe(false);

            await expect(file.ensureHistoryBaselineForExternalMutation()).resolves.toBe(true);
            await expect(file.reloadWorkingCopyIntoHistory({ markDirty: true })).resolves.toBe(true);

            expect(file.canUndo.value).toBe(true);
            expect(file.isDirty.value).toBe(true);
            expect(mockDocumentWorkingCopy.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
                1,
                '/tmp/undo-large.pdf',
                '/undo-large.pdf',
            );
            expect(mockDocumentWorkingCopy.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
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
            expect(mockDocumentWorkingCopy.createWorkingCopyFromPath).toHaveBeenNthCalledWith(
                3,
                '/tmp/history-large-base.pdf',
                '/undo-large.pdf',
            );
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/undo-large.pdf');
        });

        it('cleans path-backed history snapshots when closing a large document', async () => {
            const largeSize = 70 * 1024 * 1024;

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo-large.pdf',
                workingPath: '/tmp/undo-large.pdf',
            });
            mockDocumentFiles.statFile.mockResolvedValue({ size: largeSize });
            mockDocumentWorkingCopy.createWorkingCopyFromPath
                .mockResolvedValueOnce('/tmp/history-large-base.pdf')
                .mockResolvedValueOnce('/tmp/history-large-crop.pdf');

            const file = createTestPdfFile();
            await file.openFile();
            await file.ensureHistoryBaselineForExternalMutation();
            await file.reloadWorkingCopyIntoHistory({ markDirty: true });

            file.closeFile();

            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/history-large-base.pdf');
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/history-large-crop.pdf');
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/undo-large.pdf');
        });

        it('stores medium in-memory PDF undo snapshots as disk-backed history entries', async () => {
            const historyThresholdBytes = 8 * 1024 * 1024;
            const bytes1 = new Uint8Array(historyThresholdBytes + 1).fill(1);
            const bytes2 = new Uint8Array(historyThresholdBytes + 1).fill(2);
            const bytesByPath = new Map<string, Uint8Array>();
            bytesByPath.set('/tmp/undo-medium.pdf', bytes1);
            let historyPathIndex = 0;
            let restoredPathIndex = 0;

            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/undo-medium.pdf',
                workingPath: '/tmp/undo-medium.pdf',
            });
            mockDocumentFiles.statFile.mockImplementation(async (path: string) => ({size: bytesByPath.get(path)?.byteLength ?? 0}));
            mockDocumentFiles.readFileRange.mockImplementation(async (
                path: string,
                offset: number,
                length: number,
            ) => bytesByPath.get(path)?.slice(offset, offset + length) ?? new Uint8Array());
            mockDocumentWorkingCopy.createWorkingCopyFromData.mockImplementation(async (
                _fileName: string,
                data: Uint8Array,
            ) => {
                historyPathIndex += 1;
                const path = `/tmp/history-medium-${historyPathIndex}.pdf`;
                bytesByPath.set(path, data.slice());
                return path;
            });
            mockDocumentWorkingCopy.createWorkingCopyFromPath.mockImplementation(async (sourcePath: string) => {
                restoredPathIndex += 1;
                const path = `/tmp/restored-medium-${restoredPathIndex}.pdf`;
                bytesByPath.set(path, bytesByPath.get(sourcePath)?.slice() ?? new Uint8Array());
                return path;
            });

            const file = createTestPdfFile();
            await file.openFile();
            await file.loadPdfFromData(bytes2);

            expect(file.canUndo.value).toBe(true);
            expect(mockDocumentWorkingCopy.createWorkingCopyFromData).toHaveBeenCalledTimes(2);

            await expect(file.undo()).resolves.toBe(true);

            expect(mockDocumentWorkingCopy.createWorkingCopyFromPath).toHaveBeenCalledWith(
                '/tmp/history-medium-1.pdf',
                '/undo-medium.pdf',
            );
            expect(file.workingCopyPath.value).toBe('/tmp/restored-medium-1.pdf');
            expect(file.pdfData.value?.byteLength).toBe(bytes1.byteLength);
            expect(file.pdfData.value?.[0]).toBe(1);

            file.closeFile();

            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/history-medium-1.pdf');
            expect(mockDocumentWorkingCopy.cleanupFile).toHaveBeenCalledWith('/tmp/history-medium-2.pdf');
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: bytes1.length });
            mockDocumentFiles.readFile.mockResolvedValue(bytes1.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
            await file.openFile();

            await file.persistPdfDataSilently(bytes2);

            expect(file.pdfData.value).toEqual(bytes2);
            expect(mockDocumentFiles.writeFile).toHaveBeenCalledWith('/tmp/persist.pdf', expect.any(Uint8Array), {expectedDocumentRevisionToken: 'revision-token'});
            expect(file.pdfSrc.value).toBeInstanceOf(Blob);
            expect(new Uint8Array(await (file.pdfSrc.value as Blob).arrayBuffer())).toEqual(bytes2);
        });
    });

    describe('saveFile', () => {
        it('returns a failed persist result when no working copy path', async () => {
            const file = createTestPdfFile();

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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 2 });
            mockDocumentFiles.readFile
                .mockResolvedValueOnce(pdfBytes.buffer)
                .mockResolvedValueOnce(savedBytes.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentFiles.saveFileStructured.mockResolvedValue({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });

            const file = createTestPdfFile();
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

        it('resets lastSaveMode when the current document is closed', async () => {
            const pdfBytes = new Uint8Array([1]);
            const savedBytes = new Uint8Array([2]);
            mockDocuments.openPdfDialog.mockResolvedValue({
                kind: 'pdf',
                originalPath: '/save.pdf',
                workingPath: '/tmp/save.pdf',
            });
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentFiles.saveFileStructured.mockResolvedValue({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });

            const file = createTestPdfFile();
            await file.openFile();

            await expect(file.saveFile(savedBytes, { saveMode: 'incremental' })).resolves.toMatchObject({
                success: true,
                saveMode: 'incremental',
            });
            expect(file.lastSaveMode.value).toBe('incremental');

            file.closeFile();

            expect(file.lastSaveMode.value).toBe('rewrite');
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 2 });
            mockDocumentFiles.readFile.mockResolvedValueOnce(pdfBytes.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentFiles.saveFileStructured.mockResolvedValue({
                ok: true,
                externalWriteCommitted: true,
                workingCopyRefreshed: true,
                validation: null,
            });
            mockDocumentPdf.analyzePdfConformance
                .mockResolvedValueOnce(unsignedProfile)
                .mockImplementationOnce(() => conformanceGate.promise);

            const file = createTestPdfFile();
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

        it('checks conformance on demand and keeps the profile after native note text saves for large PDFs', async () => {
            const largePdfSize = 128 * 1024 * 1024;
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: largePdfSize });
            mockDocumentPdf.analyzePdfConformance.mockResolvedValue(unsignedProfile);
            mockDocumentFiles.savePdfNoteTextUpdates.mockResolvedValue({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native',
                    errors: [],
                    warnings: [],
                },
            });

            const file = createTestPdfFile();
            await file.loadPdfFromPath('/tmp/large.pdf');
            expect(file.pdfConformanceProfile.value).toBeNull();
            expect(mockDocumentPdf.analyzePdfConformance).not.toHaveBeenCalled();

            await expect(file.trySaveEmbeddedNoteTextUpdates([{
                objectNumber: 42,
                generationNumber: 0,
                text: 'First',
            }], {
                saveMode: 'rewrite',
                preserveLoadedSource: true,
                modifiedAt: 'D:20260609133855+03\'00\'',
            })).resolves.toMatchObject({success: true});
            expect(file.pdfConformanceProfile.value).toEqual(unsignedProfile);

            await expect(file.trySaveEmbeddedNoteTextUpdates([{
                objectNumber: 42,
                generationNumber: 0,
                text: 'Second',
            }], {
                saveMode: 'rewrite',
                preserveLoadedSource: true,
                modifiedAt: 'D:20260609133856+03\'00\'',
            })).resolves.toMatchObject({success: true});

            expect(mockDocumentFiles.savePdfNoteTextUpdates).toHaveBeenCalledTimes(2);
            expect(mockDocumentPdf.analyzePdfConformance).toHaveBeenCalledTimes(1);
            expect(file.pdfConformanceProfile.value).toEqual(unsignedProfile);
        });

        it('reuses deferred conformance analysis when native note text save starts before it settles', async () => {
            const pdfBytes = new Uint8Array([
                1,
                2,
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
            const conformanceGate = deferred<typeof unsignedProfile>();
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentPdf.analyzePdfConformance.mockImplementation(() => conformanceGate.promise);
            mockDocumentFiles.savePdfNoteTextUpdates.mockResolvedValue({
                applied: true,
                validation: {
                    isValid: true,
                    tool: 'native',
                    errors: [],
                    warnings: [],
                },
            });

            const file = createTestPdfFile();
            await file.loadPdfFromPath('/tmp/small.pdf');
            expect(file.pdfConformanceProfile.value).toBeNull();
            expect(mockDocumentPdf.analyzePdfConformance).toHaveBeenCalledTimes(1);

            const savePromise = file.trySaveEmbeddedNoteTextUpdates([{
                objectNumber: 42,
                generationNumber: 0,
                text: 'First',
            }], {
                saveMode: 'rewrite',
                preserveLoadedSource: true,
                modifiedAt: 'D:20260609133855+03\'00\'',
            });

            await Promise.resolve();
            expect(mockDocumentPdf.analyzePdfConformance).toHaveBeenCalledTimes(1);
            expect(mockDocumentFiles.savePdfNoteTextUpdates).not.toHaveBeenCalled();

            conformanceGate.resolve(unsignedProfile);
            await expect(savePromise).resolves.toMatchObject({success: true});

            expect(mockDocumentFiles.savePdfNoteTextUpdates).toHaveBeenCalledTimes(1);
            expect(mockDocumentPdf.analyzePdfConformance).toHaveBeenCalledTimes(1);
            expect(file.pdfConformanceProfile.value).toEqual(unsignedProfile);
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentPdf.analyzePdfConformance
                .mockImplementationOnce(() => staleConformanceGate.promise)
                .mockImplementationOnce(() => latestConformanceGate.promise);

            const file = createTestPdfFile();
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

            mockDocumentFiles.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstBytes.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondBytes.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocumentFiles.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return firstBytes.buffer;
                }
                if (path === '/tmp/second.pdf') {
                    return secondBytes.buffer;
                }
                throw new Error(`unexpected path ${path}`);
            });
            const saveGate = deferred<boolean>();
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentFiles.saveFileStructured.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    await saveGate.promise;
                    return {
                        ok: true,
                        externalWriteCommitted: true,
                        workingCopyRefreshed: true,
                        validation: null,
                    };
                }
                throw new Error(`unexpected save path ${path}`);
            });

            const file = createTestPdfFile();
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

            saveGate.resolve(true);
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

            mockDocumentFiles.statFile.mockResolvedValue({ size: pdfBytes.length });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);

            const file = createTestPdfFile();
            await file.loadPdfFromPath('/tmp/active.pdf');

            const result = await file.saveFile(savedBytes, { expectedWorkingPath: '/tmp/stale.pdf' });

            expect(result).toEqual({
                success: false,
                outPath: null,
                saveMode: 'rewrite',
                didSaveAs: false,
            });
            expect(mockDocumentFiles.writeFile).not.toHaveBeenCalledWith('/tmp/active.pdf', expect.any(Uint8Array));
            expect(file.workingCopyPath.value).toBe('/tmp/active.pdf');
            expect(file.pdfData.value).toEqual(pdfBytes);
        });

        it('does not apply Save As completion state after another document opens', async () => {
            const firstBytes = new Uint8Array([1]);
            const secondBytes = new Uint8Array([2]);
            const saveAsGate = deferred<string>();

            mockDocumentFiles.statFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return { size: firstBytes.length };
                }
                if (path === '/tmp/second.pdf') {
                    return { size: secondBytes.length };
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocumentFiles.readFile.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return firstBytes.buffer;
                }
                if (path === '/tmp/second.pdf') {
                    return secondBytes.buffer;
                }
                throw new Error(`unexpected path ${path}`);
            });
            mockDocumentFiles.savePdfAs.mockImplementation(async (path: string) => {
                if (path === '/tmp/first.pdf') {
                    return saveAsGate.promise;
                }
                throw new Error(`unexpected Save As path ${path}`);
            });

            const file = createTestPdfFile();
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
            expect(mockDocumentWorkingCopy.createWorkingCopyFromPath).not.toHaveBeenCalled();
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
            mockDocumentFiles.statFile.mockResolvedValue({ size: 2 });
            mockDocumentFiles.readFile.mockResolvedValue(pdfBytes.buffer);
            mockDocumentPdf.analyzePdfConformance.mockResolvedValueOnce({
                isSigned: true,
                isEncrypted: false,
                isTagged: false,
                pdfaLevel: null,
                hasAcroForm: true,
                hasXfa: false,
                canIncrementalSave: true,
                saveRestrictions: ['signed_original_requires_save_as'] as string[],
            });
            mockDocumentFiles.writeFile.mockResolvedValue(undefined);
            mockDocumentWorkingCopy.createWorkingCopyFromData.mockResolvedValue('/tmp/staged-signed.pdf');
            mockDocumentFiles.savePdfAs.mockResolvedValue('/exports/signed-copy.pdf');

            const file = createTestPdfFile();
            await file.openFile();

            const result = await file.saveFile(pdfBytes, { saveMode: 'rewrite' });

            expect(mockDocumentFiles.saveFileStructured).not.toHaveBeenCalled();
            expect(mockDocumentWorkingCopy.createWorkingCopyFromData).toHaveBeenCalledWith('signed.pdf', pdfBytes);
            expect(mockDocumentFiles.savePdfAs).toHaveBeenCalledWith(
                '/tmp/staged-signed.pdf',
                undefined,
                {expectedDocumentRevisionToken: 'revision-token'},
            );
            expect(result).toEqual({
                success: true,
                outPath: '/exports/signed-copy.pdf',
                saveMode: 'save_as_rewrite',
                didSaveAs: true,
            });
        });
    });
});
