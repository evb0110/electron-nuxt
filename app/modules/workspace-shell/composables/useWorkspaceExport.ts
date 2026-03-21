import type { Ref } from 'vue';
import type { TDocumentRef } from '@contracts/platform-api';
import { uniq } from 'es-toolkit/array';
import { BrowserLogger } from '@app/utils/browser-logger';
import { getElectronAPI } from '@app/utils/platform';
import { useAnalytics } from '@app/composables/useAnalytics';

type TExportDialogMode = 'images' | 'multipage-tiff';

interface IWorkspaceExportDeps {
    workingCopyPath: Ref<TDocumentRef | null>;
    totalPages: Ref<number>;
}

export const useWorkspaceExport = (deps: IWorkspaceExportDeps) => {
    const analytics = useAnalytics();
    const {
        workingCopyPath,
        totalPages,
    } = deps;

    const isExportInProgress = ref(false);
    const exportScopeDialogOpen = ref(false);
    const exportScopeDialogMode = ref<TExportDialogMode>('images');
    const exportScopeDialogSelectedPages = ref<number[]>([]);
    let exportScopeDialogResolver: ((selection: number[] | undefined | null) => void) | null = null;

    function normalizeExportSelectedPages(selectedPages: number[]) {
        return uniq(selectedPages)
            .filter(page => Number.isInteger(page) && page >= 1 && page <= totalPages.value)
            .sort((left, right) => left - right);
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

        isExportInProgress.value = true;
        try {
            const api = getElectronAPI();
            const startedAt = Date.now();
            const result = await api.documents.exportPdfToImages(workingCopyPath.value, pageNumbers);
            if (result.success || result.canceled) {
                analytics.track('export_completed', {
                    durationMs: Math.max(0, Date.now() - startedAt),
                    format: 'images',
                    outputCount: result.outputPaths?.length ?? 0,
                    selectedPageCount: pageNumbers?.length ?? totalPages.value,
                    status: result.success ? 'success' : 'canceled',
                });
            }
        } catch (error) {
            BrowserLogger.error('workspace', 'export images failed', error);
        } finally {
            isExportInProgress.value = false;
        }
    }

    async function runMultiPageTiffExport(pageNumbers?: number[]) {
        if (!workingCopyPath.value || isExportInProgress.value) {
            return;
        }

        isExportInProgress.value = true;
        try {
            const api = getElectronAPI();
            const startedAt = Date.now();
            const result = await api.documents.exportPdfToMultiPageTiff(workingCopyPath.value, pageNumbers);
            if (result.success || result.canceled) {
                analytics.track('export_completed', {
                    durationMs: Math.max(0, Date.now() - startedAt),
                    format: 'multipage_tiff',
                    selectedPageCount: pageNumbers?.length ?? totalPages.value,
                    status: result.success ? 'success' : 'canceled',
                });
            }
        } catch (error) {
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
        if (exportScopeDialogResolver) {
            resolveExportScopeDialog(null);
        }
    });

    return {
        isExportInProgress,
        exportScopeDialogOpen,
        exportScopeDialogMode,
        exportScopeDialogSelectedPages,
        handleExportScopeDialogSubmit,
        handleExportScopeDialogOpenChange,
        handleExportImages,
        handleExportMultiPageTiff,
    };
};
