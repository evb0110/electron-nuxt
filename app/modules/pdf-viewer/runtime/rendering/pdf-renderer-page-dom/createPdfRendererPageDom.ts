import type { Ref } from 'vue';
import { clearPdfSelectionForLayerTeardown } from '@app/modules/pdf-viewer/engine/pdf-selection-cleanup/clearPdfSelectionForLayerTeardown';
import { findPdfPageContainer } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/findPdfPageContainer';

interface ICreatePdfRendererPageDomOptions {
    container: Ref<HTMLElement | null>;
    currentPage: Ref<number>;
}

export function createPdfRendererPageDom(options: ICreatePdfRendererPageDomOptions) {
    const {
        container,
        currentPage,
    } = options;

    function getMountedPageContainer(
        pageNumber: number,
        containerRoot = container.value,
    ) {
        return findPdfPageContainer(containerRoot, pageNumber);
    }

    function clearSelectionBeforePageLayerTeardown(pageNumber: number): boolean {
        const containerRoot = container.value;
        const pageContainer = getMountedPageContainer(pageNumber, containerRoot);
        return clearPdfSelectionForLayerTeardown({
            target: pageContainer,
            root: containerRoot,
            includeDetached: true,
            includeAnyPdfTextSelection: pageNumber === currentPage.value,
        });
    }

    return {
        getMountedPageContainer,
        clearSelectionBeforePageLayerTeardown,
    };
}
