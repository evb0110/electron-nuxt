import type { Ref } from 'vue';
import { clearPdfSelectionForLayerTeardown } from '@app/utils/pdf-viewer/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';
import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';
import { renderedPageContainerClass } from '@app/modules/pdf-viewer/runtime/rendering/pdf-renderer-page-dom/renderedPageContainerClass';

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
        const skeleton = pageContainer?.querySelector<HTMLElement>(pdfViewerDomSelectors.pageSkeleton) ?? null;
        const getChildCount = (selector: string) => {
            const node = pageContainer?.querySelector(selector);
            return node?.childNodes?.length ?? null;
        };
        return {
            hasContainer: Boolean(pageContainer),
            containerRenderedClass: pageContainer?.classList.contains(renderedPageContainerClass) ?? false,
            hasCanvas: Boolean(pageContainer?.querySelector(pdfViewerDomSelectors.pageCanvasElement)),
            skeletonDisplay: skeleton?.style.display ?? null,
            textLayerChildren: getChildCount(pdfViewerDomSelectors.textLayer),
            annotationLayerChildren: getChildCount(pdfViewerDomSelectors.annotationLayer),
            editorLayerChildren: getChildCount(pdfViewerDomSelectors.annotationEditorLayer),
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
