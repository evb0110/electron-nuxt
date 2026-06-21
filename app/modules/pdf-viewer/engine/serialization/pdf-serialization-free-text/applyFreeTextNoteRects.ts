import type { PDFDocument } from 'pdf-lib';
import {
    PDFDict,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import { toPdfRectFromMarkerRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toPdfRectFromMarkerRect';
import { iterateAnnotationRefDicts } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import { resolvePageAnnotationContext } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/resolvePageAnnotationContext';
import { isAnnotationMarkerRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/isAnnotationMarkerRect';
import { toFreeTextNoteMarkerRect } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { findFreeTextCommentMatch } from '@app/modules/pdf-viewer/engine/serialization/pdf-serialization-free-text/findFreeTextCommentMatch';

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
        const claimedComments = new Set<IAnnotationCommentSummary>();

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
                { claimedComments },
            );
            if (!matchedComment) {
                continue;
            }

            const markerRect = toFreeTextNoteMarkerRect(matchedComment.markerRect);
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
            claimedComments.add(matchedComment);

            const rectArray = toPdfRectArray(doc, pdfRect);
            dict.set(rectName, rectArray);
            const popupValue = dict.get(popupName);
            const popupDict = popupValue instanceof PDFRef
                ? doc.context.lookupMaybe(popupValue, PDFDict) ?? null
                : popupValue instanceof PDFDict
                    ? popupValue
                    : null;
            popupDict?.set(rectName, toPdfRectArray(doc, pdfRect));

            blankApRef ??= doc.context.register(doc.context.formXObject([], {}));
            dict.set(apName, doc.context.obj({ N: blankApRef }));
            modified = true;
        }
    });

    return modified;
}
