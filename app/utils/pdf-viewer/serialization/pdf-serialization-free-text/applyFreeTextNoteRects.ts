import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { markerRectIoU } from '@app/utils/pdf-viewer/annotation-geometry/markerRectIoU';
import { toMarkerRectFromPdfRect } from '@app/utils/pdf-viewer/annotation-geometry/toMarkerRectFromPdfRect';
import { toPdfRectFromMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/toPdfRectFromMarkerRect';
import { getPdfDictContents } from '@app/utils/pdfDict';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
} from '@app/utils/pdfAnnotationRefs';
import { readPdfRectFromDict } from '@app/utils/pdf-viewer/pdf-page-boxes/readPdfRectFromDict';
import { iterateAnnotationRefDicts } from '@app/utils/pdf-viewer/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import { resolvePageAnnotationContext } from '@app/utils/pdf-viewer/pdf-page-annotation-iteration/resolvePageAnnotationContext';
import { isAnnotationMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/isAnnotationMarkerRect';
import { toFreeTextNoteMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';

function forEachPageAnnotationContext(
    doc: PDFDocument,
    callback: (
        pageIndex: number,
        context: NonNullable<ReturnType<typeof resolvePageAnnotationContext>>,
    ) => void,
) {
    const pages = doc.getPages();
    for (const [
        pageIndex,
        page,
    ] of pages.entries()) {
        const context = resolvePageAnnotationContext(page);
        if (!context) {
            continue;
        }
        callback(pageIndex, context);
    }
}

function freeTextRefTag(ref: PDFRef) {
    return formatPdfJsAnnotationRef(ref);
}

function findFreeTextCommentMatch(
    dict: PDFDict,
    ref: PDFRef,
    pageComments: IAnnotationCommentSummary[],
    pageFreeTextPopupCount: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
): IAnnotationCommentSummary | null {
    const dictRect = toMarkerRectFromPdfRect(
        readPdfRectFromDict(dict),
        pageView,
        pageRotation,
    );
    const refTag = freeTextRefTag(ref);
    const dictText = getPdfDictContents(dict).trim().toLowerCase();

    let bestMatch: {
        comment: IAnnotationCommentSummary;
        score: number;
    } | null = null;
    for (const comment of pageComments) {
        if (!isAnnotationMarkerRect(comment.markerRect)) {
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
    if (singleComment && isAnnotationMarkerRect(singleComment.markerRect)) {
        return singleComment;
    }
    return null;
}

function toPdfRectArray(
    doc: PDFDocument,
    pdfRect: readonly [number, number, number, number],
) {
    return doc.context.obj([
        PDFNumber.of(pdfRect[0]),
        PDFNumber.of(pdfRect[1]),
        PDFNumber.of(pdfRect[2]),
        PDFNumber.of(pdfRect[3]),
    ]);
}

export function applyFreeTextNoteRects(doc: PDFDocument, comments: IAnnotationCommentSummary[]) {
    if (comments.length === 0) {
        return false;
    }

    const subtypeName = PDFName.of('Subtype');
    const freeTextName = PDFName.of('FreeText');
    const rectName = PDFName.of('Rect');
    const popupName = PDFName.of('Popup');
    const apName = PDFName.of('AP');
    let modified = false;
    let blankApRef: PDFRef | null = null;

    forEachPageAnnotationContext(doc, (pageIndex, context) => {
        const pageComments = comments.filter(comment => comment.pageIndex === pageIndex && isAnnotationMarkerRect(comment.markerRect));
        if (pageComments.length === 0) {
            return;
        }

        const freeTextPopupAnnotations = Array.from(iterateAnnotationRefDicts(doc, context.annots))
            .filter(({ dict }) => {
                const currentSubtype = dict.get(subtypeName);
                return currentSubtype instanceof PDFName
                    && currentSubtype === freeTextName
                    && Boolean(dict.get(popupName));
            });

        for (const {
            dict,
            ref,
        } of freeTextPopupAnnotations) {
            const matchedComment = findFreeTextCommentMatch(
                dict,
                ref,
                pageComments,
                freeTextPopupAnnotations.length,
                context.pageView,
                context.pageRotation,
            );
            const markerRect = matchedComment
                ? toFreeTextNoteMarkerRect(matchedComment.markerRect)
                : null;
            if (!markerRect) {
                continue;
            }

            const pdfRect = toPdfRectFromMarkerRect(
                markerRect,
                context.pageView,
                context.pageRotation,
            );
            if (!pdfRect) {
                continue;
            }

            const rectArray = toPdfRectArray(doc, pdfRect);
            dict.set(rectName, rectArray);
            const popupValue = dict.get(popupName);
            const popupDict = popupValue instanceof PDFRef
                ? doc.context.lookupMaybe(popupValue, PDFDict) ?? null
                : popupValue instanceof PDFDict
                    ? popupValue
                    : null;
            popupDict?.set(rectName, toPdfRectArray(doc, pdfRect));

            if (!blankApRef) {
                blankApRef = doc.context.register(doc.context.formXObject([], {}));
            }
            dict.set(apName, doc.context.obj({ N: blankApRef }));
            modified = true;
        }
    });

    return modified;
}
