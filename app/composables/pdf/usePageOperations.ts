import type { Ref } from 'vue';
import { getElectronAPI } from '@app/utils/electron';
import { BrowserLogger } from '@app/utils/browser-logger';

type TPageOpsRotation = 90 | 180 | 270;
type TPageOpsResult = { success: boolean };
type TPageOperationRunner<TResult extends TPageOpsResult> = (path: string) => Promise<TResult>;
type TPageOperationSuccess<TResult extends TPageOpsResult> = (result: TResult) => boolean;

export const usePageOperations = (deps: {
    workingCopyPath: Ref<string | null>;
    loadPdfFromPath: (path: string, opts?: { markDirty?: boolean }) => Promise<void>;
    clearOcrCache: (path: string) => void;
    resetSearchCache: () => void;
}) => {
    const { t } = useTypedI18n();

    const {
        workingCopyPath,
        loadPdfFromPath,
        clearOcrCache,
        resetSearchCache,
    } = deps;

    const isOperationInProgress = ref(false);
    const error = ref<string | null>(null);

    function invalidateCaches() {
        if (workingCopyPath.value) {
            clearOcrCache(workingCopyPath.value);
        }
        resetSearchCache();
    }

    async function runOperation<TResult extends TPageOpsResult>(options: {
        operationName: string;
        errorKey: Parameters<typeof t>[0];
        run: TPageOperationRunner<TResult>;
        shouldReload?: boolean;
        isSuccessful?: TPageOperationSuccess<TResult>;
    }) {
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;

        try {
            const result = await options.run(path);
            const isSuccessful = options.isSuccessful ?? ((apiResult) => apiResult.success);
            if (!isSuccessful(result)) {
                return false;
            }

            if (options.shouldReload) {
                invalidateCaches();
                await loadPdfFromPath(path, { markDirty: true });
            }

            return true;
        } catch (e) {
            BrowserLogger.error('page-ops', `${options.operationName} failed`, e);
            error.value = e instanceof Error ? e.message : t(options.errorKey);
            return false;
        } finally {
            isOperationInProgress.value = false;
        }
    }

    async function deletePages(pages: number[], totalPages: number) {
        if (pages.length === 0) {
            return false;
        }
        if (pages.length >= totalPages) {
            error.value = t('errors.pageOps.deleteAll');
            return false;
        }

        return runOperation({
            operationName: 'deletePages',
            errorKey: 'errors.pageOps.delete',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.delete(path, [...pages], totalPages);
            },
        });
    }

    async function extractPages(pages: number[]) {
        if (pages.length === 0) {
            return false;
        }

        return runOperation({
            operationName: 'extractPages',
            errorKey: 'errors.pageOps.extract',
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.extract(path, [...pages]);
            },
            isSuccessful: result => result.success && !result.canceled,
        });
    }

    async function rotatePages(pages: number[], angle: TPageOpsRotation) {
        if (pages.length === 0) {
            return false;
        }

        return runOperation({
            operationName: 'rotatePages',
            errorKey: 'errors.pageOps.rotate',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.rotate(path, [...pages], angle);
            },
        });
    }

    async function insertPages(totalPages: number, afterPage: number) {
        return runOperation({
            operationName: 'insertPages',
            errorKey: 'errors.pageOps.insert',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.insert(path, totalPages, afterPage);
            },
        });
    }

    async function insertFile(totalPages: number, afterPage: number, sourcePaths: string[]) {
        return runOperation({
            operationName: 'insertFile',
            errorKey: 'errors.pageOps.insertFile',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.insertFile(path, totalPages, afterPage, sourcePaths);
            },
        });
    }

    async function reorderPages(newOrder: number[]) {
        if (newOrder.length === 0) {
            return false;
        }

        return runOperation({
            operationName: 'reorderPages',
            errorKey: 'errors.pageOps.reorder',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.pageOps.reorder(path, [...newOrder]);
            },
        });
    }

    return {
        isOperationInProgress,
        error,
        deletePages,
        extractPages,
        rotatePages,
        insertPages,
        insertFile,
        reorderPages,
    };
};
