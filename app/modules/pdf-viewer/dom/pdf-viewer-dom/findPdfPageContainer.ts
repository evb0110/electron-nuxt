import { pdfViewerDomSelectors } from '@app/modules/pdf-viewer/dom/pdf-viewer-dom/pdfViewerDomSelectors';

function getPdfPageContainerSelector(pageNumber: number) {
    return `${pdfViewerDomSelectors.pageContainer}[data-page="${pageNumber}"]`;
}

export function findPdfPageContainer(
    root: ParentNode | null | undefined,
    pageNumber: number,
) {
    return root?.querySelector<HTMLElement>(getPdfPageContainerSelector(pageNumber)) ?? null;
}
