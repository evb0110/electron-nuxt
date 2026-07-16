import type {IDocumentViewerChassisAuthority} from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type {IDocumentOpenSurfaceRenderOwner} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

interface IPdfResidentCanvasAdopterOptions {
    authority: IDocumentViewerChassisAuthority | null;
    renderOwner: IDocumentOpenSurfaceRenderOwner | undefined;
    isPageCanvasCommitted: (pageNumber: number) => boolean;
    resolveInitialCanvas: (generation: number, pageNumber: number) => void;
    tryCompleteInitialVisual: (pageNumber: number) => void;
}

/** Joins a fresh resident PDF raster to the current shared viewport intent. */
export function createPdfResidentCanvasAdopter(options: IPdfResidentCanvasAdopterOptions) {
    return (pageNumber: number) => {
        if (!options.authority || !options.renderOwner || !options.isPageCanvasCommitted(pageNumber)) {
            return false;
        }
        const surface = options.authority.openSurface;
        const snapshot = surface.snapshot.value;
        if (snapshot.identity === null || surface.viewportSession.value.requestedPage !== pageNumber) {
            return false;
        }
        const fence = surface.createOwnedResidentRenderFence(options.renderOwner, {
            generation: snapshot.generation,
            documentRevision: snapshot.identity.documentRevision,
            pageNumber,
        });
        if (!fence || !surface.commitCanvas(fence)) {
            return false;
        }
        options.resolveInitialCanvas(snapshot.generation, pageNumber);
        options.tryCompleteInitialVisual(pageNumber);
        return true;
    };
}
