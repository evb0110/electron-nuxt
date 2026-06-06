import type { IPdfjsEditor } from '@app/types/pdfjs';

interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}

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
