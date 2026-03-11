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

const loggerError = vi.fn();

vi.mock('@app/utils/electron', () => ({getElectronAPI: () => ({ documents: { pageOps: pageOpsApi } })}));

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
    const reloadWorkingCopyIntoHistory = vi.fn(async () => true);
    const clearOcrCache = vi.fn();
    const resetSearchCache = vi.fn();
    const pageOps = usePageOperations({
        workingCopyPath,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
    });

    return {
        pageOps,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('usePageOperations', () => {
    it('runs mutating operations through shared progress/reload flow', async () => {
        const {
            pageOps,
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
        expect(clearOcrCache).toHaveBeenCalledWith('/tmp/work.pdf');
        expect(resetSearchCache).toHaveBeenCalledOnce();
        expect(reloadWorkingCopyIntoHistory).toHaveBeenCalledWith({ markDirty: true });
        expect(pageOps.error.value).toBeNull();
        expect(pageOps.isOperationInProgress.value).toBe(false);
    });

    it('does not reload document when extract operation is canceled', async () => {
        const {
            pageOps,
            reloadWorkingCopyIntoHistory,
            clearOcrCache,
            resetSearchCache,
        } = createHarness();
        pageOpsApi.extract.mockResolvedValueOnce({
            success: true,
            canceled: true,
        });

        await expect(pageOps.extractPages([3])).resolves.toBe(false);

        expect(reloadWorkingCopyIntoHistory).not.toHaveBeenCalled();
        expect(clearOcrCache).not.toHaveBeenCalled();
        expect(resetSearchCache).not.toHaveBeenCalled();
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
});
