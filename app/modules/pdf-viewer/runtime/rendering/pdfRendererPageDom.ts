import type { Ref } from 'vue';
import { clearPdfSelectionForLayerTeardown } from '@app/composables/pdf/pdfSelectionCleanup';
import {
    findPdfPageContainer,
    PDF_VIEWER_DOM_CLASSES,
    PDF_VIEWER_DOM_SELECTORS,
} from '@app/modules/pdf-viewer/dom/pdfViewerDom';

export const RENDERED_PAGE_CONTAINER_CLASS = PDF_VIEWER_DOM_CLASSES.renderedPageContainer;

interface ICreatePdfRendererPageDomOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
    renderedPages: Set<number>;
    staleRenderedPages: Set<number>;
    renderingPages: Map<number, number>;
    renderingPageRequestIds: Map<number, number>;
    pageCanvases: Map<number, HTMLCanvasElement>;
}

export function createPdfRendererPageDom(options: ICreatePdfRendererPageDomOptions) {
    const {
        container,
        currentPage,
        renderedPages,
        staleRenderedPages,
        renderingPages,
        renderingPageRequestIds,
        pageCanvases,
    } = options;

    function getMountedPageContainer(
        pageNumber: number,
        containerRoot = container.value,
    ) {
        return findPdfPageContainer(containerRoot, pageNumber);
    }

    function clearSelectionBeforePageLayerTeardown(pageNumber: number) {
        const containerRoot = container.value;
        const pageContainer = getMountedPageContainer(pageNumber, containerRoot);
        return clearPdfSelectionForLayerTeardown({
            target: pageContainer,
            root: containerRoot,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === currentPage.value,
        });
    }

    function summarizePageDom(pageNumber: number) {
        const pageContainer = getMountedPageContainer(pageNumber);
        const skeleton = pageContainer?.querySelector<HTMLElement>(PDF_VIEWER_DOM_SELECTORS.pageSkeleton) ?? null;
        const getChildCount = (selector: string) => {
            const node = pageContainer?.querySelector(selector);
            return node?.childNodes?.length ?? null;
        };
        return {
            hasContainer: Boolean(pageContainer),
            containerRenderedClass: pageContainer?.classList.contains(RENDERED_PAGE_CONTAINER_CLASS) ?? false,
            hasCanvas: Boolean(pageContainer?.querySelector(PDF_VIEWER_DOM_SELECTORS.pageCanvasElement)),
            skeletonDisplay: skeleton?.style.display ?? null,
            textLayerChildren: getChildCount(PDF_VIEWER_DOM_SELECTORS.textLayer),
            annotationLayerChildren: getChildCount(PDF_VIEWER_DOM_SELECTORS.annotationLayer),
            editorLayerChildren: getChildCount(PDF_VIEWER_DOM_SELECTORS.annotationEditorLayer),
            isRenderedState: renderedPages.has(pageNumber),
            isStaleState: staleRenderedPages.has(pageNumber),
            renderingVersion: renderingPages.get(pageNumber) ?? null,
            renderingRequestId: renderingPageRequestIds.get(pageNumber) ?? null,
            trackedCanvas: pageCanvases.has(pageNumber),
        };
    }

    return {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
        summarizePageDom,
    };
}
