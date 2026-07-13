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
import { getDocumentKindFromPath } from '@app/utils/supportedDocumentPaths';

interface IWorkspaceActiveViewerAdapterOptions {
    djvuSourcePath: Ref<TDocumentRef | null>;
    isDjvuMode: Ref<boolean>;
    pdfSrc: Ref<TPdfSource | null>;
    pendingDocumentPath?: Ref<TDocumentRef | null> | ComputedRef<TDocumentRef | null>;
    pendingDocumentSize?: Ref<number | null> | ComputedRef<number | null>;
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
    const pendingDocumentKind = computed(() => getDocumentKindFromPath(options.pendingDocumentPath?.value ?? ''));
    const pendingNativePdf = computed(() => {
        const path = options.pendingDocumentPath?.value ?? null;
        const size = options.pendingDocumentSize?.value ?? null;
        return pendingDocumentKind.value === 'pdf'
            && path !== null
            && size !== null
            && shouldUseNativePdfPreview({
                kind: 'path',
                path,
                size,
            });
    });
    const activeViewerAdapter = computed(() => resolveWorkspaceViewerAdapter({
        djvuSourcePath: options.djvuSourcePath.value
            ?? (pendingDocumentKind.value === 'djvu' ? options.pendingDocumentPath?.value ?? null : null),
        isDjvuMode: options.isDjvuMode.value || pendingDocumentKind.value === 'djvu',
        pdfSourcePath: isPathPdfSource(options.pdfSrc.value)
            ? options.pdfSrc.value.path
            : options.pdfSrc.value
                ? 'document.pdf'
                : pendingDocumentKind.value === 'pdf'
                    ? options.pendingDocumentPath?.value ?? null
                    : null,
        shouldUseNativePdf: Boolean(nativePdfSourcePath.value) || pendingNativePdf.value,
    }));
    const activeViewerCapabilities = computed(() => activeViewerAdapter.value?.capabilities);

    return {
        activeViewerAdapter,
        activeViewerCapabilities,
        nativePdfSourcePath,
    };
};
