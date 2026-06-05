import type {
    IAnnotationSettings,
    TAnnotationTool,
} from '@app/types/annotations';
import type {
    IPdfPageMatches,
    TFitMode,
    TPdfViewMode,
    TZoomMode,
} from '@app/types/pdf';
import type { IPdfViewerProps } from '@app/modules/pdf-viewer/runtime/contracts/pdfViewerComponent.types';

const emptyAnnotationMatches = new Map<number, IPdfPageMatches>();

function isPropProvided(...names: string[]) {
    const vnodeProps = getCurrentInstance()?.vnode.props;
    if (!vnodeProps) {
        return false;
    }
    return names.some(name => Object.prototype.hasOwnProperty.call(vnodeProps, name));
}

export function usePdfViewerPropModel(props: Readonly<IPdfViewerProps>) {
    const fitMode = computed<TFitMode>(() => props.fitMode ?? 'width');
    const hasShowAnnotationsProp = isPropProvided('showAnnotations', 'show-annotations');

    return {
        src: computed(() => props.src),
        sourcePdfData: computed(() => props.sourcePdfData ?? null),
        suppressLoadingOverlay: computed(() => props.suppressLoadingOverlay === true),
        bufferPages: computed(() => props.bufferPages ?? 2),
        isAnySaving: computed(() => props.isAnySaving ?? false),
        zoom: computed(() => props.zoom ?? 1),
        dragMode: computed(() => props.dragMode ?? false),
        fitMode,
        zoomMode: computed<TZoomMode>(() => props.zoomMode ?? (
            fitMode.value === 'height' ? 'fit-height' : 'fit-width'
        )),
        viewMode: computed<TPdfViewMode>(() => props.viewMode ?? 'single'),
        isResizing: computed(() => props.isResizing ?? false),
        invertColors: computed(() => props.invertColors ?? false),
        showAnnotations: computed(() => !hasShowAnnotationsProp || props.showAnnotations !== false),
        annotationTool: computed<TAnnotationTool>(() => props.annotationTool ?? 'none'),
        annotationCursorMode: computed(() => props.annotationCursorMode ?? false),
        annotationKeepActive: computed(() => props.annotationKeepActive ?? true),
        annotationSettings: computed<IAnnotationSettings | null>(() => props.annotationSettings ?? null),
        searchPageMatches: computed(() => props.searchPageMatches ?? emptyAnnotationMatches),
        currentSearchMatch: computed(() => props.currentSearchMatch ?? null),
        currentSearchMatchNavigationId: computed(() => props.currentSearchMatchNavigationId ?? 0),
        requestedCurrentPage: computed(() => props.currentPage),
        workingCopyPath: computed(() => props.workingCopyPath ?? null),
        continuousScroll: computed(() => props.continuousScroll ?? true),
        isActive: computed(() => props.isActive ?? true),
        authorName: computed(() => props.authorName),
    };
}
