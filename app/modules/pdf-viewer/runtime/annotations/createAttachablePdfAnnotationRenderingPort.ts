import type { IRenderVisiblePagesOptions } from '@app/modules/pdf-viewer/runtime/rendering/pdfRendererTypes';
import type { IPageRange } from '@app/types/pdfUi';

export type TPdfAnnotationRenderOptions = Pick<
    IRenderVisiblePagesOptions,
    'preserveRenderedPages' | 'forceRerender' | 'bufferOverride'
>;

export interface IPdfAnnotationRenderingPort {
    renderVisiblePages: (
        range: IPageRange,
        options?: TPdfAnnotationRenderOptions,
    ) => Promise<void>;
    renderAnnotationEditorLayerForPage: (pageNumber: number) => Promise<boolean>;
    isPageRendered: (pageNumber: number) => boolean;
    invalidatePages: (pages: number[]) => void;
    hideManagedAnnotationEditors: (pageNumber?: number) => void;
}

export function createAttachablePdfAnnotationRenderingPort() {
    let attachedPort: IPdfAnnotationRenderingPort | null = null;

    function getAttachedPort() {
        if (!attachedPort) {
            throw new Error('PDF annotation rendering port has not been attached');
        }
        return attachedPort;
    }

    const port: IPdfAnnotationRenderingPort = {
        renderVisiblePages: (range, options) => getAttachedPort().renderVisiblePages(range, options),
        renderAnnotationEditorLayerForPage: pageNumber => (
            getAttachedPort().renderAnnotationEditorLayerForPage(pageNumber)
        ),
        isPageRendered: pageNumber => getAttachedPort().isPageRendered(pageNumber),
        invalidatePages: pages => getAttachedPort().invalidatePages(pages),
        hideManagedAnnotationEditors: pageNumber => (
            getAttachedPort().hideManagedAnnotationEditors(pageNumber)
        ),
    };

    return {
        port,
        attachRenderingPort(nextPort: IPdfAnnotationRenderingPort) {
            attachedPort = nextPort;
        },
    };
}
