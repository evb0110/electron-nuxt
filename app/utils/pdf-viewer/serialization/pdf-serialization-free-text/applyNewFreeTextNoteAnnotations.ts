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
import type { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { markerRectIoU } from '@app/utils/pdf-viewer/annotation-geometry/markerRectIoU';
import { toMarkerRectFromPdfRect } from '@app/utils/pdf-viewer/annotation-geometry/toMarkerRectFromPdfRect';
import { toPdfRectFromMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/toPdfRectFromMarkerRect';
import {
    getPdfDictContents,
    getPdfStringValue,
} from '@app/utils/pdfDict';
import {
    formatPdfJsAnnotationRef,
    normalizePdfJsAnnotationId,
    parsePdfJsAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';
import { readPdfRectFromDict } from '@pdf-core';
import { iterateAnnotationRefDicts } from '@app/utils/pdf-viewer/pdf-page-annotation-iteration/iterateAnnotationRefDicts';
import { toPdfDateString } from '@app/utils/pdfDate';
import { appendAnnotationRefToPage } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/appendAnnotationRefToPage';
import { isAnnotationMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/isAnnotationMarkerRect';
import { toFreeTextNoteMarkerRect } from '@app/utils/pdf-viewer/serialization/pdf-serialization-shared/toFreeTextNoteMarkerRect';
import { setRgbColor } from '@app/utils/pdf-viewer/serialization/pdf-serialization-colors/setRgbColor';
import { resolveShapePageContext } from '@app/utils/pdf-viewer/serialization/pdf-serialization-geometry/resolveShapePageContext';

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
    const refTag = formatPdfJsAnnotationRef(ref);
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

function isReplayableNewFreeTextNoteComment(comment: IAnnotationCommentSummary) {
    const subtype = comment.subtype?.trim().toLowerCase();
    return comment.source === 'editor'
        && !parsePdfJsAnnotationRef(comment.annotationId)
        && Boolean(comment.hasNote)
        && Boolean(toFreeTextNoteMarkerRect(comment.markerRect))
        && (subtype === 'freetext' || subtype === 'typewriter');
}

function createBlankAppearanceRef(doc: PDFDocument) {
    return doc.context.register(doc.context.formXObject([], {}));
}

function getReplayableNewFreeTextNoteName(comment: IAnnotationCommentSummary) {
    const rawKey = comment.stableKey || comment.uid || comment.id || comment.annotationId;
    if (!rawKey) {
        return null;
    }
    const createdAt = typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
        ? Math.trunc(comment.createdAt)
        : null;
    return createdAt
        ? `evb-note:${rawKey}:created:${createdAt}`
        : `evb-note:${rawKey}`;
}

function hashReplayableNoteNamePart(value: string) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < value.length; index += 1) {
        hash ^= value.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function getReplayableNewFreeTextNoteDisambiguatedName(
    comment: IAnnotationCommentSummary,
    baseName: string | null,
) {
    if (!baseName) {
        return null;
    }

    const createdAt = typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt)
        ? Math.trunc(comment.createdAt)
        : null;
    const markerRect = toFreeTextNoteMarkerRect(comment.markerRect);
    const markerPart = markerRect
        ? [
            markerRect.left,
            markerRect.top,
            markerRect.width,
            markerRect.height,
        ].map(value => Math.round(value * 1_000_000)).join(',')
        : '';
    const stablePart = [
        comment.pageIndex,
        createdAt ?? '',
        markerPart,
        comment.text ?? '',
    ].join('|');
    return `${baseName}:new:${hashReplayableNoteNamePart(stablePart)}`;
}

function commentReferencesAnnotationRef(comment: IAnnotationCommentSummary, ref: PDFRef) {
    const directRef = parsePdfJsAnnotationRef(comment.annotationId ?? comment.id);
    if (
        directRef
        && directRef.objectNumber === ref.objectNumber
        && directRef.generationNumber === ref.generationNumber
    ) {
        return true;
    }

    const stableMatch = comment.stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/iu);
    const stableRef = parsePdfJsAnnotationRef(stableMatch?.[1]);
    return Boolean(
        stableRef
        && stableRef.objectNumber === ref.objectNumber
        && stableRef.generationNumber === ref.generationNumber,
    );
}

function findClaimingSourceComment(
    dict: PDFDict,
    ref: PDFRef,
    sourceComments: IAnnotationCommentSummary[],
    pageFreeTextPopupCount: number,
    pageView: number[],
    pageRotation: ReturnType<typeof normalizePageRotation>,
) {
    const directlyClaimed = sourceComments.find(comment => commentReferencesAnnotationRef(comment, ref));
    if (directlyClaimed) {
        return directlyClaimed;
    }

    return findFreeTextCommentMatch(
        dict,
        ref,
        sourceComments,
        pageFreeTextPopupCount,
        pageView,
        pageRotation,
    );
}

interface IReplayableNewFreeTextNoteMatch {
    dict: PDFDict;
    ref: PDFRef;
}

function findExistingReplayableNewFreeTextNote(
    doc: PDFDocument,
    annots: PDFArray | undefined,
    noteName: string | null,
    comment?: IAnnotationCommentSummary,
    pageView?: number[],
    pageRotation?: ReturnType<typeof normalizePageRotation>,
    pageComments: IAnnotationCommentSummary[] = [],
) {
    if (!annots) {
        return {
            existing: null,
            nameClaimedBySourceComment: false,
        };
    }

    const nameKey = PDFName.of('NM');
    const subtypeName = PDFName.of('Subtype');
    const freeTextName = PDFName.of('FreeText');
    const popupName = PDFName.of('Popup');
    const replayedNoteNamePrefix = 'evb-note:';
    const sourceComments = pageComments.filter(candidate =>
        candidate !== comment
        && candidate.source !== 'editor'
        && candidate.pageIndex === comment?.pageIndex,
    );
    const pageFreeTextPopupCount = Array.from(iterateAnnotationRefDicts(doc, annots))
        .filter(({ dict }) => dict.get(subtypeName) === freeTextName && Boolean(dict.get(popupName)))
        .length;
    let fallback: IReplayableNewFreeTextNoteMatch | null = null;
    let nameClaimedBySourceComment = false;

    for (const {
        dict,
        ref,
    } of iterateAnnotationRefDicts(doc, annots)) {
        if (noteName && getPdfStringValue(dict.get(nameKey)) === noteName) {
            if (
                comment
                && pageView
                && pageRotation !== undefined
                && sourceComments.length > 0
                && findClaimingSourceComment(
                    dict,
                    ref,
                    sourceComments,
                    pageFreeTextPopupCount,
                    pageView,
                    pageRotation,
                )
            ) {
                nameClaimedBySourceComment = true;
                continue;
            }
            return {
                existing: {
                    dict,
                    ref,
                },
                nameClaimedBySourceComment,
            };
        }

        const existingNoteName = getPdfStringValue(dict.get(nameKey));
        if (
            existingNoteName?.startsWith(replayedNoteNamePrefix)
            && existingNoteName !== noteName
        ) {
            continue;
        }

        if (
            Boolean(existingNoteName)
            || fallback
            || !comment
            || !pageView
            || pageRotation === undefined
            || dict.get(subtypeName) !== freeTextName
            || !dict.get(popupName)
        ) {
            continue;
        }

        const matchedComment = findFreeTextCommentMatch(
            dict,
            ref,
            [comment],
            1,
            pageView,
            pageRotation,
        );
        if (matchedComment) {
            fallback = {
                dict,
                ref,
            };
        }
    }

    if (fallback && noteName) {
        fallback.dict.set(nameKey, PDFHexString.fromText(noteName));
    }
    return {
        existing: fallback,
        nameClaimedBySourceComment,
    };
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
    const allCommentsByPage: Record<string, IAnnotationCommentSummary[]> = groupBy(
        comments,
        comment => comment.pageIndex,
    );

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

            const baseNoteName = getReplayableNewFreeTextNoteName(comment);
            const lookup = findExistingReplayableNewFreeTextNote(
                doc,
                page.node.Annots(),
                baseNoteName,
                comment,
                context.pageView,
                context.pageRotation,
                allCommentsByPage[pageIndex] ?? pageComments,
            );
            const existing = lookup.existing;
            const noteName = lookup.nameClaimedBySourceComment
                ? getReplayableNewFreeTextNoteDisambiguatedName(comment, baseNoteName)
                : baseNoteName;
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
