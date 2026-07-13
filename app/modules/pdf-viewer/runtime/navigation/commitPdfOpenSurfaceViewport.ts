import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

/**
 * Projects a settled PDF viewport position into the shared document surface.
 *
 * PDF.js has its own semantic viewport authority, whose intent ids describe
 * layout work such as `viewport-observed-*`. The document surface owns the
 * cross-viewer open/navigation intent. A viewport commit must therefore carry
 * the surface's exact live intent id, not copy the PDF-local id. Page and
 * generation checks keep a late PDF commit from being relabelled as a newer
 * surface intent.
 */
export function commitPdfOpenSurfaceViewport(
    surface: IDocumentOpenSurfaceSession,
    commit: IPdfViewportPositionCommit,
) {
    const snapshot = surface.snapshot.value;
    const viewport = surface.viewportSession.value;
    const intent = viewport.viewportIntent;
    if (
        snapshot.identity === null
        || intent === null
        || intent.generation !== viewport.generation
        || viewport.requestedPage !== commit.page
        || intent.pageNumber !== commit.page
    ) {
        return false;
    }
    return surface.commitViewport({
        generation: snapshot.generation,
        documentRevision: snapshot.identity.documentRevision,
        viewportIntentId: intent.id,
        documentGeometryRevision: commit.geometryRevision,
        interactionEpoch: commit.interactionEpoch,
        pageNumber: commit.page,
        left: commit.left,
        top: commit.top,
    });
}
