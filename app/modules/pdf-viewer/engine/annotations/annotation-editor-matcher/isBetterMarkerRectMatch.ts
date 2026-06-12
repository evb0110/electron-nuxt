import type { IMarkerRectEditorMatch } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-matcher/markerRectEditorMatch';


export function isBetterMarkerRectMatch(
    candidate: IMarkerRectEditorMatch,
    best: IMarkerRectEditorMatch | null,
) {
    return (
        !best
        || candidate.distance < best.distance
        || (Math.abs(candidate.distance - best.distance) <= 0.01 && candidate.textScore > best.textScore)
    );
}
