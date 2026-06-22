import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import type * as TVueModule from 'vue';

vi.mock('vue', async (importOriginal) => {
    const actual = await importOriginal<typeof TVueModule>();
    return {
        ...actual,
        onUnmounted: vi.fn(),
    };
});

interface IViewingErrorData {
    error: string;
    jobId?: string;
}

const mockElectronAPI = {
    djvu: {
        onProgress: vi.fn(() => vi.fn()),
        onViewingReady: vi.fn(() => vi.fn()),
        onViewingError: vi.fn((_callback: (data: IViewingErrorData) => void) => vi.fn()),
        openForViewing: vi.fn(),
        releaseViewingPath: vi.fn(),
        convertToPdf: vi.fn(),
        cancel: vi.fn(),
        cleanupTemp: vi.fn(),
    },
    documents: {
        setWindowTitle: vi.fn(),
        savePdfDialog: vi.fn(),
        openPdfDirect: vi.fn(),
        cleanupFile: vi.fn(),
    },
};

const mockDjvuModeState = {
    isDjvuMode: ref(false),
    djvuSourcePath: ref<string | null>(null),
    djvuTempPdfPath: ref<string | null>(null),
};

vi.mock('@app/utils/platform', () => ({getPlatformAPI: () => mockElectronAPI}));

vi.mock('@app/composables/useDjvuMode', () => {
    const enterDjvuMode = vi.fn((source: string, temp: string | null = null) => {
        mockDjvuModeState.isDjvuMode.value = true;
        mockDjvuModeState.djvuSourcePath.value = source;
        mockDjvuModeState.djvuTempPdfPath.value = temp;
    });
    const exitDjvuMode = vi.fn(() => {
        mockDjvuModeState.isDjvuMode.value = false;
        mockDjvuModeState.djvuSourcePath.value = null;
        mockDjvuModeState.djvuTempPdfPath.value = null;
    });

    return {useDjvuMode: () => ({
        isDjvuMode: mockDjvuModeState.isDjvuMode,
        djvuSourcePath: mockDjvuModeState.djvuSourcePath,
        djvuTempPdfPath: mockDjvuModeState.djvuTempPdfPath,
        isDjvuFeatureDisabled: vi.fn(() => false),
        enterDjvuMode,
        exitDjvuMode,
    })};
});

const { useDjvu } = await import('@app/composables/useDjvu');

function createUnusedConvertedPdfOpen() {
    return vi.fn(async () => ({status: 'cancelled' as const}));
}

describe('useDjvu', () => {
    let viewingErrorCallback: ((data: IViewingErrorData) => void) | null = null;

    beforeEach(() => {
        vi.clearAllMocks();
        mockDjvuModeState.isDjvuMode.value = false;
        mockDjvuModeState.djvuSourcePath.value = null;
        mockDjvuModeState.djvuTempPdfPath.value = null;
        mockElectronAPI.djvu.onProgress.mockReturnValue(vi.fn());
        mockElectronAPI.djvu.onViewingReady.mockReturnValue(vi.fn());
        mockElectronAPI.documents.cleanupFile.mockResolvedValue(undefined);
        viewingErrorCallback = null;
        mockElectronAPI.djvu.onViewingError.mockImplementation((callback: (data: IViewingErrorData) => void) => {
            viewingErrorCallback = callback;
            return vi.fn();
        });
    });

    describe('openDjvuFile', () => {
        it('opens a single-page DjVu file', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'job-1',
            });

            const djvu = useDjvu();
            const loadPdf = vi.fn(async () => {});

            await djvu.openDjvuFile(
                '/path/to/doc.djvu',
                loadPdf,
            );

            expect(loadPdf).not.toHaveBeenCalled();
            expect(mockElectronAPI.documents.setWindowTitle).not.toHaveBeenCalled();
            expect(djvu.isLoadingPages.value).toBe(false);
        });

        it('leaves window title sync to the workspace shell', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'job-encoded',
            });

            const djvu = useDjvu();
            const loadPdf = vi.fn(async () => {});

            await djvu.openDjvuFile(
                'browser://documents/source/%25D0%2593%25D0%25BB%25D0%25B0%25D0%25B2%25D0%25B0.djvu',
                loadPdf,
            );

            expect(mockElectronAPI.documents.setWindowTitle).not.toHaveBeenCalled();
        });

        it('throws when openForViewing fails', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: false,
                error: 'File corrupted',
            });

            const djvu = useDjvu();

            await expect(
                djvu.openDjvuFile('/bad.djvu', vi.fn()),
            ).rejects.toThrow('File corrupted');
        });

        it('sets loading state for multi-page files', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 10,
                jobId: 'job-multi',
            });

            const djvu = useDjvu();
            const loadPdf = vi.fn(async () => {});

            await djvu.openDjvuFile('/multi.djvu', loadPdf);

            expect(loadPdf).not.toHaveBeenCalled();
            expect(djvu.isLoadingPages.value).toBe(false);
            expect(djvu.loadingProgress.value.total).toBe(0);
        });

        it('tracks the opening path until DjVu mode is fully entered', async () => {
            let resolveOpen: ((value: {
                success: boolean;
                pageCount: number;
                jobId: string;
            }) => void) | null = null;
            mockElectronAPI.djvu.openForViewing.mockImplementation(() => new Promise((resolve) => {
                resolveOpen = resolve;
            }));

            const djvu = useDjvu();
            const openPromise = djvu.openDjvuFile('/pending.djvu', vi.fn(async () => {}));

            expect(djvu.openingPath.value).toBe('/pending.djvu');

            expect(resolveOpen).not.toBeNull();
            resolveOpen!({
                success: true,
                pageCount: 3,
                jobId: 'job-pending',
            });
            await openPromise;

            expect(djvu.openingPath.value).toBeNull();
        });

        it('releases the previous DjVu viewing path when switching files', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 2,
                jobId: 'job-next',
            });
            mockDjvuModeState.isDjvuMode.value = true;
            mockDjvuModeState.djvuSourcePath.value = '/existing.djvu';

            const djvu = useDjvu();

            await djvu.openDjvuFile('/next.djvu', vi.fn(async () => {}));

            expect(mockElectronAPI.djvu.releaseViewingPath).toHaveBeenCalledWith('/existing.djvu');
        });
    });

    describe('cancelActiveJobs', () => {
        it('sets pendingConvertCancel when converting but no job ID yet', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'v-1',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/a.djvu', vi.fn(async () => {}));

            djvu.conversionState.value = {
                isConverting: true,
                phase: 'converting',
                percent: 50,
            };

            const result = await djvu.cancelActiveJobs();

            expect(result).toBe(true);
        });
    });

    describe('convertToPdf', () => {
        it('suggests a PDF name from the DjVu source file without using localized fallback text', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue(null);

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, createUnusedConvertedPdfOpen());

            expect(mockElectronAPI.documents.savePdfDialog).toHaveBeenCalledWith('input.pdf');
        });

        it('turns the DjVu fallback into a PDF suggestion only when the source has no basename', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue(null);

            const djvu = useDjvu();
            await djvu.openDjvuFile('browser://documents/source/', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, createUnusedConvertedPdfOpen());

            expect(mockElectronAPI.documents.savePdfDialog).toHaveBeenCalledWith('djvu.documentFallback.pdf');
        });

        it('shows a conversion error without cleaning filesystem save paths', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockElectronAPI.djvu.convertToPdf.mockResolvedValue({
                success: false,
                error: 'Windows converter failed',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, createUnusedConvertedPdfOpen());

            expect(djvu.viewingError.value).toBe('Windows converter failed');
            expect(djvu.conversionState.value.isConverting).toBe(false);
            expect(mockElectronAPI.documents.cleanupFile).not.toHaveBeenCalled();
        });

        it('cleans up browser conversion output refs after conversion errors', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue('browser://documents/output/out.pdf');
            mockElectronAPI.djvu.convertToPdf.mockResolvedValue({
                success: false,
                error: 'Browser converter failed',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, createUnusedConvertedPdfOpen());

            expect(djvu.viewingError.value).toBe('Browser converter failed');
            expect(mockElectronAPI.documents.cleanupFile)
                .toHaveBeenCalledWith('browser://documents/output/out.pdf');
        });

        it('opens the converted PDF through the workspace direct-open flow', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockElectronAPI.djvu.convertToPdf.mockResolvedValue({
                success: true,
                pdfPath: '/tmp/out.pdf',
                jobId: 'convert-1',
            });
            const openConvertedPdf = vi.fn(async () => ({
                status: 'opened' as const,
                result: {
                    kind: 'pdf' as const,
                    originalPath: '/tmp/out.pdf',
                    workingPath: '/tmp/out-working.pdf',
                },
            }));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, openConvertedPdf);

            expect(openConvertedPdf).toHaveBeenCalledWith('/tmp/out.pdf');
            expect(djvu.conversionState.value.isConverting).toBe(false);
        });

        it('shows the direct-open error when a converted PDF cannot be opened', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 1,
                jobId: 'view-1',
            });
            mockElectronAPI.documents.savePdfDialog.mockResolvedValue('/tmp/out.pdf');
            mockElectronAPI.djvu.convertToPdf.mockResolvedValue({
                success: true,
                pdfPath: '/tmp/out.pdf',
                jobId: 'convert-1',
            });
            const openConvertedPdf = vi.fn(async () => ({
                status: 'failed' as const,
                error: 'Converted PDF could not be opened',
            }));

            const djvu = useDjvu();
            await djvu.openDjvuFile('/tmp/input.djvu', vi.fn(async () => {}));
            await djvu.convertToPdf(1, true, openConvertedPdf);

            expect(openConvertedPdf).toHaveBeenCalledWith('/tmp/out.pdf');
            expect(djvu.viewingError.value).toBe('Converted PDF could not be opened');
        });
    });

    describe('listener setup', () => {
        it('shows background viewing errors and exits loading state', async () => {
            mockElectronAPI.djvu.openForViewing.mockResolvedValue({
                success: true,
                pageCount: 5,
                jobId: 'job-view-1',
            });

            const djvu = useDjvu();
            await djvu.openDjvuFile('/multi.djvu', vi.fn(async () => {}));

            djvu.isLoadingPages.value = true;
            viewingErrorCallback?.({
                jobId: 'job-view-1',
                error: 'Background conversion failed',
            });

            expect(djvu.isLoadingPages.value).toBe(false);
            expect(djvu.viewingError.value).toBe('Background conversion failed');
        });
    });
});
