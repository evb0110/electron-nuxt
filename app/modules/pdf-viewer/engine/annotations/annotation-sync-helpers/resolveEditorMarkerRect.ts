import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/markerRectCenterDistance';
import { normalizeMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizeMarkerRect';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { toMarkerRectFromEditorRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromEditorRect';
import { toMarkerRectFromEditor } from '@app/modules/pdf-viewer/engine/pdf-annotation-editor-utils/toMarkerRectFromEditor';
import { getOptionalNumber } from '@app/services/pdfjs/runtime';
import { getPdfjsEditorFacadeState } from '@app/modules/pdf-viewer/engine/annotations/bridge/getPdfjsEditorFacadeState';

const PENDING_ANCHOR_DISTANCE_THRESHOLD = 0.14;

const MAX_FREETEXT_NOTE_MARKER_SIZE = 0.02;

export function resolveEditorMarkerRect(editor: IPdfjsEditor) {
    const editorRotation = normalizePageRotation(
        getOptionalNumber(editor, 'pageRotation')
        ?? getOptionalNumber(editor, 'rotation')
        ?? 0,
    );
    const directEditorRect = normalizeMarkerRect({
        left: editor.x ?? Number.NaN,
        top: editor.y ?? Number.NaN,
        width: editor.width ?? Number.NaN,
        height: editor.height ?? Number.NaN,
    });
    const markerRectFromEditor = directEditorRect
        ? toMarkerRectFromEditorRect(directEditorRect, editorRotation)
        : toMarkerRectFromEditor(editor);
    const pendingAnchorRect = normalizeMarkerRect(getPdfjsEditorFacadeState(editor).pendingAnchorRect ?? null);
    const markerDistanceFromPending = markerRectCenterDistance(markerRectFromEditor, pendingAnchorRect);
    const hasPointSizedPendingAnchor = Boolean(
        pendingAnchorRect
        && pendingAnchorRect.width <= MAX_FREETEXT_NOTE_MARKER_SIZE
        && pendingAnchorRect.height <= MAX_FREETEXT_NOTE_MARKER_SIZE,
    );
    const shouldUsePendingAnchor = Boolean(
        pendingAnchorRect
        && (
            hasPointSizedPendingAnchor
            || !markerRectFromEditor
            || markerDistanceFromPending > PENDING_ANCHOR_DISTANCE_THRESHOLD
        ),
    );
    const markerRect = shouldUsePendingAnchor
        ? pendingAnchorRect
        : markerRectFromEditor;

    return {
        markerRect,
        markerRectFromEditor,
        pendingAnchorRect,
        markerDistanceFromPending,
        shouldUsePendingAnchor,
    };
}
