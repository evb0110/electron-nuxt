import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IDjvuProgress,
    IDjvuPageSize,
    TDjvuPdfExportStrategy,
} from '@contracts/electronApiDjvu';
import {
    normalizeDjvuPdfSubsample,
    resolveDjvuPdfExportStrategy,
} from '@contracts/djvuConversionPolicy';
import {
    didOpenDocument,
    type TDocumentOpenOutcome,
} from '@app/types/documentOpenOutcome';
import type {
    IPdfRasterDisplayProfileOpenOptions,
    TPdfRasterDisplayProfile,
} from '@app/types/pdfRasterDisplayProfile';
import {
    createDocumentSession,
    ensurePdfProjection,
    type IDocumentSession,
    type TPdfProjectionReason,
} from '@app/utils/document-viewer/session/documentSession';
import type {
    IDocumentPageSource,
    IDocumentSourceCapabilities,
} from '@app/utils/document-viewer/source/documentPageSource';
import {
    normalizePdfRasterSourcePagePixels,
    registerPdfRasterDisplayProfile,
    unregisterPdfRasterDisplayProfiles,
} from '@app/types/pdfRasterDisplayProfile';
import { useDocumentSourceSession } from '@app/modules/workspace-shell/document-sessions/useDocumentSourceSession';
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

export interface IOpenDjvuFileOptions {
    closeActiveDocument?: () => void | Promise<void>;
    setOriginalPath?: (path: TDocumentRef | null) => void;
}

export type TOpenDjvuFile = (
    djvuPath: TDocumentRef,
    options?: IOpenDjvuFileOptions,
) => Promise<void>;

type TOpenConvertedPdf = (
    path: TDocumentRef,
    options?: IPdfRasterDisplayProfileOpenOptions,
) => Promise<TDocumentOpenOutcome>;

const DJVU_PROJECTION_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: false,
    directImageExport: true,
    outline: true,
    pageEdits: false,
    search: true,
    text: true,
};

const PDF_PROJECTION_SOURCE_CAPABILITIES: IDocumentSourceCapabilities = {
    annotations: true,
    directImageExport: true,
    outline: true,
    pageEdits: true,
    search: true,
    text: true,
};

function createProjectionSourceIdentity(
    kind: IDocumentPageSource['kind'],
    documentRef: TDocumentRef,
): IDocumentPageSource {
    const unavailable = () => Promise.reject(new Error('Projection source identity cannot render pages'));
    return {
        kind,
        documentRef,
        pageCount: 0,
        getPageMetrics: unavailable,
        renderPage: unavailable,
        dispose() {},
    };
}

function ensurePdfSuggestedName(name: string) {
    const trimmedName = name.trim();
    const safeName = trimmedName.length > 0 ? trimmedName : 'document';
    return /\.pdf$/i.test(safeName) ? safeName : `${safeName}.pdf`;
}

function createTrustedRasterDjvuPdfDisplayProfile(
    pageSizes: readonly IDjvuPageSize[],
    options: {
        pdfStrategy: TDjvuPdfExportStrategy;
        subsample: number;
    },
): TPdfRasterDisplayProfile | null {
    const resolvedStrategy = resolveDjvuPdfExportStrategy(options.pdfStrategy);
    const sourcePixelScale = resolvedStrategy === 'direct'
        ? normalizeDjvuPdfSubsample(options.subsample)
        : 1;
    const sourcePagePixels = pageSizes.map(size => normalizePdfRasterSourcePagePixels({
        width: size.width / sourcePixelScale,
        height: size.height / sourcePixelScale,
    }));
    return sourcePagePixels.some(Boolean)
        ? {
            kind: 'trusted-raster-djvu',
            sourcePagePixels,
        }
        : null;
}

export const useDjvu = () => {
    const { t } = useTypedI18n();
    const toast = useToast();

    const {
        isDjvuSource: isDjvuMode,
        sourceRef: djvuSourcePath,
        projectionRef: djvuTempPdfPath,
        activateDocumentSource,
        clearDocumentSource,
    } = useDocumentSourceSession();

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
    const sourceError = ref<string | null>(null);
    const openingPath = ref<TDocumentRef | null>(null);
    const activeViewingJobId = ref<string | null>(null);
    const activeConvertJobId = ref<string | null>(null);

    let unsubProgress: (() => void) | null = null;
    let openDjvuGeneration = 0;
    let conversionGeneration = 0;
    let conversionRequestSequence = 0;
    let activeConversionGeneration: number | null = null;
    let isUnmounted = false;
    let activeProjectionSession: IDocumentSession | null = null;

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

    function isCurrentDjvuOpen(generation: number, path: TDocumentRef) {
        return generation === openDjvuGeneration && openingPath.value === path;
    }

    function isCurrentConversion(generation: number, sourcePath: TDocumentRef) {
        return ownsConversion(generation)
            && djvuSourcePath.value === sourcePath;
    }

    function ownsConversion(generation: number) {
        return generation === conversionGeneration
            && activeConversionGeneration === generation;
    }

    async function releaseStaleViewingPath(generation: number, path: TDocumentRef) {
        const newerOpenOwnsSamePath = generation !== openDjvuGeneration
            && openingPath.value === path;
        if (!newerOpenOwnsSamePath && djvuSourcePath.value !== path) {
            await releaseViewingPath(path);
        }
    }

    async function cancelJobWhenAdmitted(jobId: string) {
        try {
            await getDjvuCapability().cancel(jobId);
        } catch (error) {
            logSuppressedError(`Failed to cancel stale DjVu job ${jobId}`, error);
        }
    }

    function invalidatePendingDjvuOpen() {
        openDjvuGeneration += 1;
        openingPath.value = null;
        resetViewingProgressState();
    }

    function clearSourceError() {
        sourceError.value = null;
    }

    function showConversionError(message: string) {
        toast.add({
            color: 'error',
            title: t('errors.djvu.convert'),
            description: message,
        });
    }

    function createConversionRequestId() {
        conversionRequestSequence += 1;
        return `djvu-convert:${conversionGeneration}:${conversionRequestSequence}`;
    }

    function toConversionPhase(phase: IDjvuProgress['phase']): IDjvuConversionState['phase'] {
        return phase === 'converting' || phase === 'bookmarks' || phase === 'optimizing'
            ? phase
            : null;
    }

    function isProgressForCurrentConversion(progress: IDjvuProgress) {
        return activeConvertJobId.value !== null
            && progress.jobId === activeConvertJobId.value;
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
        activeProjectionSession = null;
        clearDocumentSource();
        void releaseViewingPath(sourcePath);
    }

    function setupProgressListener() {
        if (unsubProgress) {
            return;
        }

        try {
            unsubProgress = getDjvuCapability().onProgress((progress) => {
                if (!isProgressForCurrentConversion(progress)) {
                    return;
                }

                if (activeConvertJobId.value && progress.jobId !== activeConvertJobId.value) {
                    return;
                }
                activeConvertJobId.value ??= progress.jobId;
                isLoadingPages.value = false;
                if (progress.phase === 'loading') {
                    conversionState.value = {
                        isConverting: true,
                        phase: null,
                        percent: progress.percent,
                    };
                    return;
                }
                conversionState.value = {
                    isConverting: true,
                    phase: toConversionPhase(progress.phase),
                    percent: progress.percent,
                };
            });
        } catch (error) {
            logSuppressedError('DjVu progress listener unavailable', error);
        }
    }

    function teardownListeners() {
        if (unsubProgress) {
            unsubProgress();
            unsubProgress = null;
        }
        resetViewingProgressState();
        activeConvertJobId.value = null;
    }

    setupProgressListener();
    onUnmounted(() => {
        isUnmounted = true;
        invalidatePendingDjvuOpen();
        conversionGeneration += 1;
        void cancelActiveJobs();
        void releaseViewingPath(djvuSourcePath.value);
        teardownListeners();
    });

    async function openDjvuFile(
        djvuPath: TDocumentRef,
        options: IOpenDjvuFileOptions = {},
    ) {
        const generation = ++openDjvuGeneration;
        const djvu = getDjvuCapability();
        const previousDjvuPath = djvuSourcePath.value;
        showBanner.value = true;
        clearSourceError();
        openingPath.value = djvuPath;
        activeConvertJobId.value = null;
        isLoadingPages.value = true;
        loadingProgress.value = {
            current: 0,
            total: 0,
        };

        try {
            const openHandle = await djvu.startOpenForViewing(
                djvuPath,
                `open:${generation}:${Date.now()}`,
            );
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await cancelJobWhenAdmitted(openHandle.jobId);
                await releaseStaleViewingPath(generation, djvuPath);
                return;
            }
            activeViewingJobId.value = openHandle.jobId;
            await djvu.subscribeJob(openHandle.jobId);
            const result = await djvu.awaitOpenJob(openHandle.jobId);
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await releaseStaleViewingPath(generation, djvuPath);
                return;
            }
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

            BrowserLogger.info('djvu', 'Native DjVu viewing ready', { pageCount: result.pageCount ?? 0 });
            resetViewingProgressState();
            await options.closeActiveDocument?.();
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await releaseStaleViewingPath(generation, djvuPath);
                return;
            }
            if (previousDjvuPath && previousDjvuPath !== djvuPath) {
                await releaseViewingPath(previousDjvuPath);
            }
            options.setOriginalPath?.(djvuPath);
            activateDocumentSource('djvu', djvuPath);
            activeProjectionSession = createDocumentSession({
                id: `djvu:${String(djvuPath)}`,
                originalRef: djvuPath,
                source: createProjectionSourceIdentity('djvu', djvuPath),
                capabilities: DJVU_PROJECTION_SOURCE_CAPABILITIES,
            });
        } catch (e) {
            if (!isCurrentDjvuOpen(generation, djvuPath)) {
                await releaseStaleViewingPath(generation, djvuPath);
                return;
            }
            resetViewingProgressState();
            throw e;
        } finally {
            if (isCurrentDjvuOpen(generation, djvuPath)) {
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
            return null;
        }

        const generation = ++conversionGeneration;
        const djvu = getDjvuCapability();
        const documentFiles = getDocumentFilesCapability();
        const documentWorkingCopy = getDocumentWorkingCopyCapability();
        const requestId = createConversionRequestId();

        const sourceBaseName = getDocumentRefBaseName(sourcePath)?.trim();
        const suggestedName = sourceBaseName
            ? ensurePdfSuggestedName(sourceBaseName.replace(/\.djvu?$/i, ''))
            : ensurePdfSuggestedName(t('djvu.documentFallback'));
        const savePath = await documentFiles.savePdfDialog(suggestedName);
        if (!savePath || generation !== conversionGeneration || djvuSourcePath.value !== sourcePath) {
            return null;
        }

        conversionState.value = {
            isConverting: true,
            phase: 'converting',
            percent: 0,
        };
        activeConversionGeneration = generation;
        activeConvertJobId.value = null;
        let shouldCleanupSavePath = true;

        BrowserLogger.info('djvu', 'Starting conversion to PDF', {
            subsample,
            preserveBookmarks,
            pdfStrategy,
        });

        try {
            clearSourceError();
            const convertHandle = await djvu.startConvertToPdf(
                sourcePath,
                savePath,
                {
                    subsample,
                    preserveBookmarks,
                    pdfStrategy,
                    requestId,
                    documentRef: sourcePath,
                },
            );
            if (!isCurrentConversion(generation, sourcePath)) {
                await cancelJobWhenAdmitted(convertHandle.jobId);
                return null;
            }
            activeConvertJobId.value = convertHandle.jobId;
            await djvu.subscribeJob(convertHandle.jobId);
            const result = await djvu.awaitConvertJob(convertHandle.jobId);

            if (!ownsConversion(generation)) {
                return null;
            }

            if (
                result.requestId
                && result.requestId !== requestId
            ) {
                return null;
            }
            if (result.jobId) {
                activeConvertJobId.value = result.jobId;
            }

            const outputState = result.jobId
                ? await djvu.subscribeJob(result.jobId)
                : null;
            const outputError = outputState && 'error' in outputState
                ? outputState.error
                : undefined;

            if (
                !result.success
                || !result.pdfPath
                || !outputState
                || outputState.operation !== 'djvu-convert'
                || (outputState.status !== 'completed' && outputState.status !== 'handoff')
            ) {
                BrowserLogger.error('djvu', 'Conversion failed', result.error);
                showConversionError(result.error ?? outputError ?? t('errors.djvu.convert'));
                return null;
            }
            shouldCleanupSavePath = false;
            BrowserLogger.info('djvu', 'Conversion completed', {
                jobId: result.jobId,
                pdfPath: result.pdfPath,
            });

            let rasterDisplayProfile: TPdfRasterDisplayProfile | null = null;
            try {
                rasterDisplayProfile = createTrustedRasterDjvuPdfDisplayProfile(
                    await djvu.getPageSizes(sourcePath),
                    {
                        pdfStrategy,
                        subsample,
                    },
                );
            } catch (profileError) {
                BrowserLogger.warn('djvu', 'Failed to resolve trusted raster PDF display profile', {
                    path: sourcePath,
                    error: profileError,
                });
            }

            if (!isCurrentConversion(generation, sourcePath)) {
                return null;
            }

            registerPdfRasterDisplayProfile(savePath, rasterDisplayProfile);
            registerPdfRasterDisplayProfile(result.pdfPath, rasterDisplayProfile);
            let openResult: TDocumentOpenOutcome;
            try {
                openResult = rasterDisplayProfile
                    ? await openConvertedPdf(result.pdfPath, {rasterDisplayProfile})
                    : await openConvertedPdf(result.pdfPath);
            } finally {
                unregisterPdfRasterDisplayProfiles(savePath, result.pdfPath);
            }
            if (!isCurrentConversion(generation, sourcePath)) {
                return null;
            }
            if (openResult && openResult.status === 'failed') {
                sourceError.value = openResult.error || t('errors.file.open');
                return null;
            }
            return didOpenDocument(openResult) ? result.pdfPath : null;
        } catch (error) {
            if (!isCurrentConversion(generation, sourcePath)) {
                return null;
            }
            const message = error instanceof Error && error.message.trim().length > 0
                ? error.message
                : t('errors.djvu.convert');
            BrowserLogger.error('djvu', 'Conversion crashed', {
                path: sourcePath,
                error,
            });
            showConversionError(message);
        } finally {
            if (activeConversionGeneration === generation) {
                activeConversionGeneration = null;
                activeConvertJobId.value = null;
                conversionState.value = {
                    isConverting: false,
                    phase: null,
                    percent: 0,
                };
            }
            if (shouldCleanupSavePath && isBrowserDocumentRef(savePath)) {
                await documentWorkingCopy.cleanupFile(savePath).catch((cleanupError: unknown) => {
                    logSuppressedError('Failed to cleanup DjVu browser output ref', cleanupError);
                });
            }
            if (isUnmounted) {
                teardownListeners();
            }
        }
        return null;
    }

    async function ensurePdfProjectionForAction(
        reason: TPdfProjectionReason,
        openConvertedPdf: TOpenConvertedPdf,
        signal: AbortSignal,
    ) {
        const sourcePath = djvuSourcePath.value;
        if (!sourcePath) {
            return false;
        }
        const session = activeProjectionSession?.originalRef === sourcePath
            ? activeProjectionSession
            : createDocumentSession({
                id: `djvu:${String(sourcePath)}`,
                originalRef: sourcePath,
                source: createProjectionSourceIdentity('djvu', sourcePath),
                capabilities: DJVU_PROJECTION_SOURCE_CAPABILITIES,
            });
        activeProjectionSession = session;
        try {
            await ensurePdfProjection(session, {build: async () => {
                const documentRef = await convertToPdf(1, true, 'direct', openConvertedPdf);
                if (!documentRef) {
                    throw new DOMException('PDF projection canceled', 'AbortError');
                }
                return {
                    documentRef,
                    source: createProjectionSourceIdentity('pdf', documentRef),
                    capabilities: PDF_PROJECTION_SOURCE_CAPABILITIES,
                };
            }}, reason, signal);
            return true;
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                return false;
            }
            throw error;
        }
    }

    async function cancelActiveJobs() {
        const invalidatedConversion = activeConversionGeneration !== null;
        if (invalidatedConversion) {
            conversionGeneration += 1;
            activeConversionGeneration = null;
            conversionState.value = {
                isConverting: false,
                phase: null,
                percent: 0,
            };
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
            return false;
        }

        try {
            await Promise.all(Array.from(ids, async (jobId) => {
                try {
                    await getDjvuCapability().cancel(jobId);
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
        sourceError,
        openingPath,
        openDjvuFile,
        invalidatePendingDjvuOpen,
        convertToPdf,
        ensurePdfProjectionForAction,
        cancelActiveJobs,
        cleanupDjvuTemp,
        exitDjvuMode,
        openConvertDialog,
        closeConvertDialog,
        dismissBanner,
        clearSourceError,
    };
};
