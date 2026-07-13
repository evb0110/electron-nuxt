import type { IHasAnnotationChangesDeps } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';
import { hasLivePdfJsAnnotationChanges } from '@app/modules/workspace-shell/annotations/hasLivePdfJsAnnotationChanges';
import { hasViewerShapeChanges } from '@app/modules/workspace-shell/annotations/hasViewerShapeChanges';

export function hasAnnotationChanges(deps: IHasAnnotationChangesDeps) {
    if (deps.pdfViewerRef.value?.hasCanonicalAnnotationChanges?.() === true) {
        return true;
    }
    if (hasViewerShapeChanges(deps.pdfViewerRef.value)) {
        return true;
    }

    return hasLivePdfJsAnnotationChanges(deps);
}
