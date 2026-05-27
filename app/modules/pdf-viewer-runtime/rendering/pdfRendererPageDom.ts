import type { Ref } from 'vue';
import { clearPdfSelectionForLayerTeardown } from '@app/composables/pdf/pdfSelectionCleanup';

export const RENDERED_PAGE_CONTAINER_CLASS = 'page_container--rendered';

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
        return containerRoot?.querySelector<HTMLElement>(
            `.page_container[data-page="${pageNumber}"]`,
        ) ?? null;
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
        const skeleton = pageContainer?.querySelector<HTMLElement>('.pdf-page-skeleton') ?? null;
        const getChildCount = (selector: string) => {
            const node = pageContainer?.querySelector(selector);
            return node?.childNodes?.length ?? null;
        };
        return {
            hasContainer: Boolean(pageContainer),
            containerRenderedClass: pageContainer?.classList.contains(RENDERED_PAGE_CONTAINER_CLASS) ?? false,
            hasCanvas: Boolean(pageContainer?.querySelector('.page_canvas canvas')),
            skeletonDisplay: skeleton?.style.display ?? null,
            textLayerChildren: getChildCount('.text-layer'),
            annotationLayerChildren: getChildCount('.annotation-layer'),
            editorLayerChildren: getChildCount('.annotation-editor-layer'),
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
