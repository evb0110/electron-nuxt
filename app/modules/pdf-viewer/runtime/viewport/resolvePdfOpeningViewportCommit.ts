import type {
    IDocumentOpenSurfaceRenderFence,
    IDocumentOpenSurfaceSession,
} from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IPdfViewportIntent } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';

export function suspendStalePdfViewportIntent(
    activeIntent: Readonly<Pick<IPdfViewportIntent, 'documentRevision'>> | null,
    currentDocumentRevision: number,
    suspendActiveIntent: () => void,
) {
    if (activeIntent === null || activeIntent.documentRevision === currentDocumentRevision) {
        return false;
    }
    suspendActiveIntent();
    return true;
}

export function resolvePdfOpeningViewportCommit(
    surface: IDocumentOpenSurfaceSession,
    activeIntent: Readonly<Pick<IPdfViewportIntent, 'documentRevision'>> | null,
    currentDocumentRevision: number,
    suspendActiveIntent: () => void,
): IDocumentOpenSurfaceRenderFence | null {
    const openingSnapshot = surface.snapshot.value;
    const committedRender = openingSnapshot.committedRender;
    if (
        !committedRender
        || openingSnapshot.committedViewport
        || surface.viewportSession.value.requestedPage !== committedRender.pageNumber
    ) {
        return null;
    }
    if (activeIntent === null) {
        return committedRender;
    }
    if (surface.viewportSession.value.lifecycle !== 'opening') {
        return null;
    }

    if (!suspendStalePdfViewportIntent(activeIntent, currentDocumentRevision, suspendActiveIntent)) {
        return null;
    }
    const currentSnapshot = surface.snapshot.value;
    if (
        currentSnapshot.generation !== openingSnapshot.generation
        || currentSnapshot.identity?.documentRevision !== openingSnapshot.identity?.documentRevision
        || currentSnapshot.committedRender !== committedRender
        || currentSnapshot.committedViewport
        || surface.viewportSession.value.requestedPage !== committedRender.pageNumber
    ) {
        return null;
    }
    return committedRender;
}
