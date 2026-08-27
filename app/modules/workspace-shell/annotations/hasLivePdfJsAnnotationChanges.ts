import { collectLivePdfJsAnnotationChangeIds } from '@app/modules/pdf-viewer/public';
import type { IHasAnnotationChangesDeps } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function hasLivePdfJsAnnotationChanges(deps: IHasAnnotationChangesDeps) {
    const document = deps.pdfDocument.value;
    if (!document) {
        return false;
    }

    const summary = deps.pdfViewerRef.value?.collectLiveAnnotationChanges?.()
        ?? collectLivePdfJsAnnotationChangeIds(document);
    const savedFingerprint = deps.savedAnnotationStorageFingerprint?.value;
    if (savedFingerprint !== null && savedFingerprint !== undefined) {
        return summary.fingerprint !== savedFingerprint;
    }

    return summary.hasChanges;
}
