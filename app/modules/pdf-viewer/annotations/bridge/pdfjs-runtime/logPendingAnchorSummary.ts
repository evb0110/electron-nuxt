import type { resolveEditorMarkerRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveEditorMarkerRect';
import { BrowserLogger } from '@app/utils/browserLogger';

/**
 * Traces an editor summary whose marker rect came from the pending anchor
 * rather than from the editor itself. Silent for every other summary.
 */
export function logPendingAnchorSummary(
    pageIndex: number,
    id: string,
    uid: string | null,
    annotationId: string | null,
    resolvedSubtype: string | null | undefined,
    hasNote: boolean,
    text: string,
    rectResult: ReturnType<typeof resolveEditorMarkerRect>,
) {
    if (!rectResult.shouldUsePendingAnchor) {
        return;
    }

    BrowserLogger.debug('note-anchor', 'toEditorSummary', {
        pageIndex,
        pageNumber: pageIndex + 1,
        id,
        uid,
        annotationId,
        subtype: resolvedSubtype ?? null,
        hasNote,
        textLength: text.length,
        markerRectFromEditor: rectResult.markerRectFromEditor,
        pendingAnchorRect: rectResult.pendingAnchorRect,
        markerDistanceFromPending: rectResult.markerDistanceFromPending,
        shouldUsePendingAnchor: rectResult.shouldUsePendingAnchor,
        markerRect: rectResult.markerRect,
    });
}
