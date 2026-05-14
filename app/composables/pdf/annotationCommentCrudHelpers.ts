import type { AnnotationEditorUIManager } from 'pdfjs-dist';
import { clamp } from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import {
    getCommentCandidateIds,
    editorIdsLikelyMatch,
} from '@app/composables/pdf/annotationCommentIdentity';
import { normalizeMarkerRect } from '@app/composables/pdf/annotationGeometry';
import { getEditorsOnPage } from '@app/services/pdfjs/annotationEditorAdapter';

export interface IEditorTargetMatch {
    editor: IPdfjsEditor;
    pageIndex: number;
    targetAnnotationId: string | null;
}

function getPreferredPageScanOrder(pageIndex: number, numPages: number) {
    const preferredPage = clamp(pageIndex, 0, Math.max(0, numPages - 1));
    return [
        preferredPage,
        ...Array.from({ length: numPages }, (_, index) => index).filter(index => index !== preferredPage),
    ];
}

export function findEditorForComment(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    comment: IAnnotationCommentSummary,
    getEditorIdentity: (editor: IPdfjsEditor, pageIndex: number) => string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    const candidateIds = getCommentCandidateIds(comment);
    if (candidateIds.length === 0) {
        return null;
    }

    for (const pageIndex of getPreferredPageScanOrder(comment.pageIndex, numPages)) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
            const editorIdentity = getEditorIdentity(normalizedEditor, pageIndex);
            if (
                candidateIds.some(candidateId => (
                    editorIdsLikelyMatch(editorIdentity, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.uid ?? null, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.annotationElementId ?? null, candidateId)
                    || editorIdsLikelyMatch(normalizedEditor.id ?? null, candidateId)
                ))
            ) {
                return normalizedEditor;
            }
        }
    }

    return null;
}

export function findEditorByAnnotationElementId(
    uiManager: AnnotationEditorUIManager | null,
    numPages: number,
    pageIndex: number,
    annotationId: string,
) {
    if (!uiManager || numPages <= 0) {
        return null;
    }

    for (const candidatePageIndex of getPreferredPageScanOrder(pageIndex, numPages)) {
        for (const normalizedEditor of getEditorsOnPage(uiManager, candidatePageIndex)) {
            if (normalizedEditor.annotationElementId === annotationId) {
                return normalizedEditor;
            }
        }
    }

    return null;
}

export function findEditorFromTarget(
    uiManager: AnnotationEditorUIManager | null,
    target: HTMLElement,
    currentPage: number,
): IEditorTargetMatch | null {
    if (!uiManager) {
        return null;
    }

    const targetAnnotationId = target.closest<HTMLElement>('[data-annotation-id]')
        ?.dataset.annotationId
        ?? null;

    const editorElement = target.closest<HTMLElement>(
        '.annotation-editor-layer .highlightEditor, .annotation-editor-layer .freeTextEditor, .annotation-editor-layer .inkEditor, .annotationEditorLayer .highlightEditor, .annotationEditorLayer .freeTextEditor, .annotationEditorLayer .inkEditor',
    );
    if (!editorElement) {
        return null;
    }

    const pageContainer = editorElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    for (const normalizedEditor of getEditorsOnPage(uiManager, pageIndex)) {
        const editorDiv = normalizedEditor.div;
        if (!editorDiv) {
            continue;
        }
        if (editorDiv === editorElement || editorDiv.contains(target)) {
            return {
                editor: normalizedEditor,
                pageIndex,
                targetAnnotationId,
            };
        }
    }

    return null;
}

export function findPdfAnnotationSummaryFromTarget(
    target: HTMLElement,
    currentPage: number,
    annotationCommentsCache: IAnnotationCommentSummary[],
) {
    const annotationElement = target.closest<HTMLElement>(
        '.annotationLayer [data-annotation-id], .annotation-layer [data-annotation-id]',
    );
    if (!annotationElement) {
        return null;
    }

    const annotationId = annotationElement.dataset.annotationId ?? annotationElement.getAttribute('data-annotation-id');
    if (!annotationId) {
        return null;
    }

    const pageContainer = annotationElement.closest<HTMLElement>('.page_container');
    const pageNumber = pageContainer?.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    const pageIndex = Math.max(0, pageNumber - 1);

    return annotationCommentsCache.find(c => (
        c.annotationId === annotationId && c.pageIndex === pageIndex
    )) ?? annotationCommentsCache.find(c => c.annotationId === annotationId) ?? null;
}

export function findAnnotationSummaryFromPoint(
    target: HTMLElement,
    clientX: number,
    clientY: number,
    currentPage: number,
    annotationCommentsCache: IAnnotationCommentSummary[],
    findPageContainerFromClientPoint: (cx: number, cy: number) => HTMLElement | null,
) {
    const pageContainer = target.closest<HTMLElement>('.page_container')
        ?? findPageContainerFromClientPoint(clientX, clientY);
    if (!pageContainer) {
        return null;
    }

    const pageNumber = pageContainer.dataset.page
        ? Number(pageContainer.dataset.page)
        : currentPage;
    if (!Number.isFinite(pageNumber) || pageNumber <= 0) {
        return null;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return null;
    }

    const x = (clientX - pageRect.left) / pageRect.width;
    const y = (clientY - pageRect.top) / pageRect.height;
    const toleranceX = 14 / pageRect.width;
    const toleranceY = 14 / pageRect.height;

    let bestSummary: IAnnotationCommentSummary | null = null;
    let bestScore = Number.POSITIVE_INFINITY;

    annotationCommentsCache.forEach((summary) => {
        if (summary.pageNumber !== pageNumber) {
            return;
        }
        const rect = normalizeMarkerRect(summary.markerRect);
        if (!rect) {
            return;
        }

        const left = rect.left - toleranceX;
        const top = rect.top - toleranceY;
        const right = rect.left + rect.width + toleranceX;
        const bottom = rect.top + rect.height + toleranceY;

        if (x < left || x > right || y < top || y > bottom) {
            return;
        }

        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const distanceScore = ((x - centerX) ** 2 + (y - centerY) ** 2) * 10000;
        const areaScore = rect.width * rect.height;
        const score = distanceScore + areaScore;

        if (score < bestScore) {
            bestScore = score;
            bestSummary = summary;
        }
    });

    return bestSummary;
}
