import type { TDocumentRef } from '@contracts/documentRef';
import type { TDjvuPdfExportStrategy } from '@contracts/electronApiDjvu';
import type { TDocumentOpenOutcome } from '@app/types/documentOpenOutcome';
import { useDjvuMode } from '@app/composables/useDjvuMode';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    getDocumentRefBaseName,
    isBrowserDocumentRef,
} from '@app/utils/documentRef';
import { getDjvuCapability } from '@app/utils/getDjvuCapability';
import {
    getDocumentFilesCapability,
    getDocumentWorkingCopyCapability,
} from '@app/utils/platformDocuments';

interface IDjvuConversionState {
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | 'optimizing' | null;
    percent: number;
}

interface IDjvuLoadingProgress {
    current: number;
    total: number;
}

export type TOpenDjvuFile = (
    djvuPath: TDocumentRef,
    loadPdfFromPath: (path: TDocumentRef) => Promise<void>,
    getCurrentPage?: () => number,
    setPage?: (page: number) => void,
    setOriginalPath?: (path: TDocumentRef | null) => void,
    closeFile?: () => void | Promise<void>,
) => Promise<void>;

type TOpenConvertedPdf = (path: TDocumentRef) => Promise<TDocumentOpenOutcome>;

function ensurePdfSuggestedName(name: string) {
    const trimmedName = name.trim();
    const safeName = trimmedName.length > 0 ? trimmedName : 'document';
    return /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
}

export const useDjvu = () => {
    const { t } = useTypedI18n();
    const toast = useToast();

    const {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        enterDjvuMode,
        exitDjvuMode: exitDjvuModeBase,
        isDjvuFeatureDisabled,
    } = useDjvuMode();

    const conversionState = ref<IDjvuConversionState>({
        isConverting: false,
        phase: null,
        percent: 0,
    });

    const isLoadingPages = ref(false);
    const loadingProgress = ref<IDjvuLoadingProgress>({
        current: 0,
        total: 0, 
    });

    const showBanner = ref(true);
    const showConvertDialog = ref(false);
    const viewingError = ref<string | null>(null);
    const openingPath = ref<TDocumentRef | null>(null);
    const activeViewingJobId = ref<string | null>(null);
    const activeConvertJobId = ref<string | null>(null);
    const pendingConvertCancel = ref(false);

    let unsubProgress: (() => void) | null = null;
    let unsubViewingError: (() => void) | null = null;
    let openDjvuGeneration = 0;
    let conversionGeneration = 0;
    let isUnmounted = false;
    let pendingConvertCancelUntilJobId = false;
    const cancelRequestedConvertJobIds = new Set<string>();

    function logSuppressedError(action: string, error: unknown) {
        BrowserLogger.warn('djvu', action, error);
    }

    function resetViewingProgressState() {
        activeViewingJobId.value = null;
        isLoadingPages.value = false;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
    }

    function invalidatePendingDjvuOpen() {
        openDjvuGeneration += 1;
        openingPath.value = null;
        resetViewingProgressState();
    }

    function clearViewingError() {
        viewingError.value = null;
    }

    function showConversionError(message: string) {
        toast.add({
            color: 'error',
            title: t('errors.djvu.convert'),
            description: message,
        });
    }

    function trackViewingLoadingProgress(progress: {
        jobId: string;
        current?: number;
        total?: number;
        percent: number;
    }) {
        if (activeViewingJobId.value && progress.jobId !== activeViewingJobId.value) {
            return;
        }

        activeViewingJobId.value ??= progress.jobId;
        isLoadingPages.value = true;
        loadingProgress.value = {
            current: Math.max(0, progress.current ?? 0),
            total: Math.max(0, progress.total ?? 0),
        };

        if (
            progress.percent >= 100
            || (
                loadingProgress.value.total > 0
                && loadingProgress.value.current >= loadingProgress.value.total
            )
        ) {
            isLoadingPages.value = false;
        }
    }

    function isProgressForCurrentConversion(progressJobId: string) {
        return (
            conversionState.value.isConverting
            || pendingConvertCancel.value
            || pendingConvertCancelUntilJobId
            || (
                activeConvertJobId.value !== null
                && progressJobId === activeConvertJobId.value
            )
        );
    }

    function cancelConvertJob(jobId: string) {
        if (cancelRequestedConvertJobIds.has(jobId)) {
            return;
        }

        cancelRequestedConvertJobIds.add(jobId);
        void getDjvuCapability().cancel(jobId).catch((cancelError: unknown) => {
            logSuppressedError('Failed to cancel DjVu conversion job', cancelError);
        });
    }

    function consumePendingConvertCancel(jobId: string) {
        if (!pendingConvertCancel.value && !pendingConvertCancelUntilJobId) {
            return false;
        }

        activeConvertJobId.value = jobId;
        pendingConvertCancel.value = false;
        pendingConvertCancelUntilJobId = false;
        cancelConvertJob(jobId);
        if (isUnmounted) {
            teardownListeners();
        }
        return true;
    }

    async function releaseViewingPath(path: TDocumentRef | null | undefined) {
        if (!path) {
            return;
        }

        try {
            await getDjvuCapability().releaseViewingPath(path);
        } catch (error) {
            logSuppressedError('Failed to release DjVu viewing path', error);
        }
    }

    function exitDjvuMode() {
        const sourcePath = djvuSourcePath.value;
        exitDjvuModeBase();
        void releaseViewingPath(sourcePath);
    }

    function setupProgressListener() {
        if (unsubProgress) {
            return;
        }

        try {
            unsubProgress = getDjvuCapability().onProgress((progress) => {
                if (!isProgressForCurrentConversion(progress.jobId)) {
                    if (progress.phase === 'loading') {
                        trackViewingLoadingProgress(progress);
                    }
                    return;
                }

                if (activeConvertJobId.value && progress.jobId !== activeConvertJobId.value) {
                    return;
                }
                activeConvertJobId.value ??= progress.jobId;
                if (consumePendingConvertCancel(progress.jobId)) {
                    return;
                }

                isLoadingPages.value = false;
                if (progress.phase === 'loading') {
                    conversionState.value = {
                        isConverting: true,
                        phase: null,
                        percent: progress.percent,
                    };
                    return;
                }
                if (progress.phase === 'printing') {
                    return;
                }

                conversionState.value = {
                    isConverting: true,
                    phase: progress.phase,
                    percent: progress.percent,
                };
                if (progress.percent >= 100) {
                    activeConvertJobId.value = null;
                    if (!pendingConvertCancelUntilJobId) {
                        cancelRequestedConvertJobIds.clear();
                    }
                }
            });
        } catch (error) {
            logSuppressedError('DjVu progress listener unavailable', error);
        }
    }

    function setupViewingErrorListener() {
        if (unsubViewingError) {
            return;
        }

        try {
            unsubViewingError = getDjvuCapability().onViewingError((event) => {
                if (activeViewingJobId.value && event.jobId && event.jobId !== activeViewingJobId.value) {
                    return;
                }

                BrowserLogger.error('djvu', 'Background viewing conversion failed', {
                    jobId: event.jobId ?? activeViewingJobId.value,
                    error: event.error,
                });
                viewingError.value = event.error || t('errors.djvu.open');
                resetViewingProgressState();
            });
        } catch (error) {
            logSuppressedError('DjVu viewing-error listener unavailable', error);
        }
    }

    function teardownListeners(options: { preservePendingConvertCancel?: boolean } = {}) {
        const shouldPreservePendingConvertCancel = Boolean(
            options.preservePendingConvertCancel
            && (pendingConvertCancel.value || pendingConvertCancelUntilJobId),
        );

        if (unsubProgress && !shouldPreservePendingConvertCancel) {
            unsubProgress();
            unsubProgress = null;
        }
        if (unsubViewingError) {
            unsubViewingError();
            unsubViewingError = null;
        }
        resetViewingProgressState();
        if (!shouldPreservePendingConvertCancel) {
            activeConvertJobId.value = null;
            pendingConvertCancel.value = false;
            pendingConvertCancelUntilJobId = false;
            cancelRequestedConvertJobIds.clear();
        }
    }

    setupProgressListener();
    setupViewingErrorListener();
    onUnmounted(() => {
        isUnmounted = true;
        invalidatePendingDjvuOpen();
        conversionGeneration += 1;
        void cancelActiveJobs();
        void releaseViewingPath(djvuSourcePath.value);
        teardownListeners({ preservePendingConvertCancel: true });
    });

    async function openDjvuFile(
        djvuPath: TDocumentRef,
        _loadPdfFromPath: (path: TDocumentRef) => Promise<void>,
        _getCurrentPage?: () => number,
        _setPage?: (page: number) => void,
        setOriginalPath?: (path: TDocumentRef | null) => void,
        closeActivePdf?: () => void | Promise<void>,
    ) {
        const generation = ++openDjvuGeneration;
        const djvu = getDjvuCapability();
        const previousDjvuPath = djvuSourcePath.value;
        showBanner.value = true;
        clearViewingError();
        openingPath.value = djvuPath;
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;
        pendingConvertCancelUntilJobId = false;
        cancelRequestedConvertJobIds.clear();
        isLoadingPages.value = true;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };

        try {
            const result = await djvu.openForViewing(djvuPath);
            if (!result.success) {
                BrowserLogger.error('djvu', 'Open failed', result.error);
                throw new Error(result.error ?? t('errors.djvu.open'));
            }

            if (result.jobId) {
                activeViewingJobId.value = result.jobId;
            }
            loadingProgress.value = {
                current: result.pageCount ?? loadingProgress.value.current,
                total: result.pageCount ?? loadingProgress.value.total,
            };

            if (generation !== openDjvuGeneration || openingPath.value !== djvuPath) {
                await releaseViewingPath(djvuPath);
                return;
            }

            BrowserLogger.info('djvu', 'Native DjVu viewing ready', { pageCount: result.pageCount ?? 0 });
            resetViewingProgressState();
            await closeActivePdf?.();
            if (generation !== openDjvuGeneration || openingPath.value !== djvuPath) {
                await releaseViewingPath(djvuPath);
                return;
            }
            if (previousDjvuPath && previousDjvuPath !== djvuPath) {
                await releaseViewingPath(previousDjvuPath);
            }
            setOriginalPath?.(djvuPath);
            enterDjvuMode(djvuPath, null);
        } catch (e) {
            resetViewingProgressState();
            throw e;
        } finally {
            if (openingPath.value === djvuPath) {
                openingPath.value = null;
            }
        }
    }

    async function convertToPdf(
        subsample: number,
        preserveBookmarks: boolean,
        pdfStrategy: TDjvuPdfExportStrategy,
        openConvertedPdf: TOpenConvertedPdf,
    ) {
        const sourcePath = djvuSourcePath.value;
        if (!sourcePath) {
            return;
        }

        const generation = ++conversionGeneration;
        const djvu = getDjvuCapability();
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();

        const sourceBaseName = getDocumentRefBaseName(sourcePath)?.trim();
        const suggestedName = sourceBaseName
            ? ensurePdfSuggestedName(sourceBaseName.replace(/\.djvu?$/i, ''))
            : ensurePdfSuggestedName(t('djvu.documentFallback'));
        const savePath = await documentFiles.savePdfDialog(suggestedName);
        if (!savePath || generation !== conversionGeneration || djvuSourcePath.value !== sourcePath) {
            return;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;
        pendingConvertCancelUntilJobId = false;
        cancelRequestedConvertJobIds.clear();
        let shouldCleanupSavePath = true;

        BrowserLogger.info('djvu', 'Starting conversion to PDF', {
            subsample,
            preserveBookmarks,
            pdfStrategy,
        });

        try {
            clearViewingError();
            const result = await djvu.convertToPdf(
                sourcePath,
                savePath,
                {
                    subsample,
                    preserveBookmarks,
                    pdfStrategy,
                },
            );

            if (result.jobId) {
                activeConvertJobId.value = result.jobId;
                if (consumePendingConvertCancel(result.jobId)) {
                    return;
                }
            }

            if (generation !== conversionGeneration || djvuSourcePath.value !== sourcePath) {
                return;
            }

            if (!result.success || !result.pdfPath) {
                BrowserLogger.error('djvu', 'Conversion failed', result.error);
                showConversionError(result.error ?? t('errors.djvu.convert'));
                return;
            }
            shouldCleanupSavePath = false;
            BrowserLogger.info('djvu', 'Conversion completed', {
                jobId: result.jobId,
                pdfPath: result.pdfPath, 
            });

            const openResult = await openConvertedPdf(result.pdfPath);
            if (generation !== conversionGeneration) {
                return;
            }
            if (openResult && openResult.status === 'failed') {
                viewingError.value = openResult.error || t('errors.file.open');
            }
        } catch (error) {
            const message = error instanceof Error && error.message.trim().length > 0
                ? error.message
                : t('errors.djvu.convert');
            BrowserLogger.error('djvu', 'Conversion crashed', {
                path: sourcePath,
                error,
            });
            showConversionError(message);
        } finally {
            activeConvertJobId.value = null;
            pendingConvertCancel.value = false;
            pendingConvertCancelUntilJobId = false;
            cancelRequestedConvertJobIds.clear();
            conversionState.value = {
                isConverting: false,
                phase: null,
                percent: 0,
            };
            if (shouldCleanupSavePath && isBrowserDocumentRef(savePath)) {
                await documentWorkingCopy.cleanupFile(savePath).catch((cleanupError: unknown) => {
                    logSuppressedError('Failed to cleanup DjVu browser output ref', cleanupError);
                });
            }
            if (isUnmounted) {
                teardownListeners();
            }
        }
    }

    async function cancelActiveJobs() {
        if (
            conversionState.value.isConverting
            || activeConvertJobId.value
            || pendingConvertCancel.value
            || pendingConvertCancelUntilJobId
        ) {
            conversionGeneration += 1;
        }
        const ids = new Set<string>();
        if (activeViewingJobId.value) {
            ids.add(activeViewingJobId.value);
        }
        if (activeConvertJobId.value) {
            ids.add(activeConvertJobId.value);
        }
        BrowserLogger.info('djvu', 'Cancelling active jobs', { jobIds: [...ids] });
        if (ids.size === 0) {
            if (conversionState.value.isConverting) {
                pendingConvertCancel.value = true;
                pendingConvertCancelUntilJobId = true;
                return true;
            }
            return false;
        }

        try {
            await Promise.all(Array.from(ids, async (jobId) => {
                try {
                    await getDjvuCapability().cancel(jobId);
                    if (jobId === activeConvertJobId.value) {
                        cancelRequestedConvertJobIds.add(jobId);
                    }
                } catch (cancelError) {
                    logSuppressedError(`Failed to cancel DjVu job ${jobId}`, cancelError);
                }
            }));
        } catch (error) {
            logSuppressedError('Failed to cancel active DjVu jobs', error);
            return false;
        }

        activeViewingJobId.value = null;
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;
        pendingConvertCancelUntilJobId = false;
        isLoadingPages.value = false;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };
        conversionState.value = {
            isConverting: false,
            phase: null,
            percent: 0,
        };
        return true;
    }

    async function cleanupDjvuTemp() {
        if (!djvuTempPdfPath.value) {
            return;
        }

        try {
            await getDjvuCapability().cleanupTemp(djvuTempPdfPath.value);
        } catch (cleanupError) {
            logSuppressedError('Failed to cleanup DjVu temp PDF', cleanupError);
        }
    }

    function openConvertDialog() {
        if (!isDjvuMode.value) {
            return;
        }
        showConvertDialog.value = true;
    }

    function closeConvertDialog() {
        showConvertDialog.value = false;
    }

    function dismissBanner() {
        showBanner.value = false;
    }

    return {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        conversionState,
        isLoadingPages,
        loadingProgress,
        showBanner,
        showConvertDialog,
        viewingError,
        openingPath,
        isDjvuFeatureDisabled,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf,
        cancelActiveJobs,
        cleanupDjvuTemp,
        exitDjvuMode,
        openConvertDialog,
        closeConvertDialog,
        dismissBanner,
        clearViewingError,
    };
};
