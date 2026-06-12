import { collectLivePdfJsAnnotationChangeIds } from '@app/modules/pdf-viewer/public';
import type { IHasAnnotationChangesDeps } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function hasLivePdfJsAnnotationChanges(deps: Omit<IHasAnnotationChangesDeps, 'pdfViewerRef'>) {
    const document = deps.pdfDocument.value;
    if (!document) {
        return false;
    }

    const summary = collectLivePdfJsAnnotationChangeIds(document);
    const savedFingerprint = deps.savedAnnotationStorageFingerprint?.value;
    if (savedFingerprint !== null && savedFingerprint !== undefined) {
        return summary.fingerprint !== savedFingerprint;
    }

    return summary.hasChanges;
}
