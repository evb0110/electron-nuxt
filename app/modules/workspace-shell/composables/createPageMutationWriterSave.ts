import type { Ref } from 'vue';
import type {
    IPdfViewerSaveTransactionRequest,
    IPdfViewerSaveTransactionResult,
} from '@app/modules/pdf-viewer/public';
import type { TDocumentRef } from '@contracts/documentRef';
import type { TDocumentRevisionToken } from '@contracts/documentRevision';
import type {IPdfNativeAnnotationIdentityBinding} from '@contracts/electronApiDocuments';
import {
    consumeNativePdfMutationProjection,
    NativePdfSaveRequiredError,
    type INativePdfSaveTransactionOptions,
} from '@app/modules/workspace-shell/composables/nativePdfMutationArtifact';

interface IPageMutationSaveViewer {runSaveTransaction(request: IPdfViewerSaveTransactionRequest): Promise<IPdfViewerSaveTransactionResult>;}

export function createPageMutationWriterSave(deps: {
    annotationDirty: Readonly<Ref<boolean>>;
    hasAnnotationChanges: () => boolean;
    pendingEmbeddedAnnotationDeleteCount: Readonly<Ref<number>>;
    workingCopyPath: Readonly<Ref<TDocumentRef | null>>;
    documentRevisionToken: Readonly<Ref<TDocumentRevisionToken | null>>;
    pdfViewerRef: Readonly<Ref<IPageMutationSaveViewer | null>>;
    currentPage: Readonly<Ref<number>>;
    waitForPdfReload: (page: number) => Promise<unknown>;
    loadPdfFromPath?: (path: TDocumentRef, options?: { markDirty?: boolean }) => Promise<unknown>;
    getNativeSaveTransactionOptions?: () => INativePdfSaveTransactionOptions;
}) {
    return async function saveAnnotationsForPageMutation() {
        const hasPendingAnnotations = deps.annotationDirty.value
            || deps.hasAnnotationChanges()
            || deps.pendingEmbeddedAnnotationDeleteCount.value > 0
            ;
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
            saveFlowMode: 'save',
            forceWriterSave: false,
            workingPath: capturedWorkingCopyPath,
            ...(deps.getNativeSaveTransactionOptions?.() ?? {}),
        });
        if (transaction.nativeRequiredFailure) {
            throw new NativePdfSaveRequiredError(transaction.nativeRequiredFailure);
        }
        const projection = transaction.nativeMutationProjection;
        if (!projection || !isCapturedTargetCurrent()) {
            return false;
        }
        if (!deps.loadPdfFromPath) {
            throw new NativePdfSaveRequiredError({
                code: 'native-save-required',
                phase: 'pre-write',
                reason: 'missing-native-capability',
                detail: 'Native PDF page mutation reload is unavailable',
            });
        }
        await transaction.assertAnnotationSaveCurrent?.();
        let materializedIdentityBindings: readonly IPdfNativeAnnotationIdentityBinding[] = [];
        await consumeNativePdfMutationProjection({
            workingPath: capturedWorkingCopyPath,
            expectedDocumentRevisionToken: capturedDocumentRevisionToken,
            projection,
            operation: 'replace',
            ...(transaction.verifyAnnotationSavePath ? {verifyPathBeforeExpose: transaction.verifyAnnotationSavePath} : {}),
            ...(transaction.assertAnnotationSaveCurrent ? {assertBeforeExpose: transaction.assertAnnotationSaveCurrent} : {}),
            onIdentityBindings: bindings => {
                materializedIdentityBindings = bindings;
            },
        });
        if (!isCapturedTargetCurrent(false)) {
            return false;
        }
        let didCommitAnnotationSave = false;
        if (materializedIdentityBindings.length > 0) {
            // Reloading the working copy advances the document revision and
            // starts the annotation parser. Bind new native refs before that
            // parser runs so it can reconcile the parsed object to the app id.
            transaction.commitAnnotationSave?.(materializedIdentityBindings);
            didCommitAnnotationSave = true;
        }
        const reloadPromise = deps.waitForPdfReload(capturedPage);
        await deps.loadPdfFromPath(capturedWorkingCopyPath, {markDirty: true});
        await reloadPromise;
        if (!isCapturedTargetCurrent(false)) {
            return false;
        }
        if (!didCommitAnnotationSave) {
            transaction.commitAnnotationSave?.(materializedIdentityBindings);
        }
        return true;
    };
}
