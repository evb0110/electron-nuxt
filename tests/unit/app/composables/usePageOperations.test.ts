import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { usePageOperations } from '@app/composables/pdf/usePageOperations';

const pageOpsApi = {
    delete: vi.fn(),
    extract: vi.fn(),
    rotate: vi.fn(),
    insert: vi.fn(),
    insertFile: vi.fn(),
    reorder: vi.fn(),
    crop: vi.fn(),
    removeCrop: vi.fn(),
};

type TBatchProgressListener = (progress: {
    requestId: string;
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}) => void;

const progressListeners = new Set<TBatchProgressListener>();

const loggerError = vi.fn();

vi.mock('@app/utils/platform-documents', () => ({
    getPageOpsCapability: () => pageOpsApi,
    getDocumentsCapability: () => ({onOpenPdfDirectBatchProgress: (callback: TBatchProgressListener) => {
        progressListeners.add(callback);
        return () => {
            progressListeners.delete(callback);
        };
    }}),
}));

vi.mock('@app/utils/browser-logger', () => ({BrowserLogger: {error: (...args: unknown[]) => loggerError(...args)}}));

vi.mock('@app/composables/useTypedI18n', () => ({useTypedI18n: () => ({
    t: (key: string) => `msg:${key}`,
    setLocale: vi.fn(async () => {}),
    loadLocaleMessages: vi.fn(async () => {}),
})}));

function deferred<T>() {
    let resolve: ((value: T | PromiseLike<T>) => void) | null = null;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });

    return {
        promise,
        resolve: (value: T) => resolve?.(value),
    };
}

function createHarness(path: string | null = '/tmp/work.pdf') {
    const workingCopyPath = ref<string | null>(path);
    const ensureHistoryBaselineForExternalMutation = vi.fn(async () => true);
    const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
    const clearOcrCache = vi.fn();
    const resetSearchCache = vi.fn();
    const onExtractedDocument = vi.fn(async () => {});
    const pageOps = usePageOperations({
        workingCopyPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
    });

    return {
        pageOps,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    progressListeners.clear();
});

describe('usePageOperations', () => {
    it('runs mutating operations through shared progress/reload flow', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
        } = createHarness();
        const pendingRotate = deferred<{ success: boolean }>();
        pageOpsApi.rotate.mockReturnValueOnce(pendingRotate.promise);

        const rotatePromise = pageOps.rotatePages([
            2,
            4,
        ], 90);
        expect(pageOps.isOperationInProgress.value).toBe(true);

        pendingRotate.resolve({ success: true });
        await expect(rotatePromise).resolves.toBe(true);

        expect(pageOpsApi.rotate).toHaveBeenCalledWith('/tmp/work.pdf', [
            2,
            4,
        ], 90);
        expect(ensureHistoryBaselineForExternalMutation).toHaveBeenCalledOnce();
        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
        expect(pageOps.error.value).toBeNull();
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('does not reload document when extract operation is canceled', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
            onExtractedDocument,
        } = createHarness();
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            canceled: true,
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(false);

        expect(ensureHistoryBaselineForExternalMutation).not.toHaveBeenCalled();
        expect(reloadWorkingCopyIntoHistory).not.toHaveBeenCalled();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(onExtractedDocument).not.toHaveBeenCalled();
    });

    it('opens the extracted PDF when the page-op returns a destination path', async () => {
        const {
            pageOps,
            ensureHistoryBaselineForExternalMutation,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
            onExtractedDocument,
        } = createHarness();
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            destPath: 'browser://documents/extract.pdf',
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(true);

        expect(pageOpsApi.extract).toHaveBeenCalledWith('/tmp/work.pdf', [3]);
        expect(ensureHistoryBaselineForExternalMutation).not.toHaveBeenCalled();
        expect(reloadWorkingCopyIntoHistory).not.toHaveBeenCalled();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
        expect(onExtractedDocument).toHaveBeenCalledWith('browser://documents/extract.pdf');
    });

    it('rejects deleting all pages before calling electron API', async () => {
        const { pageOps } = createHarness();

        await expect(pageOps.deletePages([
            1,
            2,
        ], 2)).resolves.toBe(false);

        expect(pageOpsApi.delete).not.toHaveBeenCalled();
        expect(pageOps.error.value).toBe('msg:errors.pageOps.deleteAll');
    });

    it('writes localized fallback error message when operation throws a non-Error value', async () => {
        const { pageOps } = createHarness();
        pageOpsApi.insert.mockRejectedValueOnce('ipc failed');

        await expect(pageOps.insertPages(5, 0)).resolves.toBe(false);

        expect(loggerError).toHaveBeenCalledWith('page-ops', 'insertPages failed', 'ipc failed');
        expect(pageOps.error.value).toBe('msg:errors.pageOps.insert');
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('exits early when working copy path is unavailable', async () => {
        const { pageOps } = createHarness(null);

        await expect(pageOps.reorderPages([
            2,
            1,
        ])).resolves.toBe(false);

        expect(pageOpsApi.reorder).not.toHaveBeenCalled();
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('tracks browser combine progress during multi-file insert jobs', async () => {
        const { pageOps } = createHarness();
        const pendingInsert = deferred<{ success: boolean }>();
        pageOpsApi.insertFile.mockImplementationOnce(
            async (
                _path: string,
                _totalPages: number,
                _afterPage: number,
                _sourcePaths: string[],
                requestId?: string,
            ) => {
                if (!requestId) {
                    throw new Error('Expected requestId for multi-file insert');
                }

                progressListeners.forEach((listener) => {
                    listener({
                        requestId,
                        processed: 2,
                        total: 3,
                        percent: 66,
                        elapsedMs: 1200,
                        estimatedRemainingMs: 600,
                    });
                });

                return pendingInsert.promise;
            },
        );

        const insertPromise = pageOps.insertFile(5, 2, [
            'browser://documents/a.pdf',
            'browser://documents/b.png',
            'browser://documents/c.pdf',
        ]);
        await Promise.resolve();

        expect(pageOps.batchProgress.value).toEqual({
            processed: 2,
            total: 3,
            percent: 66,
            elapsedMs: 1200,
            estimatedRemainingMs: 600,
        });

        pendingInsert.resolve({ success: true });
        await expect(insertPromise).resolves.toBe(true);

        expect(pageOpsApi.insertFile).toHaveBeenCalledWith(
            '/tmp/work.pdf',
            5,
            2,
            [
                'browser://documents/a.pdf',
                'browser://documents/b.png',
                'browser://documents/c.pdf',
            ],
            expect.stringMatching(/^browser-page-op-insert-/u),
        );
        expect(pageOps.batchProgress.value).toBeNull();
    });
});
