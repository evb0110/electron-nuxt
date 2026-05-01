import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    TAnnotationTool,
    TMarkupSubtype,
} from '@app/types/annotations';
import { compareAnnotationCommentSummaries } from '@app/utils/pdf-annotation-comments';

export function isNoteEligible(
    subtype: string | null | undefined,
    hasNote?: boolean,
    source?: 'editor' | 'pdf',
    text?: string,
): boolean {
    if (hasNote === true) {
        return true;
    }

    const normalized = (subtype ?? '').trim().toLowerCase();
    if (
        normalized === 'text'
        || normalized === 'note-linked'
        || normalized === 'freetext'
        || normalized === 'typewriter'
        || normalized === 'note-inline'
        || normalized.includes('popup')
        || normalized.includes('note')
    ) {
        return true;
    }

    return source === 'editor' && typeof text === 'string' && text.trim().length > 0;
}

export function isNoteEligibleComment(comment: IAnnotationCommentSummary | null | undefined): boolean {
    if (!comment) {
        return false;
    }
    return isNoteEligible(comment.subtype, comment.hasNote, comment.source, comment.text);
}

export function compareAnnotations(
    left: IAnnotationCommentSummary,
    right: IAnnotationCommentSummary,
): number {
    return compareAnnotationCommentSummaries(left, right);
}

export function isSelectionMarkupTool(tool: TAnnotationTool): boolean {
    return tool === 'highlight' || tool === 'underline' || tool === 'strikethrough';
}

export function isSelectionInteractionTool(tool: TAnnotationTool): boolean {
    return tool === 'select';
}

export function isAuthoringAnnotationTool(tool: TAnnotationTool): boolean {
    return tool !== 'none' && tool !== 'select';
}

export function isShapeTool(tool: TAnnotationTool): tool is Extract<TAnnotationTool, 'draw' | 'rectangle' | 'circle' | 'line' | 'arrow'> {
    return tool === 'draw' || tool === 'rectangle' || tool === 'circle' || tool === 'line' || tool === 'arrow';
}

export function shouldForceTextMarkup(tool: TAnnotationTool): boolean {
    return tool === 'underline' || tool === 'strikethrough';
}

export const TOOL_TO_MARKUP_SUBTYPE: Partial<Record<TAnnotationTool, TMarkupSubtype>> = {
    underline: 'Underline',
    strikethrough: 'StrikeOut',
};

export function markerRectCenterDistance(
    left: IAnnotationMarkerRect | null | undefined,
    right: IAnnotationMarkerRect | null | undefined,
): number {
    if (!left || !right) {
        return Number.POSITIVE_INFINITY;
    }
    if (left.width <= 0 || left.height <= 0 || right.width <= 0 || right.height <= 0) {
        return Number.POSITIVE_INFINITY;
    }
    const leftCx = left.left + left.width / 2;
    const leftCy = left.top + left.height / 2;
    const rightCx = right.left + right.width / 2;
    const rightCy = right.top + right.height / 2;
    return Math.hypot(leftCx - rightCx, leftCy - rightCy);
}
