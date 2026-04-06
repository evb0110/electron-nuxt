import type { TDocumentRef } from '@contracts/platform-api';
import { getElectronAPI } from '@app/utils/platform';
import { useDjvuMode } from '@app/composables/useDjvuMode';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getDocumentRefBaseName } from '@app/utils/document-ref';

interface IDjvuConversionState {
    isConverting: boolean;
    phase: 'converting' | 'bookmarks' | null;
    percent: number;
}

interface IDjvuLoadingProgress {
    current: number;
    total: number;
}

export const useDjvu = () => {
    const { t } = useTypedI18n();

    const {
        isDjvuMode,
        djvuSourcePath,
        djvuTempPdfPath,
        enterDjvuMode,
        exitDjvuMode,
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
    let unsubViewingReady: (() => void) | null = null;
    let unsubViewingError: (() => void) | null = null;
    let swapHandler: ((event: {
        pdfPath: TDocumentRef;
        isPartial: boolean 
    }) => void) | null = null;

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
        swapHandler = null;
    }

    function clearViewingError() {
        viewingError.value = null;
    }

    function setupProgressListener() {
        if (unsubProgress) {
            return;
        }

        try {
            const api = getElectronAPI();
            unsubProgress = api.djvu.onProgress((progress) => {
                if (progress.phase === 'loading') {
                    if (activeViewingJobId.value && progress.jobId !== activeViewingJobId.value) {
                        return;
                    }
                    if (!activeViewingJobId.value) {
                        activeViewingJobId.value = progress.jobId;
                    }
                    if (isLoadingPages.value) {
                        loadingProgress.value = {
                            current: progress.current ?? 0,
                            total: progress.total ?? 0,
                        };
                    }
                } else {
                    const isTrackingCurrentJob = (
                        conversionState.value.isConverting
                        || pendingConvertCancel.value
                        || (
                            activeConvertJobId.value !== null
                            && progress.jobId === activeConvertJobId.value
                        )
                    );

                    if (!isTrackingCurrentJob) {
                        return;
                    }

                    if (pendingConvertCancel.value) {
                        activeConvertJobId.value = progress.jobId;
                        pendingConvertCancel.value = false;
                        void api.djvu.cancel(progress.jobId).catch((cancelError: unknown) => {
                            logSuppressedError('Failed to cancel DjVu conversion job', cancelError);
                        });
                    }
                    if (activeConvertJobId.value && progress.jobId !== activeConvertJobId.value) {
                        return;
                    }
                    if (!activeConvertJobId.value && conversionState.value.isConverting) {
                        activeConvertJobId.value = progress.jobId;
                    }
                    conversionState.value = {
                        isConverting: true,
                        phase: progress.phase,
                        percent: progress.percent,
                    };
                    if (progress.percent >= 100) {
                        activeConvertJobId.value = null;
                    }
                }
            });
        } catch (error) {
            logSuppressedError('DjVu progress listener unavailable', error);
        }
    }

    function setupViewingReadyListener() {
        if (unsubViewingReady) {
            return;
        }

        try {
            const api = getElectronAPI();
            unsubViewingReady = api.djvu.onViewingReady((event) => {
                if (activeViewingJobId.value && event.jobId && event.jobId !== activeViewingJobId.value) {
                    return;
                }
                if (!swapHandler) {
                    resetViewingProgressState();
                    return;
                }
                if (swapHandler) {
                    swapHandler(event);
                }
            });
        } catch (error) {
            logSuppressedError('DjVu viewing-ready listener unavailable', error);
        }
    }

    function setupViewingErrorListener() {
        if (unsubViewingError) {
            return;
        }

        try {
            const api = getElectronAPI();
            unsubViewingError = api.djvu.onViewingError((event) => {
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

    function teardownListeners() {
        if (unsubProgress) {
            unsubProgress();
            unsubProgress = null;
        }
        if (unsubViewingReady) {
            unsubViewingReady();
            unsubViewingReady = null;
        }
        if (unsubViewingError) {
            unsubViewingError();
            unsubViewingError = null;
        }
        resetViewingProgressState();
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;
    }

    setupProgressListener();
    setupViewingReadyListener();
    setupViewingErrorListener();
    onUnmounted(() => {
        void cancelActiveJobs();
        teardownListeners();
    });

    async function openDjvuFile(
        djvuPath: TDocumentRef,
        _loadPdfFromPath: (path: TDocumentRef) => Promise<void>,
        _getCurrentPage?: () => number,
        _setPage?: (page: number) => void,
        setOriginalPath?: (path: TDocumentRef | null) => void,
        closeActivePdf?: () => void | Promise<void>,
    ) {
        const api = getElectronAPI();
        showBanner.value = true;
        clearViewingError();
        openingPath.value = djvuPath;
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;

        try {
            const result = await api.djvu.openForViewing(djvuPath);
            if (!result.success) {
                BrowserLogger.error('djvu', 'Open failed', result.error);
                throw new Error(result.error ?? t('errors.djvu.open'));
            }

            BrowserLogger.info('djvu', 'Native DjVu viewing ready', { pageCount: result.pageCount ?? 0 });
            resetViewingProgressState();
            await closeActivePdf?.();
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
        loadPdfFromPath: (path: TDocumentRef) => Promise<void>,
    ) {
        if (!djvuSourcePath.value) {
            return;
        }

        const api = getElectronAPI();

        const suggestedName = (getDocumentRefBaseName(djvuSourcePath.value) ?? t('djvu.documentFallback'))
            .replace(/\.djvu?$/i, '.pdf');
        const savePath = await api.documents.savePdfDialog(suggestedName);
        if (!savePath) {
            return;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };
        activeConvertJobId.value = null;
        pendingConvertCancel.value = false;
        let shouldCleanupSavePath = true;

        BrowserLogger.info('djvu', 'Starting conversion to PDF', {
            subsample,
            preserveBookmarks, 
        });

        try {
            clearViewingError();
            const result = await api.djvu.convertToPdf(
                djvuSourcePath.value,
                savePath,
                {
                    subsample,
                    preserveBookmarks,
                },
            );

            if (!result.success || !result.pdfPath) {
                BrowserLogger.error('djvu', 'Conversion failed', result.error);
                viewingError.value = result.error ?? t('errors.djvu.convert');
                return;
            }
            activeConvertJobId.value = result.jobId ?? null;
            shouldCleanupSavePath = false;
            BrowserLogger.info('djvu', 'Conversion completed', {
                jobId: result.jobId,
                pdfPath: result.pdfPath, 
            });

            const tempPath = djvuTempPdfPath.value;
            exitDjvuMode();
            activeViewingJobId.value = null;

            if (tempPath) {
                try {
                    await api.djvu.cleanupTemp(tempPath);
                } catch (cleanupError) {
                    logSuppressedError('Failed to cleanup DjVu temp PDF after conversion', cleanupError);
                }
            }

            const openResult = await api.documents.openPdfDirect(result.pdfPath);
            if (openResult && openResult.kind === 'pdf') {
                await loadPdfFromPath(openResult.workingPath);
            }
        } catch (error) {
            const message = error instanceof Error && error.message.trim().length > 0
                ? error.message
                : t('errors.djvu.convert');
            BrowserLogger.error('djvu', 'Conversion crashed', {
                path: djvuSourcePath.value,
                error,
            });
            viewingError.value = message;
        } finally {
            activeConvertJobId.value = null;
            pendingConvertCancel.value = false;
            conversionState.value = {
                isConverting: false,
                phase: null,
                percent: 0,
            };
            if (shouldCleanupSavePath) {
                await api.documents.cleanupFile(savePath).catch((cleanupError: unknown) => {
                    logSuppressedError('Failed to cleanup DjVu browser output ref', cleanupError);
                });
            }
        }
    }

    async function cancelActiveJobs() {
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
                return true;
            }
            return false;
        }

        try {
            const api = getElectronAPI();
            await Promise.all(Array.from(ids, async (jobId) => {
                try {
                    await api.djvu.cancel(jobId);
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
            const api = getElectronAPI();
            await api.djvu.cleanupTemp(djvuTempPdfPath.value);
        } catch (cleanupError) {
            logSuppressedError('Failed to cleanup DjVu temp PDF', cleanupError);
        }
    }

    function openConvertDialog() {
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
