import type {
    IAnnotationCommentSummary,
    IAnnotationSettings,
} from '@app/types/annotations';
import { DEFAULT_ANNOTATION_SETTINGS } from '@app/constants/annotationDefaults';
import { drawEditedTextMarkupCanvasVisual } from '@app/utils/pdf-viewer/annotations/annotation-edited-text-markup-canvas/drawEditedTextMarkupCanvasVisual';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';

export function getEditedTextMarkupThumbnailComments(comments: readonly IAnnotationCommentSummary[]) {
    return comments.filter(comment => (
        comment.colorEdited === true
        && Boolean(comment.color)
        && Boolean(comment.markerRect)
        && isTextMarkupSubtype(comment.subtype)
    ));
}

export function createHiddenAnnotationIdsSignature(hiddenAnnotationIdSet: ReadonlySet<string>) {
    return [...hiddenAnnotationIdSet].sort((left, right) => left.localeCompare(right)).join('\u0000');
}

export function createEditedTextMarkupThumbnailVisualSignature(
    comments: readonly IAnnotationCommentSummary[],
    annotationSettings: IAnnotationSettings | null | undefined,
) {
    return comments
        .map((comment) => [
            comment.stableKey,
            comment.annotationId ?? '',
            comment.pageNumber,
            comment.subtype ?? '',
            comment.color ?? '',
            (comment.subtype ?? '').trim().toLowerCase() === 'highlight'
                ? annotationSettings?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity
                : '',
            comment.markerRect?.left ?? '',
            comment.markerRect?.top ?? '',
            comment.markerRect?.width ?? '',
            comment.markerRect?.height ?? '',
        ].join('\u0001'))
        .sort((left, right) => left.localeCompare(right))
        .join('\u0000');
}

function resolveThumbnailTextMarkupColor(comment: IAnnotationCommentSummary) {
    return comment.color?.trim() || null;
}

function resolveThumbnailTextMarkupHighlightOpacity(
    comment: IAnnotationCommentSummary,
    annotationSettings: IAnnotationSettings | null | undefined,
) {
    if ((comment.subtype ?? '').trim().toLowerCase() !== 'highlight') {
        return null;
    }
    return annotationSettings?.highlightOpacity ?? DEFAULT_ANNOTATION_SETTINGS.highlightOpacity;
}

export function drawEditedTextMarkupThumbnailVisuals(options: {
    pageNum: number;
    canvas: HTMLCanvasElement;
    context: CanvasRenderingContext2D;
    comments: readonly IAnnotationCommentSummary[];
    annotationSettings: IAnnotationSettings | null | undefined;
}) {
    options.comments
        .filter(comment => Math.floor(comment.pageNumber) === options.pageNum)
        .forEach((comment) => {
            const color = resolveThumbnailTextMarkupColor(comment);
            if (color) {
                drawEditedTextMarkupCanvasVisual(
                    options.canvas,
                    options.context,
                    comment,
                    color,
                    { highlightOpacity: resolveThumbnailTextMarkupHighlightOpacity(comment, options.annotationSettings) },
                );
            }
        });
}
