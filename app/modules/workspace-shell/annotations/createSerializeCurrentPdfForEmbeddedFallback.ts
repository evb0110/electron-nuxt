import type { ISerializeEmbeddedFallbackDeps } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function createSerializeCurrentPdfForEmbeddedFallback(deps: ISerializeEmbeddedFallbackDeps) {
    return async function serializeCurrentPdfForEmbeddedFallback() {
        if (!deps.pdfViewerRef.value) {
            return false;
        }

        const capturedWorkingCopy = deps.workingCopyPath.value;
        const isCapturedWorkingCopyActive = () => (
            deps.workingCopyPath.value === capturedWorkingCopy
            && Boolean(deps.pdfViewerRef.value)
        );
        const rawData = await deps.pdfViewerRef.value.saveDocument();
        if (!rawData) {
            return false;
        }
        if (!isCapturedWorkingCopyActive()) {
            return false;
        }

        const pageToRestore = deps.currentPage.value;
        const restorePromise = deps.waitForPdfReload(pageToRestore);
        await deps.loadPdfFromData(rawData, {
            pushHistory: true,
            persistWorkingCopy: !!capturedWorkingCopy,
        });
        if (!isCapturedWorkingCopyActive()) {
            void restorePromise.catch(() => {});
            return false;
        }
        await restorePromise;
        if (!isCapturedWorkingCopyActive()) {
            return false;
        }
        return true;
    };
}
