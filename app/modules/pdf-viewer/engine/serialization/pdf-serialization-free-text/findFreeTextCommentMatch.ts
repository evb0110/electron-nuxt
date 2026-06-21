import type {
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import { markerRectIoU } from '@app/modules/pdf-viewer/engine/annotation-geometry/markerRectIoU';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import { getPdfDictContents } from '@app/utils/pdfDict';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';
import { readPdfRectFromDict } from '@pdf-core';
import { isAnnotationMarkerRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/isAnnotationMarkerRect';

interface IFindFreeTextCommentMatchOptions { claimedComments?: ReadonlySet<IAnnotationCommentSummary>; }

export function findFreeTextCommentMatch(
    dict: PDFDict,
    ref: PDFRef,
    pageComments: IAnnotationCommentSummary[],
    pageFreeTextPopupCount: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
    options: IFindFreeTextCommentMatchOptions = {},
): IAnnotationCommentSummary | null {
    const dictRect = toMarkerRectFromPdfRect(
        readPdfRectFromDict(dict),
        pageView,
        pageRotation,
    );
    const refTag = formatPdfJsAnnotationRef(ref);
    const dictText = getPdfDictContents(dict).trim().toLowerCase();

    let bestMatch: {
        comment: IAnnotationCommentSummary;
        score: number;
    } | null = null;
    for (const comment of pageComments) {
        if (
            options.claimedComments?.has(comment)
            || !isAnnotationMarkerRect(comment.markerRect)
        ) {
            continue;
        }

        if (normalizePdfJsAnnotationId(comment.annotationId) === refTag) {
            return comment;
        }

        const iou = dictRect ? markerRectIoU(dictRect, comment.markerRect) : 0;
        if (iou > 0.05) {
            if (!bestMatch || iou > bestMatch.score) {
                bestMatch = {
                    comment,
                    score: iou,
                };
            }
            continue;
        }

        if (dictText.length > 0 && comment.text) {
            const commentText = comment.text.trim().toLowerCase();
            if (dictText === commentText) {
                return comment;
            }
        }
    }

    if (bestMatch) {
        return bestMatch.comment;
    }

    const singleComment = pageFreeTextPopupCount === 1 && pageComments.length === 1 ? pageComments[0] : null;
    if (
        singleComment
        && !options.claimedComments?.has(singleComment)
        && isAnnotationMarkerRect(singleComment.markerRect)
    ) {
        return singleComment;
    }
    return null;
}
