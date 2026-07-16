import type { IPdfViewportPositionCommit } from '@app/modules/pdf-viewer/runtime/viewport/createViewportAuthority';
import type { IDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { resolveDocumentViewportCurrentPage } from '@app/utils/document-viewer/session/documentViewportSession';

function projectPdfUserViewportPage(
    authority: IDocumentViewerChassisAuthority | null | undefined,
    pageNumber: number,
    emitCurrentPage: (page: number) => void,
) {
    const page = authority?.observePage(pageNumber, {supersedeNavigation: true}) ?? pageNumber;
    emitCurrentPage(page);
}

export function createPdfOpenSurfaceViewportCallbacks(
    authority: IDocumentViewerChassisAuthority | null | undefined,
    emitCurrentPage: (page: number) => void,
    onNavigationViewportCommitted: (page: number) => void,
) {
    return {
        onUserViewportPageObserved: (page: number) => {
            projectPdfUserViewportPage(authority, page, emitCurrentPage);
        },
        onViewportPositionCommitted: (commit: IPdfViewportPositionCommit) => {
            if (commit.intentKind === 'user-scroll') {
                return;
            }
            if (projectPdfViewportPositionCommit(authority?.openSurface, commit, emitCurrentPage)) {
                onNavigationViewportCommitted(commit.page);
                return;
            }
            projectPdfSettledProgrammaticPage(authority, commit, emitCurrentPage);
        },
    };
}

function projectPdfSettledProgrammaticPage(
    authority: IDocumentViewerChassisAuthority | null | undefined,
    commit: IPdfViewportPositionCommit,
    emitCurrentPage: (page: number) => void,
) {
    const surface = authority?.openSurface;
    if (
        !surface
        || surface.viewportSession.value.lifecycle !== 'ready'
        || ![
            'navigate',
            'search',
            'wheel-page',
        ].includes(commit.intentKind)
    ) {
        return false;
    }
    const page = authority.observePage(commit.page);
    emitCurrentPage(page);
    return true;
}

export function shouldProjectPdfViewportCommitPage(
    surface: IDocumentOpenSurfaceSession,
    commit: IPdfViewportPositionCommit,
) {
    const viewport = surface.viewportSession.value;
    // The shared surface owns page commands. A PDF-local position commit may
    // settle that command, but it must never create or retarget one: there is
    // no shared intent id on this callback with which to distinguish a late
    // commit from the live command. User scrolling is projected separately
    // through the chassis observation channel.
    return viewport.requestedPage === commit.page
        && resolveDocumentViewportCurrentPage(viewport) === commit.page;
}

function projectPdfViewportPositionCommit(
    surface: IDocumentOpenSurfaceSession | null | undefined,
    commit: IPdfViewportPositionCommit,
    emitCurrentPage: (page: number) => void,
) {
    if (!surface) {
        emitCurrentPage(commit.page);
        return false;
    }
    if (!shouldProjectPdfViewportCommitPage(surface, commit)) {
        return false;
    }
    surface.requestNavigation(commit.page);
    emitCurrentPage(commit.page);
    return commitPdfOpenSurfaceViewport(surface, commit);
}

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
