import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browserLogger';
import { useAnalytics } from '@app/composables/useAnalytics';
import {
    getDocumentsCapability,
    getImageExportCapability,
} from '@app/utils/platformDocuments';

type TExportDialogMode = 'images' | 'multipage-tiff';
type TExportOverlayKind = 'images' | 'multipage-tiff';
type TExportOverlayState = 'running' | 'success';

interface IExportOverlayStatus {
    kind: TExportOverlayKind;
    pageCount: number;
    state: TExportOverlayState;
}

interface IWorkspaceExportDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    totalPages: Ref<number>;
    ensureWorkingCopyFreshForRead?: () => Promise<boolean>;
}

export const useWorkspaceExport = (deps: IWorkspaceExportDeps) => {
    const analytics = useAnalytics();
    const {
        workingCopyPath,
        totalPages,
        ensureWorkingCopyFreshForRead,
    } = deps;

    const isExportInProgress = ref(false);
    const exportOverlay = ref<IExportOverlayStatus | null>(null);
    const exportScopeDialogOpen = ref(false);
    const exportScopeDialogMode = ref<TExportDialogMode>('images');
    const exportScopeDialogSelectedPages = ref<number[]>([]);
    let exportScopeDialogResolver: ((selection: number[] | undefined | null) => void) | null = null;
    let exportOverlayResetTimer: ReturnType<typeof setTimeout> | null = null;

    function clearExportOverlayTimer() {
        if (exportOverlayResetTimer !== null) {
            clearTimeout(exportOverlayResetTimer);
            exportOverlayResetTimer = null;
        }
    }

    function setExportOverlay(status: IExportOverlayStatus | null) {
        clearExportOverlayTimer();
        exportOverlay.value = status;
    }

    function showExportRunning(kind: TExportOverlayKind, pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'running',
        });
    }

    function showExportSuccess(kind: TExportOverlayKind, pageCount: number) {
        setExportOverlay({
            kind,
            pageCount,
            state: 'success',
        });
        exportOverlayResetTimer = setTimeout(() => {
            exportOverlayResetTimer = null;
            if (
                exportOverlay.value?.kind === kind
                && exportOverlay.value.state === 'success'
                && exportOverlay.value.pageCount === pageCount
            ) {
                exportOverlay.value = null;
            }
        }, 2200);
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

    async function cleanupExportedImages(
        documents: ReturnType<typeof getDocumentsCapability>,
        outputPaths: string[],
    ) {
        await Promise.allSettled(
            outputPaths.map(async (path) => {
                await documents.cleanupFile(path);
            }),
        );
    }

    async function handleImageExportResult(
        documents: ReturnType<typeof getDocumentsCapability>,
        result: Awaited<ReturnType<ReturnType<typeof getImageExportCapability>['exportPdfToImages']>>,
        selectedPageCount: number,
    ) {
        if (!result.success) {
            setExportOverlay(null);
            return;
        }

        if (result.outputPaths) {
            await cleanupExportedImages(documents, result.outputPaths);
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
        if (!workingCopyPath.value || isExportInProgress.value) {
            return;
        }

        const selectedPageCount = getSelectedPageCount(pageNumbers);
        isExportInProgress.value = true;
        try {
            const isFreshForRead = ensureWorkingCopyFreshForRead
                ? await ensureWorkingCopyFreshForRead()
                : true;
            if (!isFreshForRead || !workingCopyPath.value) {
                setExportOverlay(null);
                return;
            }

            showExportRunning('images', selectedPageCount);
            const documents = getDocumentsCapability();
            const imageExport = getImageExportCapability();
            const startedAt = Date.now();
            const result = await imageExport.exportPdfToImages(workingCopyPath.value, pageNumbers);
            if (result.success || result.canceled) {
                trackExportCompleted({
                    startedAt,
                    format: 'images',
                    outputCount: result.outputPaths?.length ?? 0,
                    selectedPageCount,
                    status: result.success ? 'success' : 'canceled',
                });
            }
            await handleImageExportResult(documents, result, selectedPageCount);
        } catch (error) {
            setExportOverlay(null);
            BrowserLogger.error('workspace', 'export images failed', error);
        } finally {
            isExportInProgress.value = false;
        }
    }

    async function runMultiPageTiffExport(pageNumbers?: number[]) {
        if (!workingCopyPath.value || isExportInProgress.value) {
            return;
        }

        const selectedPageCount = getSelectedPageCount(pageNumbers);
        isExportInProgress.value = true;
        try {
            const isFreshForRead = ensureWorkingCopyFreshForRead
                ? await ensureWorkingCopyFreshForRead()
                : true;
            if (!isFreshForRead || !workingCopyPath.value) {
                setExportOverlay(null);
                return;
            }

            showExportRunning('multipage-tiff', selectedPageCount);
            const documents = getDocumentsCapability();
            const imageExport = getImageExportCapability();
            const startedAt = Date.now();
            const result = await imageExport.exportPdfToMultiPageTiff(workingCopyPath.value, pageNumbers);
            if (result.success || result.canceled) {
                trackExportCompleted({
                    startedAt,
                    format: 'multipage_tiff',
                    selectedPageCount,
                    status: result.success ? 'success' : 'canceled',
                });
            }
            if (result.success && result.outputPath) {
                await documents.cleanupFile(result.outputPath).catch(() => {});
                showExportSuccess('multipage-tiff', selectedPageCount);
            } else {
                setExportOverlay(null);
            }
        } catch (error) {
            setExportOverlay(null);
            BrowserLogger.error('workspace', 'export multi-page tiff failed', error);
        } finally {
            isExportInProgress.value = false;
        }
    }

    async function handleExportImages(selectedPages: number[] = []) {
        if (!workingCopyPath.value) {
            return;
        }
        const pageNumbers = await openExportScopeDialog('images', selectedPages);
        if (pageNumbers === null) {
            return;
        }
        await runImageExport(pageNumbers);
    }

    async function handleExportMultiPageTiff(selectedPages: number[] = []) {
        if (!workingCopyPath.value) {
            return;
        }
        const pageNumbers = await openExportScopeDialog('multipage-tiff', selectedPages);
        if (pageNumbers === null) {
            return;
        }
        await runMultiPageTiffExport(pageNumbers);
    }

    onScopeDispose(() => {
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
