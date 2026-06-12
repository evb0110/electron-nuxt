import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import {
    clamp,
    range,
} from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';
import { isBetterMarkerRectMatch } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-matcher/isBetterMarkerRectMatch';
import { scoreMarkerRectEditor } from '@app/modules/pdf-viewer/engine/annotations/annotation-editor-matcher/scoreMarkerRectEditor';

interface IMarkerRectEditorMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    distance: number;
    textScore: number;
}

type TExactMarkerTextMatch = Omit<IMarkerRectEditorMatch, 'textScore'>;

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
    const normalizedPreferredPageIndex = clamp(preferredPageIndex, 0, Math.max(0, numPages - 1));
    return [
        normalizedPreferredPageIndex,
        ...range(numPages).filter(pageIndex => pageIndex !== normalizedPreferredPageIndex),
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
