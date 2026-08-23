import type { PDFDict } from 'pdf-lib';
import type { IAnnotationMarkerRect } from '@app/types/annotations';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import { readPdfRectFromDict } from '@pdf-core';

/**
 * Marker geometry is clamped into the unit page box on import because the
 * overlay renders in that space. A rect that crosses a page edge therefore
 * cannot be reconstructed from marker geometry, and rewriting it on save would
 * permanently shrink a shape the user never touched.
 *
 * A shape counts as untouched when replaying the import projection over the
 * rect the annotation already carries reproduces its live marker geometry. The
 * comparison is a float-equality check with room for transport rounding only:
 * the smallest real edit a pointer can produce is orders of magnitude larger.
 */
const UNTOUCHED_MARKER_RECT_EPSILON = 1e-9;

export function isImportedShapeRectUnchanged(
    annotDict: PDFDict,
    markerRect: IAnnotationMarkerRect,
    pageView: number[],
    pageRotation: TPageRotation,
) {
    const importedMarkerRect = normalizeMarkerRect(
        toMarkerRectFromPdfRect(readPdfRectFromDict(annotDict), pageView, pageRotation),
    );
    if (!importedMarkerRect) {
        return false;
    }

    return Math.abs(importedMarkerRect.left - markerRect.left) <= UNTOUCHED_MARKER_RECT_EPSILON
        && Math.abs(importedMarkerRect.top - markerRect.top) <= UNTOUCHED_MARKER_RECT_EPSILON
        && Math.abs(importedMarkerRect.width - markerRect.width) <= UNTOUCHED_MARKER_RECT_EPSILON
        && Math.abs(importedMarkerRect.height - markerRect.height) <= UNTOUCHED_MARKER_RECT_EPSILON;
}
