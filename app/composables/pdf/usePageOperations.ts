import type { Ref } from 'vue';
import { clamp } from 'es-toolkit/math';
import type { ICropMargins } from '@app/types/crop';
import type { TDocumentRef } from '@contracts/platformApi';
import type { TTranslationKey } from '@i18n-app';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    getDocumentsCapability,
    getPageOpsCapability,
} from '@app/utils/platformDocuments';

type TPageOpsRotation = 90 | 180 | 270;
interface IPageOpsResult {success: boolean;}
type TPageOperationRunner<TResult extends IPageOpsResult> = (path: TDocumentRef) => Promise<TResult>;
type TPageOperationSuccess<TResult extends IPageOpsResult> = (result: TResult) => boolean;

interface IPageOperationBatchProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

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
    ensureHistoryBaselineForExternalMutation: () => Promise<boolean>;
    reloadWorkingCopyIntoHistory: (opts?: { markDirty?: boolean }) => Promise<boolean>;
    clearOcrCache: (path: TDocumentRef) => void;
    resetSearchCache: () => void;
    onExtractedDocument?: (path: TDocumentRef) => Promise<void> | void;
}) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const { reportRuntimeError } = useRuntimeErrorReports();
    const {
        workingCopyPath,
        ensureHistoryBaselineForExternalMutation,
        reloadWorkingCopyIntoHistory,
        clearOcrCache,
        resetSearchCache,
        onExtractedDocument,
    } = deps;

    const isOperationInProgress = ref(false);
    const error = ref<string | null>(null);
    const batchProgress = ref<IPageOperationBatchProgress | null>(null);

    function invalidateCaches(path: TDocumentRef) {
        clearOcrCache(path);
        resetSearchCache();
    }

    async function runOperation<TResult extends IPageOpsResult>(options: {
        operationName: string;
        errorKey: TPageOperationErrorKey;
        run: TPageOperationRunner<TResult>;
        shouldReload?: boolean;
        isSuccessful?: TPageOperationSuccess<TResult>;
        onSuccess?: (result: TResult) => Promise<void> | void;
    }) {
        const path = workingCopyPath.value;
        if (!path) {
            return false;
        }
        if (isOperationInProgress.value) {
            BrowserLogger.warn('page-ops', `Skipped overlapping ${options.operationName} request`, { operationName: options.operationName });
            return false;
        }

        isOperationInProgress.value = true;
        error.value = null;

        try {
            if (options.shouldReload) {
                const didPrimeHistory = await ensureHistoryBaselineForExternalMutation();
                if (!didPrimeHistory) {
                    return false;
                }
                if (workingCopyPath.value !== path) {
                    return false;
                }
            }

            const result = await options.run(path);
            const isSuccessful = options.isSuccessful ?? ((apiResult) => apiResult.success);
            if (!isSuccessful(result)) {
                return false;
            }

            if (workingCopyPath.value !== path) {
                return false;
            }

            if (options.shouldReload) {
                invalidateCaches(path);
                await reloadWorkingCopyIntoHistory({ markDirty: true });
            }

            await options.onSuccess?.(result);

            return true;
        } catch (e) {
            BrowserLogger.error('page-ops', `${options.operationName} failed`, e);
            reportRuntimeError({
                title: t(options.errorKey, undefined),
                source: `page-ops:${options.operationName}`,
                error: e,
            });
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

        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'deletePages',
            errorKey: 'errors.pageOps.delete',
            shouldReload: true,
            run: (path) => getPageOpsCapability().delete(path, [...pages], totalPages),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'delete',
                totalPagesBefore: totalPages,
            });
        }
        return didSucceed;
    }

    async function extractPages(pages: number[]) {
        if (pages.length === 0) {
            return false;
        }

        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'extractPages',
            errorKey: 'errors.pageOps.extract',
            run: (path) => getPageOpsCapability().extract(path, [...pages]),
            isSuccessful: result => result.success && !result.canceled,
            onSuccess: async (result) => {
                if (result.destPath) {
                    await onExtractedDocument?.(result.destPath);
                }
            },
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'extract',
            });
        }
        return didSucceed;
    }

    async function rotatePages(pages: number[], angle: TPageOpsRotation) {
        if (pages.length === 0) {
            return false;
        }

        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'rotatePages',
            errorKey: 'errors.pageOps.rotate',
            shouldReload: true,
            run: (path) => getPageOpsCapability().rotate(path, [...pages], angle),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pages.length,
                angle,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'rotate',
            });
        }
        return didSucceed;
    }

    async function insertPages(totalPages: number, afterPage: number) {
        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'insertPages',
            errorKey: 'errors.pageOps.insert',
            shouldReload: true,
            run: (path) => getPageOpsCapability().insert(path, totalPages, afterPage),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                afterPage,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'insert_blank',
            });
        }
        return didSucceed;
    }

    async function insertFile(totalPages: number, afterPage: number, sourcePaths: TDocumentRef[]) {
        const startedAt = Date.now();
        const requestId = sourcePaths.length > 1
            ? `browser-page-op-insert-${crypto.randomUUID()}`
            : undefined;
        const stopProgress = requestId
            ? getDocumentsCapability().onOpenPdfDirectBatchProgress((progress) => {
                if (progress.requestId !== requestId) {
                    return;
                }

                batchProgress.value = {
                    processed: Math.max(0, progress.processed),
                    total: Math.max(0, progress.total),
                    percent: clamp(progress.percent, 0, 100),
                    elapsedMs: Math.max(0, progress.elapsedMs),
                    estimatedRemainingMs:
                        typeof progress.estimatedRemainingMs === 'number'
                            ? Math.max(0, progress.estimatedRemainingMs)
                            : null,
                };
            })
            : null;

        if (requestId) {
            batchProgress.value = {
                processed: 0,
                total: sourcePaths.length,
                percent: 0,
                elapsedMs: 0,
                estimatedRemainingMs: null,
            };
        }

        try {
            const didSucceed = await runOperation({
                operationName: 'insertFile',
                errorKey: 'errors.pageOps.insertFile',
                shouldReload: true,
                run: (path) => getPageOpsCapability().insertFile(
                    path,
                    totalPages,
                    afterPage,
                    sourcePaths,
                    requestId,
                ),
            });
            if (didSucceed) {
                analytics.track('page_operation_completed', {
                    afterPage,
                    durationMs: Math.max(0, Date.now() - startedAt),
                    operation: 'insert_file',
                    sourceFileCount: sourcePaths.length,
                });
            }
            return didSucceed;
        } finally {
            stopProgress?.();
            batchProgress.value = null;
        }
    }

    async function reorderPages(newOrder: number[]) {
        if (newOrder.length === 0) {
            return false;
        }

        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'reorderPages',
            errorKey: 'errors.pageOps.reorder',
            shouldReload: true,
            run: (path) => getPageOpsCapability().reorder(path, [...newOrder]),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: newOrder.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'reorder',
            });
        }
        return didSucceed;
    }

    async function cropPages(pages: number[], margins: ICropMargins) {
        if (pages.length === 0) {
            return false;
        }
        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'cropPages',
            errorKey: 'errors.pageOps.crop',
            shouldReload: true,
            run: (path) => getPageOpsCapability().crop(path, [...pages], margins),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'crop',
            });
        }
        return didSucceed;
    }

    async function removeCrop(pages: number[]) {
        if (pages.length === 0) {
            return false;
        }
        const startedAt = Date.now();
        const didSucceed = await runOperation({
            operationName: 'removeCrop',
            errorKey: 'errors.pageOps.removeCrop',
            shouldReload: true,
            run: (path) => getPageOpsCapability().removeCrop(path, [...pages]),
        });
        if (didSucceed) {
            analytics.track('page_operation_completed', {
                affectedPageCount: pages.length,
                durationMs: Math.max(0, Date.now() - startedAt),
                operation: 'remove_crop',
            });
        }
        return didSucceed;
    }

    return {
        isOperationInProgress,
        error,
        batchProgress,
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
