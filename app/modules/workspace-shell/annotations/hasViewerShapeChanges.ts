import type { IWorkspacePdfViewerForAnnotationUtils } from '@app/modules/workspace-shell/annotations/workspaceAnnotationTypes';

export function hasViewerShapeChanges(
    viewer: Pick<IWorkspacePdfViewerForAnnotationUtils, 'hasShapes'> | null | undefined,
) {
    return Boolean(unref(viewer?.hasShapes ?? false));
}
