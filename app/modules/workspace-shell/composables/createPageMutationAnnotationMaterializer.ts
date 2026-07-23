import type { Ref } from 'vue';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import { resolvePdfViewerSaveTransactionFinalBytes } from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';

interface IPageMutationSaveViewer {runSaveTransaction(request: IPdfViewerSaveTransactionRequest): Promise<IPdfViewerSaveTransactionResult>;}

export function createPageMutationAnnotationMaterializer(deps: {
    annotationDirty: Readonly<Ref<boolean>>;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges: () => boolean;
    pendingEmbeddedAnnotationDeleteCount: Readonly<Ref<number>>;
    preservedAnnotationSourceDirty: Readonly<Ref<boolean>>;
    workingCopyPath: Readonly<Ref<TDocumentRef | null>>;
    pdfViewerRef: Readonly<Ref<IPageMutationSaveViewer | null>>;
    currentPage: Readonly<Ref<number>>;
    waitForPdfReload: (page: number) => Promise<unknown>;
    loadPdfFromData: (bytes: Uint8Array, options: {
        pushHistory: boolean;
        persistWorkingCopy: boolean
    }) => Promise<unknown>;
}) {
    return async function materializeAnnotationsForPageMutation() {
        const hasPendingAnnotations = deps.annotationDirty.value
            || deps.hasAnnotationChanges()
            || deps.hasLivePdfJsAnnotationChanges()
            || deps.hasSavedPdfJsAnnotationBaselineChanges()
            || deps.pendingEmbeddedAnnotationDeleteCount.value > 0
            || deps.preservedAnnotationSourceDirty.value;
        if (!hasPendingAnnotations) {
            return true;
        }

        const capturedWorkingCopyPath = deps.workingCopyPath.value;
        const viewer = deps.pdfViewerRef.value;
        if (!capturedWorkingCopyPath || !viewer) {
            return false;
        }
        const transaction = await viewer.runSaveTransaction({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
        });
        const bytes = resolvePdfViewerSaveTransactionFinalBytes(transaction);
        if (!bytes || deps.workingCopyPath.value !== capturedWorkingCopyPath) {
            return false;
        }
        await transaction.verifyAnnotationSave?.(bytes);
        const reloadPromise = deps.waitForPdfReload(deps.currentPage.value);
        await deps.loadPdfFromData(bytes, {
            pushHistory: true,
            persistWorkingCopy: true,
        });
        await reloadPromise;
        if (deps.workingCopyPath.value !== capturedWorkingCopyPath) {
            return false;
        }
        transaction.commitAnnotationSave?.();
        return true;
    };
}
