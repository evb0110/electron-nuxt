import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';

export function resolveCommentIndicatorViewportPosition(
    comment: Pick<IAnnotationCommentSummary, 'markerRect' | 'pageNumber'>,
    options: {
        pageContainer?: HTMLElement | null;
        pageRoot?: ParentNode | null;
        fallback?: {
            x: number;
            y: number 
        } | null;
    } = {},
) {
    const markerRect = normalizeMarkerRect(comment.markerRect);
    if (!markerRect) {
        return options.fallback ?? null;
    }
    const pageContainer = options.pageContainer
        ?? options.pageRoot?.querySelector<HTMLElement>(`.page_container[data-page="${comment.pageNumber}"]`)
        ?? null;
    if (!pageContainer) {
        return options.fallback ?? null;
    }

    const pageRect = pageContainer.getBoundingClientRect();
    if (pageRect.width <= 0 || pageRect.height <= 0) {
        return options.fallback ?? null;
    }

    return {
        x: pageRect.left + (markerRect.left + markerRect.width) * pageRect.width,
        y: pageRect.top + markerRect.top * pageRect.height,
    };
}
