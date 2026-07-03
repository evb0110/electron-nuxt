import type {
    ISerializeEmbeddedFallbackDeps,
    TSerializeEmbeddedFallbackResult,
} from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function createSerializeCurrentPdfForEmbeddedFallback(deps: ISerializeEmbeddedFallbackDeps) {
    return async function serializeCurrentPdfForEmbeddedFallback(): Promise<TSerializeEmbeddedFallbackResult> {
        if (!deps.pdfViewerRef.value) {
            return null;
        }

        const capturedWorkingCopy = deps.workingCopyPath.value;
        const isCapturedWorkingCopyActive = () => (
            deps.workingCopyPath.value === capturedWorkingCopy
            && Boolean(deps.pdfViewerRef.value)
        );
        const saveTransaction = await deps.pdfViewerRef.value.runSaveTransaction({
            mode: 'embedded-mutation',
            forcePdfjsMaterialize: true,
        });
        const rawData = saveTransaction.serializedBytes ?? saveTransaction.baseBytes;
        if (!rawData) {
            return null;
        }
        if (!isCapturedWorkingCopyActive()) {
            return null;
        }

        const pageToRestore = deps.currentPage.value;
        const restorePromise = deps.waitForPdfReload(pageToRestore);
        await deps.loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!capturedWorkingCopy,
        });
        if (!isCapturedWorkingCopyActive()) {
            void restorePromise.catch(() => {});
            return null;
        }
        await restorePromise;
        if (!isCapturedWorkingCopyActive()) {
            return null;
        }
        return rawData;
    };
}
