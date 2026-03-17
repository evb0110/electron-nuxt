import type { Ref } from 'vue';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/platform-api';
import type { TTranslationKey } from '@i18n-app';
import { getElectronAPI } from '@app/utils/platform';
import { BrowserLogger } from '@app/utils/browser-logger';

type TPageOpsRotation = 90 | 180 | 270;
type TPageOpsResult = { success: boolean };
type TPageOperationRunner<TResult extends TPageOpsResult> = (path: TDocumentRef) => Promise<TResult>;
type TPageOperationSuccess<TResult extends TPageOpsResult> = (result: TResult) => boolean;
type TPageOperationErrorKey = Extract<
    TTranslationKey,
    | 'errors.pageOps.delete'
    | 'errors.pageOps.extract'
    | 'errors.pageOps.rotate'
    | 'errors.pageOps.insert'
    | 'errors.pageOps.insertFile'
    | 'errors.pageOps.reorder'
    | 'errors.pageOps.crop'
    | 'errors.pageOps.removeCrop'
>;

export const usePageOperations = (deps: {
    workingCopyPath: Ref<TDocumentRef | null>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
}) => {
    const { t } = useTypedI18n();

    const {
        workingCopyPath,
        reloadWorkingCopyIntoHistory,
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
        errorKey: TPageOperationErrorKey;
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
                await reloadWorkingCopyIntoHistory({ markDirty: true });
            }

            return true;
        } catch (e) {
            BrowserLogger.error('page-ops', `${options.operationName} failed`, e);
            error.value = e instanceof Error ? e.message : t(options.errorKey, undefined);
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
                return api.documents.pageOps.delete(path, [...pages], totalPages);
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
                return api.documents.pageOps.extract(path, [...pages]);
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
                return api.documents.pageOps.rotate(path, [...pages], angle);
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
                return api.documents.pageOps.insert(path, totalPages, afterPage);
            },
        });
    }

    async function insertFile(totalPages: number, afterPage: number, sourcePaths: TDocumentRef[]) {
        return runOperation({
            operationName: 'insertFile',
            errorKey: 'errors.pageOps.insertFile',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.documents.pageOps.insertFile(path, totalPages, afterPage, sourcePaths);
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
                return api.documents.pageOps.reorder(path, [...newOrder]);
            },
        });
    }

    async function cropPages(pages: number[], margins: ICropMargins) {
        if (pages.length === 0) {
            return false;
        }
        return runOperation({
            operationName: 'cropPages',
            errorKey: 'errors.pageOps.crop',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.documents.pageOps.crop(path, [...pages], margins);
            },
        });
    }

    async function removeCrop(pages: number[]) {
        if (pages.length === 0) {
            return false;
        }
        return runOperation({
            operationName: 'removeCrop',
            errorKey: 'errors.pageOps.removeCrop',
            shouldReload: true,
            run: async (path) => {
                const api = getElectronAPI();
                return api.documents.pageOps.removeCrop(path, [...pages]);
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
        cropPages,
        removeCrop,
    };
};
