import type {
    PDFArray,
    PDFDocument,
} from 'pdf-lib';
import { groupBy } from 'es-toolkit/array';
import {
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
} from 'pdf-lib';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import type { normalizePageRotation} from '@app/composables/pdf/annotationGeometry';
import {
    markerRectIoU,
    toMarkerRectFromPdfRect,
    toPdfRectFromMarkerRect,
} from '@app/composables/pdf/annotationGeometry';
import {
    getPdfDictContents,
    getPdfStringValue,
} from '@app/utils/pdfDict';
import {
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/composables/pdf/pdfSerializationRefs';
import { readPdfRectFromDict } from '@app/composables/pdf/pdfPageBoxes';
import {
    iterateAnnotationRefDicts,
    resolvePageAnnotationContext,
} from '@app/composables/pdf/pdfPageAnnotationIteration';
import { toPdfDateString } from '@app/utils/pdfDate';
import {
    appendAnnotationRefToPage,
    isAnnotationMarkerRect,
    toFreeTextNoteMarkerRect,
} from './pdfSerializationShared';
import { setRgbColor } from './pdfSerializationColors';
import { resolveShapePageContext } from './pdfSerializationGeometry';

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
    return `${ref.objectNumber}R${ref.generationNumber}`;
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

            dict.set(rectName, toPdfRectArray(doc, pdfRect));

            if (!blankApRef) {
                blankApRef = doc.context.register(doc.context.formXObject([], {}));
            }
            dict.set(apName, doc.context.obj({ N: blankApRef }));
            modified = true;
        }
    });

    return modified;
}

function isReplayableNewFreeTextNoteComment(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(comment.markerRect)
        && (subtype === 'freetext' || subtype === 'typewriter');
}

function createBlankAppearanceRef(doc: PDFDocument) {
    return doc.context.register(doc.context.formXObject([], {}));
}

function getReplayableNewFreeTextNoteName(comment: IAnnotationCommentSummary) {
    const rawKey = comment.stableKey || comment.uid || comment.id || comment.annotationId;
    return rawKey ? `evb-note:${rawKey}` : null;
}

function findExistingReplayableNewFreeTextNote(
    doc: PDFDocument,
    annots: PDFArray | undefined,
    noteName: string | null,
) {
    if (!annots || !noteName) {
        return null;
    }

    const nameKey = PDFName.of('NM');
    for (const {
        dict,
        ref,
    } of iterateAnnotationRefDicts(doc, annots)) {
        const name = getPdfStringValue(dict.get(nameKey));
        if (name === noteName) {
            return {
                dict,
                ref,
            };
        }
    }
    return null;
}

function resolvePopupRefForAnnotation(doc: PDFDocument, annotDict: PDFDict) {
    const popupValue = annotDict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFRef && doc.context.lookupMaybe(popupValue, PDFDict)) {
        return popupValue;
    }
    return null;
}

export function applyNewFreeTextNoteAnnotations(doc: PDFDocument, comments: IAnnotationCommentSummary[]) {
    const candidates = comments.filter(isReplayableNewFreeTextNoteComment);
    if (candidates.length === 0) {
        return false;
    }

    let modified = false;
    const modifiedAt = toPdfDateString(new Date());
    let blankApRef: PDFRef | null = null;
    const commentsByPage = groupBy(candidates, comment => comment.pageIndex);

    Object.entries(commentsByPage).forEach(([
        pageIndex,
        pageComments,
    ]) => {
        const page = doc.getPages()[Number(pageIndex)];
        if (!page) {
            return;
        }
        const context = resolveShapePageContext(page);
        if (!context) {
            return;
        }

        pageComments.forEach((comment) => {
            const markerRect = toFreeTextNoteMarkerRect(comment.markerRect);
            if (!markerRect) {
                return;
            }

            const pdfRect = toPdfRectFromMarkerRect(
                markerRect,
                context.pageView,
                context.pageRotation,
            );
            if (!pdfRect) {
                return;
            }

            if (!blankApRef) {
                blankApRef = createBlankAppearanceRef(doc);
            }

            const noteName = getReplayableNewFreeTextNoteName(comment);
            const existing = findExistingReplayableNewFreeTextNote(doc, page.node.Annots(), noteName);
            const annotDict = existing?.dict ?? doc.context.obj({
                Type: PDFName.of('Annot'),
                Subtype: PDFName.of('FreeText'),
                F: PDFNumber.of(4),
            });
            annotDict.set(PDFName.of('Rect'), toPdfRectArray(doc, pdfRect));
            annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(comment.text ?? ''));
            annotDict.set(PDFName.of('M'), PDFString.of(modifiedAt));
            annotDict.set(PDFName.of('T'), PDFHexString.fromText(comment.author || ''));
            annotDict.set(PDFName.of('AP'), doc.context.obj({ N: blankApRef }));
            if (noteName) {
                annotDict.set(PDFName.of('NM'), PDFHexString.fromText(noteName));
            }
            setRgbColor(annotDict, doc, 'C', comment.color ?? undefined);
            setRgbColor(annotDict, doc, 'IC', comment.color ?? undefined);

            const annotRef = existing?.ref ?? doc.context.register(annotDict);
            const existingPopupRef = resolvePopupRefForAnnotation(doc, annotDict);
            const popupDict = existingPopupRef
                ? doc.context.lookup(existingPopupRef, PDFDict)
                : doc.context.obj({
                    Type: PDFName.of('Annot'),
                    Subtype: PDFName.of('Popup'),
                    F: PDFNumber.of(28),
                });
            popupDict.set(PDFName.of('Parent'), annotRef);
            popupDict.set(PDFName.of('Rect'), toPdfRectArray(doc, pdfRect));
            popupDict.set(PDFName.of('Contents'), PDFHexString.fromText(comment.text ?? ''));
            popupDict.set(PDFName.of('M'), PDFString.of(modifiedAt));
            popupDict.set(PDFName.of('T'), PDFHexString.fromText(comment.author || ''));
            const popupRef = existingPopupRef ?? doc.context.register(popupDict);
            annotDict.set(PDFName.of('Popup'), popupRef);

            if (!existing) {
                appendAnnotationRefToPage(page, doc, annotRef);
            }
            if (!existingPopupRef) {
                appendAnnotationRefToPage(page, doc, popupRef);
            }
            modified = true;
        });
    });

    return modified;
}
