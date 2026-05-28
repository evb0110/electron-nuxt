export const PDF_VIEWER_DOM_CLASSES = {
    pageContainer: 'page_container',
    renderedPageContainer: 'page_container--rendered',
    pageCanvas: 'page_canvas',
    textLayer: 'text-layer',
    textLayerPdfjs: 'textLayer',
    annotationLayer: 'annotation-layer',
    annotationLayerPdfjs: 'annotationLayer',
    annotationEditorLayer: 'annotation-editor-layer',
    annotationEditorLayerPdfjs: 'annotationEditorLayer',
    pageSkeleton: 'pdf-page-skeleton',
} as const;

export const PDF_VIEWER_DOM_SELECTORS = {
    pageContainer: `.${PDF_VIEWER_DOM_CLASSES.pageContainer}`,
    renderedPageContainer: `.${PDF_VIEWER_DOM_CLASSES.renderedPageContainer}`,
    pageCanvas: `.${PDF_VIEWER_DOM_CLASSES.pageCanvas}`,
    pageCanvasElement: `.${PDF_VIEWER_DOM_CLASSES.pageCanvas} canvas`,
    textLayer: `.${PDF_VIEWER_DOM_CLASSES.textLayer}`,
    textLayerAny: `.${PDF_VIEWER_DOM_CLASSES.textLayer}, .${PDF_VIEWER_DOM_CLASSES.textLayerPdfjs}`,
    annotationLayer: `.${PDF_VIEWER_DOM_CLASSES.annotationLayer}`,
    annotationLayerAny: `.${PDF_VIEWER_DOM_CLASSES.annotationLayer}, .${PDF_VIEWER_DOM_CLASSES.annotationLayerPdfjs}`,
    annotationEditorLayer: `.${PDF_VIEWER_DOM_CLASSES.annotationEditorLayer}`,
    annotationEditorLayerAny: `.${PDF_VIEWER_DOM_CLASSES.annotationEditorLayer}, .${PDF_VIEWER_DOM_CLASSES.annotationEditorLayerPdfjs}`,
    pageSkeleton: `.${PDF_VIEWER_DOM_CLASSES.pageSkeleton}`,
} as const;

function getPdfPageContainerSelector(pageNumber: number) {
    return `${PDF_VIEWER_DOM_SELECTORS.pageContainer}[data-page="${pageNumber}"]`;
}

export function findPdfPageContainer(
    root: ParentNode | null | undefined,
    pageNumber: number,
) {
    return root?.querySelector<HTMLElement>(getPdfPageContainerSelector(pageNumber)) ?? null;
}
