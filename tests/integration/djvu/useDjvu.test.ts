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

vi.mock('@app/utils/platform', () => ({
    getPlatformAPI: () => mockElectronAPI,
    getElectronAPI: () => mockElectronAPI,
}));

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

const mockT = vi.fn((key: string) => key);
vi.stubGlobal('useI18n', () => ({ t: mockT }));

const { useDjvu } = await import('@app/composables/useDjvu');

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

    describe('initial state', () => {
        it('starts with no conversion in progress', () => {
            const djvu = useDjvu();

            expect(djvu.conversionState.value.isConverting).toBe(false);
            expect(djvu.conversionState.value.phase).toBeNull();
            expect(djvu.conversionState.value.percent).toBe(0);
        });

        it('starts with loading not active', () => {
            const djvu = useDjvu();

            expect(djvu.isLoadingPages.value).toBe(false);
        });

        it('starts with banner visible', () => {
            const djvu = useDjvu();

            expect(djvu.showBanner.value).toBe(true);
        });

        it('starts with convert dialog closed', () => {
            const djvu = useDjvu();

            expect(djvu.showConvertDialog.value).toBe(false);
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
        it('returns false when no active jobs exist and not converting', async () => {
            const djvu = useDjvu();

            const result = await djvu.cancelActiveJobs();

            expect(result).toBe(false);
        });

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

    describe('dialog management', () => {
        it('opens and closes the convert dialog', () => {
            const djvu = useDjvu();

            djvu.openConvertDialog();
            expect(djvu.showConvertDialog.value).toBe(true);

            djvu.closeConvertDialog();
            expect(djvu.showConvertDialog.value).toBe(false);
        });

        it('dismisses the banner', () => {
            const djvu = useDjvu();

            djvu.dismissBanner();
            expect(djvu.showBanner.value).toBe(false);
        });
    });

    describe('convertToPdf', () => {
        it('shows a conversion error instead of failing silently', async () => {
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
            await djvu.convertToPdf(1, true, vi.fn(async () => {}));

            expect(djvu.viewingError.value).toBe('Windows converter failed');
            expect(djvu.conversionState.value.isConverting).toBe(false);
            expect(mockElectronAPI.documents.cleanupFile).toHaveBeenCalledWith('/tmp/out.pdf');
        });
    });

    describe('listener setup', () => {
        it('sets up progress and viewing listeners on creation', () => {
            useDjvu();

            expect(mockElectronAPI.djvu.onProgress).toHaveBeenCalled();
            expect(mockElectronAPI.djvu.onViewingReady).toHaveBeenCalled();
            expect(mockElectronAPI.djvu.onViewingError).toHaveBeenCalled();
        });

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
