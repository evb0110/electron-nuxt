import type { IDocumentOpenSurfaceSnapshot } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

export function resolvePdfPreparedOpeningFitScale(
    snapshot: IDocumentOpenSurfaceSnapshot,
    usesCustomZoom: boolean,
): number | null {
    const frame = snapshot.openingPageFrame;
    const geometry = snapshot.openingPageGeometry;
    const isOpening = snapshot.phase === 'pending'
        || snapshot.phase === 'geometry-committed'
        || snapshot.phase === 'canvas-committed'
        || snapshot.phase === 'viewport-committed';
    if (
        usesCustomZoom
        || !isOpening
        || !frame
        || !geometry
        || frame.generation !== snapshot.generation
        || frame.pageNumber !== geometry.pageNumber
        || geometry.width <= 0
    ) {
        return null;
    }

    // The prepared frame is the synchronous layout authority. Seed the
    // renderer from that exact geometry so its first canonical canvas occupies
    // the same box; normal metric calculation verifies it once metadata exists.
    const preparedWidth = Number.parseFloat(frame.style.width ?? '');
    return Number.isFinite(preparedWidth) && preparedWidth > 0
        ? preparedWidth / geometry.width
        : null;
}
