import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import {
    getCommentText,
    toMarkerRectFromEditor,
} from '@app/composables/pdf/pdfAnnotationEditorUtils';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';

interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}

type TExactMarkerTextMatch = Omit<IMarkerRectEditorMatch, 'textScore'>;

export function scoreMarkerRectEditor(
    comment: IAnnotationCommentSummary,
    editor: IPdfjsEditor,
    pageIndex: number,
    targetText: string,
): IMarkerRectEditorMatch {
    const distance = markerRectCenterDistance(
        comment.markerRect,
        toMarkerRectFromEditor(editor),
    );
    const editorText = getCommentText(editor).trim();
    const textScore = (
        targetText.length > 0
        && editorText.length > 0
        && targetText === editorText
    ) ? 1 : 0;
    return {
        editor,
        pageIndex,
        distance,
        textScore,
    };
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

function finiteMarkerDistance(distance: number) {
    return Number.isFinite(distance) ? distance : Number.POSITIVE_INFINITY;
}

function pickBestExactTextMarkerMatch(exactTextMatches: TExactMarkerTextMatch[]) {
    if (exactTextMatches.length === 0) {
        return null;
    }
    const ordered = [...exactTextMatches].sort((l, r) => {
        const ld = finiteMarkerDistance(l.distance);
        const rd = finiteMarkerDistance(r.distance);
        if (ld !== rd) {
            return ld - rd;
        }
        return l.pageIndex - r.pageIndex;
    });
    const bestMatch = ordered[0] ?? null;
    if (!bestMatch) {
        return null;
    }
    if (ordered.length === 1) {
        return bestMatch;
    }
    const secondBest = ordered[1];
    if (!secondBest) {
        return bestMatch;
    }
    const bd = finiteMarkerDistance(bestMatch.distance);
    const sd = finiteMarkerDistance(secondBest.distance);
    if (!Number.isFinite(bd) && !Number.isFinite(sd)) {
        return null;
    }
    if (Math.abs(bd - sd) <= 0.005) {
        return null;
    }
    return bestMatch;
}

function chooseMarkerRectEditorMatch(
    best: IMarkerRectEditorMatch | null,
    exactTextMatches: TExactMarkerTextMatch[],
) {
    const exactMatch = pickBestExactTextMarkerMatch(exactTextMatches);
    if (!best) {
        return exactMatch?.editor ?? null;
    }

    const bestDistance = finiteMarkerDistance(best.distance);
    if (bestDistance > 0.16 && best.textScore === 0) {
        if (exactMatch) {
            return exactMatch.editor;
        }
        if (bestDistance > 0.42) {
            return null;
        }
    }
    return best.editor;
}

function pageSearchOrder(preferredPageIndex: number, numPages: number) {
    return [
        Math.max(0, Math.min(preferredPageIndex, numPages - 1)),
        ...Array.from({ length: numPages }, (_, i) => i).filter(i => i !== preferredPageIndex),
    ];
}

export function findEditorByMarkerRect(options: {
    comment: IAnnotationCommentSummary;
    preferredPageIndex: number;
    uiManager: AnnotationEditorUIManager | null;
    numPages: number;
}) {
    if (!options.uiManager || options.numPages <= 0) {
        return null;
    }

    let best: IMarkerRectEditorMatch | null = null;
    const exactTextMatches: TExactMarkerTextMatch[] = [];
    const targetText = options.comment.text.trim();

    for (const pageIndex of pageSearchOrder(options.preferredPageIndex, options.numPages)) {
        for (const normalizedEditor of getEditorsOnPage(options.uiManager, pageIndex)) {
            const candidate = scoreMarkerRectEditor(options.comment, normalizedEditor, pageIndex, targetText);

            if (candidate.textScore === 1) {
                exactTextMatches.push({
                    editor: normalizedEditor,
                    pageIndex,
                    distance: candidate.distance,
                });
            }

            if (isBetterMarkerRectMatch(candidate, best)) {
                best = candidate;
            }
        }
    }

    return chooseMarkerRectEditorMatch(best, exactTextMatches);
}
