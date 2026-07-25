import type { Ref } from 'vue';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import { resolvePdfViewerSaveTransactionFinalBytes } from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';

interface IPageMutationSaveViewer {runSaveTransaction(request: IPdfViewerSaveTransactionRequest): Promise<IPdfViewerSaveTransactionResult>;}

export function createPageMutationAnnotationMaterializer(deps: {
    annotationDirty: Readonly<Ref<boolean>>;
    hasAnnotationChanges: () => boolean;
    hasLivePdfJsAnnotationChanges: () => boolean;
    hasSavedPdfJsAnnotationBaselineChanges: () => boolean;
    pendingEmbeddedAnnotationDeleteCount: Readonly<Ref<number>>;
    preservedAnnotationSourceDirty: Readonly<Ref<boolean>>;
    workingCopyPath: Readonly<Ref<TDocumentRef | null>>;
    documentRevisionToken: Readonly<Ref<TDocumentRevisionToken | null>>;
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
        const capturedDocumentRevisionToken = deps.documentRevisionToken.value;
        const capturedPage = deps.currentPage.value;
        if (!capturedWorkingCopyPath || !viewer) {
            return false;
        }
        const isCapturedTargetCurrent = (includeRevision = true) => (
            deps.workingCopyPath.value === capturedWorkingCopyPath
            && deps.pdfViewerRef.value === viewer
            && (!includeRevision || deps.documentRevisionToken.value === capturedDocumentRevisionToken)
        );
        const transaction = await viewer.runSaveTransaction({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
        });
        const bytes = resolvePdfViewerSaveTransactionFinalBytes(transaction);
        if (!bytes || !isCapturedTargetCurrent()) {
            return false;
        }
        await transaction.assertAnnotationSaveCurrent?.();
        if (!isCapturedTargetCurrent()) {
            return false;
        }
        await transaction.verifyAnnotationSave?.(bytes);
        await transaction.assertAnnotationSaveCurrent?.();
        if (!isCapturedTargetCurrent()) {
            return false;
        }
        const reloadPromise = deps.waitForPdfReload(capturedPage);
        await transaction.assertAnnotationSaveCurrent?.();
        if (!isCapturedTargetCurrent()) {
            return false;
        }
        await deps.loadPdfFromData(bytes, {
            pushHistory: true,
            persistWorkingCopy: true,
        });
        await reloadPromise;
        // The controlled write/reload may advance the revision and open fence.
        // Path and viewer identity must still belong to the captured document.
        if (!isCapturedTargetCurrent(false)) {
            return false;
        }
        transaction.commitAnnotationSave?.();
        return true;
    };
}
