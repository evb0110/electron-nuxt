import type {
    ShallowRef,
    Ref,
} from 'vue';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/platform-api';
import type { IShapeAnnotation } from '@app/types/annotations';
import { collectLivePdfJsAnnotationChangeIds } from '@app/services/pdf-save/pdfAnnotationStorageChanges';

interface IWorkspacePdfViewerForAnnotationUtils {
    saveDocument: () => Promise<Uint8Array | null>;
    hasShapes?: boolean | Ref<boolean>;
    getAllShapes: () => IShapeAnnotation[];
}

interface ISerializeEmbeddedFallbackDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    currentPage: Ref<number>;
    workingCopyPath: Ref<TDocumentRef | null>;
    waitForPdfReload: (page: number) => Promise<void>;
    loadPdfFromData: (
        data: Uint8Array,
        opts?: {
            pushHistory?: boolean;
            persistWorkingCopy?: boolean;
        },
    ) => Promise<void>;
}

interface IHasAnnotationChangesDeps {
    pdfViewerRef: Ref<IWorkspacePdfViewerForAnnotationUtils | null>;
    pdfDocument: ShallowRef<PDFDocumentProxy | null>;
}

export function hasViewerShapeChanges(
    viewer: Pick<IWorkspacePdfViewerForAnnotationUtils, 'hasShapes'> | null | undefined,
) {
    return Boolean(unref(viewer?.hasShapes ?? false));
}

export function createSerializeCurrentPdfForEmbeddedFallback(deps: ISerializeEmbeddedFallbackDeps) {
    return async function serializeCurrentPdfForEmbeddedFallback() {
        if (!deps.pdfViewerRef.value) {
            return false;
        }

        const rawData = await deps.pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }

        const pageToRestore = deps.currentPage.value;
        const restorePromise = deps.waitForPdfReload(pageToRestore);
        await deps.loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!deps.workingCopyPath.value,
        });
        await restorePromise;
        return true;
    };
}

export function hasAnnotationChanges(deps: IHasAnnotationChangesDeps) {
    if (hasViewerShapeChanges(deps.pdfViewerRef.value)) {
        return true;
    }

    const document = deps.pdfDocument.value;
    if (!document) {
        return false;
    }

    return collectLivePdfJsAnnotationChangeIds(document).hasChanges;
}
