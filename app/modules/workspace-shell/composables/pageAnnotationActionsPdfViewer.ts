import type * as WorkspaceOrchestration from '@app/modules/workspace-shell/types/workspaceOrchestration.types';

export type TPageAnnotationActionsPdfViewer = Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'commentAtPoint'
    | 'commentSelection'
    | 'deleteAnnotationComment'
    | 'deleteSelectedShape'
    | 'focusAnnotationComment'
    | 'getSelectedShape'
    | 'getSelectedTextMarkupAnnotationProperties'
    | 'getViewerContainer'
    | 'highlightSelection'
    | 'invalidatePages'
    | 'removeAnnotationFromDom'
    | 'removeAnnotationFromInternalCache'
    | 'runSaveTransaction'
    | 'selectedShapeId'
    | 'startImagePlacement'
    | 'updateAnnotationComment'
    | 'updateSelectedTextMarkupAnnotationColor'
    | 'updateTextMarkupAnnotationColor'
    | 'updateShape'
> & Partial<Pick<WorkspaceOrchestration.IPdfViewerExpose,
    'registerAnnotationHistoryCommand'
    | 'clearPendingImagePlacement'
    | 'rerenderAnnotationPage'
    | 'restorePendingImagePlacement'
    | 'restoreAnnotationToInternalCache'
>>;
