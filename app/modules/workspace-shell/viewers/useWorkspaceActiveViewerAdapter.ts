import type {
    ComputedRef,
    Ref,
} from 'vue';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TPdfSource } from '@app/types/pdfUi';
import {
    isPathPdfSource,
    shouldUseNativePdfPreview,
} from '@app/modules/pdf-viewer/public';
import type { IWorkspaceViewerCapabilities } from '@app/types/workspaceExpose';
import { resolveWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapters';
import type { IWorkspaceViewerAdapter } from '@app/modules/workspace-shell/viewers/workspaceViewerAdapterTypes';

interface IWorkspaceActiveViewerAdapterOptions {
    djvuSourcePath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
}

interface IWorkspaceActiveViewerAdapterResult {
    activeViewerAdapter: ComputedRef<IWorkspaceViewerAdapter | null>;
    activeViewerCapabilities: ComputedRef<IWorkspaceViewerCapabilities | undefined>;
    nativePdfSourcePath: ComputedRef<TDocumentRef | null>;
}

export const useWorkspaceActiveViewerAdapter = (
    options: IWorkspaceActiveViewerAdapterOptions,
): IWorkspaceActiveViewerAdapterResult => {
    const nativePdfSourcePath = computed(() => {
        const source = options.pdfSrc.value;
        if (!shouldUseNativePdfPreview(source) || !isPathPdfSource(source)) {
            return null;
        }
        return source.path;
    });
    const activeViewerAdapter = computed(() => resolveWorkspaceViewerAdapter({
        djvuSourcePath: options.djvuSourcePath.value,
        isDjvuMode: options.isDjvuMode.value,
        pdfSourcePath: isPathPdfSource(options.pdfSrc.value) ? options.pdfSrc.value.path : options.pdfSrc.value ? 'document.pdf' : null,
        shouldUseNativePdf: Boolean(nativePdfSourcePath.value),
    }));
    const activeViewerCapabilities = computed(() => activeViewerAdapter.value?.capabilities);

    return {
        activeViewerAdapter,
        activeViewerCapabilities,
        nativePdfSourcePath,
    };
};
