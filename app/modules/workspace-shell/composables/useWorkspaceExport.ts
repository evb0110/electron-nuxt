import type { Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import type {
    IImageExportProgress,
    TDocumentImageExportSourceKind,
    TImageExportProgressFormat,
} from '@contracts/electronApiDocuments';
import {
    getDocumentWorkingCopyCapability,
    getImageExportCapability,
} from '@app/utils/platformDocuments';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { getErrorMessage } from '@app/utils/error';
import type { TDocumentOperationKind } from '@app/types/documentOperationKind';

type TExportDialogMode = 'images' | 'multipage-tiff';

export interface IWorkspaceExportOverlay {
    kind: 'images' | 'multipage-tiff';
    pageCount: number;
    state: 'running' | 'success';
    progressPercent?: number;
}

interface IWorkspaceExportDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    sourceKind?: Ref<TDocumentImageExportSourceKind>;
    sourcePath?: Ref<TDocumentRef | null>;
    documentRevisionToken?: Ref<TDocumentRevisionToken | null>;
    totalPages: Ref<number>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
    runWithDocumentOperationLease?: <T>(
        kind: TDocumentOperationKind,
        operation: () => Promise<T>,
    ) => Promise<T>;
}

export const useWorkspaceExport = (deps: IWorkspaceExportDeps) => {
    const analytics = useAnalytics();
    const { t } = useTypedI18n();
    const toast = useToast();
    const {
        workingCopyPath,
        sourceKind = ref('pdf'),
        sourcePath = workingCopyPath,
        documentRevisionToken,
        totalPages,
        ensureWorkingCopyFreshForRead,
        runWithDocumentOperationLease = async (_kind, operation) => operation(),
    } = deps;

    const isExportInProgress = ref(false);
    const exportOverlay = ref<IWorkspaceExportOverlay | null>(null);
    const exportScopeDialogOpen = ref(false);
    const exportScopeDialogMode = ref<TExportDialogMode>('images');
    const exportScopeDialogSelectedPages = ref<number[]>([]);
    let exportScopeDialogResolver: ((selection: number[] | undefined | null) => void) | null = null;
    let exportProgressCleanup: (() => void) | null = null;
    let exportGeneration = 0;
    let isDisposed = false;

    interface IExportIdentity {
        generation: number;
        sourceKind: TDocumentImageExportSourceKind;
        sourcePath: TDocumentRef;
        workingCopyPath: TDocumentRef | null;
        documentRevisionToken: TDocumentRevisionToken | null;
    }

    function captureExportIdentity(generation: number): IExportIdentity | null {
        const exportSourcePath = sourcePath.value;
        if (!exportSourcePath) {
            return null;
        }
        return {
            generation,
            sourceKind: sourceKind.value,
            sourcePath: exportSourcePath,
            workingCopyPath: workingCopyPath.value,
            documentRevisionToken: documentRevisionToken?.value ?? null,
        };
    }

    function ownsExportIdentity(identity: IExportIdentity) {
        return ownsExportSource(identity)
            && (documentRevisionToken?.value ?? null) === identity.documentRevisionToken;
    }

    function ownsExportSource(identity: IExportIdentity) {
        return !isDisposed
            && identity.generation === exportGeneration
            && sourceKind.value === identity.sourceKind
            && sourcePath.value === identity.sourcePath
            && workingCopyPath.value === identity.workingCopyPath;
    }

    const {
        start: startExportOverlayResetTimer,
        stop: stopExportOverlayResetTimer,
    } = useTimeoutFn((kind: IWorkspaceExportOverlay['kind'], pageCount: number) => {
        if (
            exportOverlay.value?.kind === kind
            && exportOverlay.value.state === 'success'
            && exportOverlay.value.pageCount === pageCount
        ) {
            exportOverlay.value = null;
        }
    }, 2200, { immediate: false });

    function clearExportOverlayTimer() {
        stopExportOverlayResetTimer();
    }

    function setExportOverlay(status: IWorkspaceExportOverlay | null) {
        clearExportOverlayTimer();
        exportOverlay.value = status;
    }

    function clearExportProgressSubscription() {
        exportProgressCleanup?.();
        exportProgressCleanup = null;
    }

    function createExportRequestId() {
        return globalThis.crypto?.randomUUID?.()
            ?? `export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    }

    function subscribeExportProgress(
        imageExport: ReturnType<typeof getImageExportCapability>,
        requestId: string,
        format: TImageExportProgressFormat,
    ) {
        clearExportProgressSubscription();
        exportProgressCleanup = imageExport.onProgress((progress: IImageExportProgress) => {
            if (progress.requestId !== requestId || progress.format !== format) {
                return;
            }
            const current = exportOverlay.value;
            if (!current || current.state !== 'running') {
                return;
            }
            exportOverlay.value = {
                ...current,
                progressPercent: progress.percent,
            };
        });
    }

    function showExportRunning(kind: IWorkspaceExportOverlay['kind'], pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'running',
        });
    }

    function showExportSuccess(kind: IWorkspaceExportOverlay['kind'], pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'success',
        });
        startExportOverlayResetTimer(kind, pageCount);
    }

    function showImageExportFailureToast(description?: string) {
        toast.add({
            color: 'error',
            title: t('errors.export.images'),
            ...(description ? { description } : {}),
        });
    }

    function showFreshReadFailureToast() {
        toast.add({
            color: 'error',
            title: t('errors.export.images'),
            description: t('errors.file.save'),
        });
    }

    function normalizeExportSelectedPages(selectedPages: number[]) {
        return uniq(selectedPages)
            .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages.value)
            .sort((left, right) => left - right);
    }

    function getSelectedPageCount(pageNumbers?: number[]) {
        return pageNumbers?.length ?? totalPages.value;
    }

    function trackExportCompleted(payload: {
        startedAt: number;
        format: 'images' | 'multipage_tiff';
        selectedPageCount: number;
        status: 'success' | 'canceled';
        outputCount?: number;
    }) {
        analytics.track('export_completed', {
            durationMs: Math.max(0, Date.now() - payload.startedAt),
            format: payload.format,
            ...(payload.outputCount === undefined ? {} : { outputCount: payload.outputCount }),
            selectedPageCount: payload.selectedPageCount,
            status: payload.status,
        });
    }

    async function cleanupExportedOutputRefs(
        documentWorkingCopy: ReturnType<typeof getDocumentWorkingCopyCapability>,
        outputPaths: string[],
    ) {
        const cleanupPaths = outputPaths.filter(isBrowserDocumentRef);
        if (cleanupPaths.length === 0) {
            return;
        }

        await Promise.allSettled(
            cleanupPaths.map(async (path) => {
                await documentWorkingCopy.cleanupFile(path);
            }),
        );
    }

    async function handleImageExportResult(
        documentWorkingCopy: ReturnType<typeof getDocumentWorkingCopyCapability>,
        result: Awaited<ReturnType<ReturnType<typeof getImageExportCapability>['exportPdfToImages']>>,
        selectedPageCount: number,
    ) {
        if (!result.success) {
            setExportOverlay(null);
            if (!result.canceled) {
                showImageExportFailureToast();
            }
            return;
        }

        if (result.outputPaths) {
            await cleanupExportedOutputRefs(documentWorkingCopy, result.outputPaths);
            showExportSuccess('images', result.outputPaths.length || selectedPageCount);
            return;
        }

        showExportSuccess('images', selectedPageCount);
    }

    function resolveExportScopeDialog(selection: number[] | undefined | null) {
        const resolver = exportScopeDialogResolver;
        exportScopeDialogResolver = null;
        exportScopeDialogOpen.value = false;
        if (resolver) {
            resolver(selection);
        }
    }

    function openExportScopeDialog(
        mode: TExportDialogMode,
        selectedPages: number[] = [],
    ): Promise<number[] | undefined | null> {
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        }

        exportScopeDialogMode.value = mode;
        exportScopeDialogSelectedPages.value = normalizeExportSelectedPages(selectedPages);
        exportScopeDialogOpen.value = true;

        return new Promise((resolve) => {
            exportScopeDialogResolver = resolve;
        });
    }

    function handleExportScopeDialogSubmit(payload: { pageNumbers?: number[] }) {
        resolveExportScopeDialog(payload.pageNumbers);
    }

    function handleExportScopeDialogOpenChange(isOpen: boolean) {
        if (isOpen) {
            return;
        }
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        } else {
            exportScopeDialogOpen.value = false;
        }
    }

    async function runImageExport(pageNumbers?: number[]) {
        if (!sourcePath.value || isExportInProgress.value) {
            return;
        }

        const selectedPageCount = getSelectedPageCount(pageNumbers);
        const generation = ++exportGeneration;
        isExportInProgress.value = true;
        try {
            const preflightIdentity = captureExportIdentity(generation);
            if (!preflightIdentity) {
                return;
            }
            const isFreshForRead = preflightIdentity.sourceKind === 'pdf' && ensureWorkingCopyFreshForRead
                ? await ensureWorkingCopyFreshForRead()
                : true;
            if (!isFreshForRead || !ownsExportSource(preflightIdentity)) {
                setExportOverlay(null);
                if (isFreshForRead === false && ownsExportSource(preflightIdentity)) {
                    showFreshReadFailureToast();
                }
                return;
            }
            await runWithDocumentOperationLease('raster-export', async () => {
                const identity = captureExportIdentity(generation);
                if (!identity || !ownsExportIdentity(identity)) {
                    setExportOverlay(null);
                    return;
                }

                showExportRunning('images', selectedPageCount);
                const documentWorkingCopy = getDocumentWorkingCopyCapability();
                const imageExport = getImageExportCapability();
                const requestId = createExportRequestId();
                subscribeExportProgress(imageExport, requestId, 'images');
                const startedAt = Date.now();
                const result = await imageExport.exportPdfToImages(
                    identity.sourcePath,
                    pageNumbers,
                    requestId,
                    identity.sourceKind,
                );
                if (!ownsExportIdentity(identity)) {
                    await cleanupExportedOutputRefs(documentWorkingCopy, result.outputPaths ?? []);
                    if (generation === exportGeneration && !isDisposed) {
                        setExportOverlay(null);
                    }
                    return;
                }
                if (result.success || result.canceled) {
                    trackExportCompleted({
                        startedAt,
                        format: 'images',
                        outputCount: result.outputPaths?.length ?? 0,
                        selectedPageCount,
                        status: result.success ? 'success' : 'canceled',
                    });
                }
                await handleImageExportResult(documentWorkingCopy, result, selectedPageCount);
            });
        } catch (error) {
            if (generation === exportGeneration && !isDisposed) {
                setExportOverlay(null);
                BrowserLogger.error('workspace', 'export images failed', error);
                showImageExportFailureToast(getErrorMessage(error));
            }
        } finally {
            if (generation === exportGeneration) {
                clearExportProgressSubscription();
                isExportInProgress.value = false;
            }
        }
    }

    async function runMultiPageTiffExport(pageNumbers?: number[]) {
        if (!sourcePath.value || isExportInProgress.value) {
            return;
        }

        const selectedPageCount = getSelectedPageCount(pageNumbers);
        const generation = ++exportGeneration;
        isExportInProgress.value = true;
        try {
            const preflightIdentity = captureExportIdentity(generation);
            if (!preflightIdentity) {
                return;
            }
            const isFreshForRead = preflightIdentity.sourceKind === 'pdf' && ensureWorkingCopyFreshForRead
                ? await ensureWorkingCopyFreshForRead()
                : true;
            if (!isFreshForRead || !ownsExportSource(preflightIdentity)) {
                setExportOverlay(null);
                if (isFreshForRead === false && ownsExportSource(preflightIdentity)) {
                    toast.add({
                        color: 'error',
                        title: t('errors.export.multiPageTiff'),
                        description: t('errors.file.save'),
                    });
                }
                return;
            }
            await runWithDocumentOperationLease('raster-export', async () => {
                const identity = captureExportIdentity(generation);
                if (!identity || !ownsExportIdentity(identity)) {
                    setExportOverlay(null);
                    return;
                }

                showExportRunning('multipage-tiff', selectedPageCount);
                const documentWorkingCopy = getDocumentWorkingCopyCapability();
                const imageExport = getImageExportCapability();
                const requestId = createExportRequestId();
                subscribeExportProgress(imageExport, requestId, 'multipage-tiff');
                const startedAt = Date.now();
                const result = await imageExport.exportPdfToMultiPageTiff(
                    identity.sourcePath,
                    pageNumbers,
                    requestId,
                    identity.sourceKind,
                );
                const outputPaths = result.outputPaths ?? (result.outputPath ? [result.outputPath] : []);
                if (!ownsExportIdentity(identity)) {
                    await cleanupExportedOutputRefs(documentWorkingCopy, outputPaths);
                    if (generation === exportGeneration && !isDisposed) {
                        setExportOverlay(null);
                    }
                    return;
                }
                if (result.success || result.canceled) {
                    trackExportCompleted({
                        startedAt,
                        format: 'multipage_tiff',
                        outputCount: outputPaths.length,
                        selectedPageCount,
                        status: result.success ? 'success' : 'canceled',
                    });
                }
                if (result.success && outputPaths.length > 0) {
                    await cleanupExportedOutputRefs(documentWorkingCopy, outputPaths);
                    showExportSuccess('multipage-tiff', selectedPageCount);
                } else {
                    setExportOverlay(null);
                }
            });
        } catch (error) {
            if (generation === exportGeneration && !isDisposed) {
                setExportOverlay(null);
                BrowserLogger.error('workspace', 'export multi-page tiff failed', error);
                toast.add({
                    color: 'error',
                    title: t('errors.export.multiPageTiff'),
                    description: getErrorMessage(error),
                });
            }
        } finally {
            if (generation === exportGeneration) {
                clearExportProgressSubscription();
                isExportInProgress.value = false;
            }
        }
    }

    async function handleExportImages(selectedPages: number[] = []) {
        if (!sourcePath.value) {
            return;
        }
        const pageNumbers = await openExportScopeDialog('images', selectedPages);
        if (pageNumbers === null) {
            return;
        }
        await runImageExport(pageNumbers);
    }

    async function handleExportMultiPageTiff(selectedPages: number[] = []) {
        if (!sourcePath.value) {
            return;
        }
        const pageNumbers = await openExportScopeDialog('multipage-tiff', selectedPages);
        if (pageNumbers === null) {
            return;
        }
        await runMultiPageTiffExport(pageNumbers);
    }

    onScopeDispose(() => {
        isDisposed = true;
        exportGeneration += 1;
        clearExportProgressSubscription();
        clearExportOverlayTimer();
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        }
    });

    return {
        isExportInProgress,
        exportOverlay,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleExportImages,
        handleExportMultiPageTiff,
    };
};
