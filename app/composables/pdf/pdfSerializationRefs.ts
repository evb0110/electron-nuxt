import type {PDFDocument} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
} from 'pdf-lib';
import { clamp } from 'es-toolkit/math';
import type { IAnnotationCommentSummary } from '@app/types/annotations';
import {
    markerRectIoU,
    normalizePageRotation,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import {
    getPdfStringValue,
    getPdfDictSubtype,
    getPdfDictContents,
} from '@app/utils/pdf-dict';
import {
    normalizeAnnotationSubtypeToken,
    normalizeComparableText,
} from '@app/utils/text-normalization';

const RECT_NAME = PDFName.of('Rect');
const CROP_BOX_NAME = PDFName.of('CropBox');
const MEDIA_BOX_NAME = PDFName.of('MediaBox');
const MANAGED_SHAPE_KEY_NAME = PDFName.of('EVBShapeKey');
const MANAGED_SHAPE_STABLE_KEY_PREFIX = 'evb-shape:';

function getPdfDictAuthor(dict: PDFDict | null) {
    if (!dict) {
        return '';
    }
    return getPdfStringValue(dict.get(PDFName.of('T')));
}

export function getPdfPopupDict(doc: PDFDocument, dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    const popupValue = dict.get(PDFName.of('Popup'));
    if (popupValue instanceof PDFDict) {
        return popupValue;
    }
    if (popupValue instanceof PDFRef) {
        return doc.context.lookupMaybe(popupValue, PDFDict) ?? null;
    }
    return null;
}

function numberFromPdfBox(box: PDFArray, index: number) {
    const value = box.get(index);
    return value instanceof PDFNumber ? value.asNumber() : null;
}

function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    const fallbackSize = page.getSize();
    if (fallbackSize.width <= 0 || fallbackSize.height <= 0) {
        return null;
    }

    const fallbackView: [number, number, number, number] = [
        0,
        0,
        fallbackSize.width,
        fallbackSize.height,
    ];

    const box = (
        page.node.lookupMaybe(CROP_BOX_NAME, PDFArray)
        ?? page.node.lookupMaybe(MEDIA_BOX_NAME, PDFArray)
    );
    if (!(box instanceof PDFArray) || box.size() < 4) {
        return fallbackView;
    }

    const x1 = numberFromPdfBox(box, 0);
    const y1 = numberFromPdfBox(box, 1);
    const x2 = numberFromPdfBox(box, 2);
    const y2 = numberFromPdfBox(box, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return fallbackView;
    }

    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const maxX = Math.max(x1, x2);
    const maxY = Math.max(y1, y2);
    if ((maxX - minX) <= 0 || (maxY - minY) <= 0) {
        return fallbackView;
    }

    return [
        minX,
        minY,
        maxX,
        maxY,
    ];
}

function readPdfRectFromDict(dict: PDFDict) {
    const rect = dict.lookupMaybe(RECT_NAME, PDFArray);
    if (!(rect instanceof PDFArray) || rect.size() < 4) {
        return null;
    }

    const x1 = numberFromPdfBox(rect, 0);
    const y1 = numberFromPdfBox(rect, 1);
    const x2 = numberFromPdfBox(rect, 2);
    const y2 = numberFromPdfBox(rect, 3);
    if (
        x1 === null
        || y1 === null
        || x2 === null
        || y2 === null
    ) {
        return null;
    }

    return [
        x1,
        y1,
        x2,
        y2,
    ];
}

export function parsePdfJsAnnotationRef(annotationId: string | null | undefined) {
    if (!annotationId) {
        return null;
    }
    const match = annotationId.trim().match(/^(\d+)R(?:(\d+))?$/i);
    if (!match) {
        return null;
    }

    const objectNumber = Number(match[1]);
    const generationNumber = match[2] ? Number(match[2]) : 0;
    if (
        !Number.isInteger(objectNumber)
        || objectNumber <= 0
        || !Number.isInteger(generationNumber)
        || generationNumber < 0
    ) {
        return null;
    }

    return PDFRef.of(objectNumber, generationNumber);
}

export function formatPdfJsAnnotationRef(
    ref: Pick<PDFRef, 'objectNumber' | 'generationNumber'>,
) {
    return ref.generationNumber === 0
        ? `${ref.objectNumber}R`
        : `${ref.objectNumber}R${ref.generationNumber}`;
}

export function normalizePdfJsAnnotationId(annotationId: string | null | undefined) {
    const ref = parsePdfJsAnnotationRef(annotationId);
    if (ref) {
        return formatPdfJsAnnotationRef(ref);
    }

    const trimmed = annotationId?.trim();
    return trimmed ? trimmed : null;
}

export function generateManagedShapeStableKey() {
    return `${MANAGED_SHAPE_STABLE_KEY_PREFIX}${crypto.randomUUID()}`;
}

export function normalizeManagedShapeStableKey(stableKey: string | null | undefined) {
    const trimmed = stableKey?.trim();
    if (!trimmed || !trimmed.startsWith(MANAGED_SHAPE_STABLE_KEY_PREFIX)) {
        return null;
    }
    return trimmed;
}

export function readManagedShapeStableKey(dict: PDFDict | null) {
    if (!dict) {
        return null;
    }
    return normalizeManagedShapeStableKey(getPdfStringValue(dict.get(MANAGED_SHAPE_KEY_NAME)));
}

export function writeManagedShapeStableKey(dict: PDFDict, stableKey: string | null | undefined) {
    const normalizedStableKey = normalizeManagedShapeStableKey(stableKey);
    if (!normalizedStableKey) {
        return false;
    }

    const currentStableKey = readManagedShapeStableKey(dict);
    if (currentStableKey === normalizedStableKey) {
        return false;
    }

    dict.set(MANAGED_SHAPE_KEY_NAME, PDFHexString.fromText(normalizedStableKey));
    return true;
}

function parseAnnotationRefFromStableKey(stableKey: string | null | undefined) {
    if (!stableKey) {
        return null;
    }
    const match = stableKey.trim().match(/^ann:\d+:(\d+R(?:\d+)?)$/i);
    if (!match?.[1]) {
        return null;
    }
    return parsePdfJsAnnotationRef(match[1]);
}

function isNoteLikeAnnotationSubtype(
    subtype: string | null | undefined,
) {
    const normalized = normalizeAnnotationSubtypeToken(subtype);
    return (
        normalized === 'text'
        || normalized === 'freetext'
        || normalized === 'typewriter'
        || normalized === 'note'
    );
}

function resolveCommentPdfRef(comment: IAnnotationCommentSummary) {
    return (
        parsePdfJsAnnotationRef(comment.annotationId ?? comment.id)
        ?? parseAnnotationRefFromStableKey(comment.stableKey)
    );
}

function findCommentRefByGeneratedId(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const generated = comment.id.match(/^pdf-(\d+)-(\d+)$/);
    if (!generated) {
        return null;
    }
    const pageNumber = Number(generated[1]);
    const annotationIndex = Number(generated[2]);
    if (!Number.isInteger(pageNumber) || !Number.isInteger(annotationIndex)) {
        return null;
    }
    if (pageNumber !== comment.pageNumber || annotationIndex < 0) {
        return null;
    }

    const pageIndex = clamp(pageNumber - 1, 0, doc.getPageCount() - 1);
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray) || annotationIndex >= annots.size()) {
        return null;
    }
    const value = annots.get(annotationIndex);
    return value instanceof PDFRef ? value : null;
}

function refsEqualByTag(left: PDFRef | null, right: PDFRef | null) {
    if (!left || !right) {
        return false;
    }
    return left.toString() === right.toString();
}

function canResolveExplicitRefOnPage(
    doc: PDFDocument,
    page: ReturnType<PDFDocument['getPages']>[number],
    explicitRef: PDFRef,
) {
    const annots = page.node.Annots();
    if (!(annots instanceof PDFArray)) {
        return false;
    }

    const explicitTag = explicitRef.toString();
    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (value instanceof PDFRef && value.toString() === explicitTag) {
            return true;
        }
    }

    const explicitDict = doc.context.lookupMaybe(explicitRef, PDFDict);
    if (!explicitDict) {
        return false;
    }

    const explicitParent = (() => {
        const value = explicitDict.get(PDFName.of('Parent'));
        return value instanceof PDFRef ? value : null;
    })();
    const explicitPopup = (() => {
        const value = explicitDict.get(PDFName.of('Popup'));
        return value instanceof PDFRef ? value : null;
    })();

    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (!(value instanceof PDFRef)) {
            continue;
        }
        if (refsEqualByTag(value, explicitParent) || refsEqualByTag(value, explicitPopup)) {
            return true;
        }

        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (!dict) {
            continue;
        }

        const parent = (() => {
            const parentValue = dict.get(PDFName.of('Parent'));
            return parentValue instanceof PDFRef ? parentValue : null;
        })();
        const popup = (() => {
            const popupValue = dict.get(PDFName.of('Popup'));
            return popupValue instanceof PDFRef ? popupValue : null;
        })();

        if (refsEqualByTag(parent, explicitRef) || refsEqualByTag(popup, explicitRef)) {
            return true;
        }
    }

    return false;
}

export function resolveCommentPdfRefInDocument(doc: PDFDocument, comment: IAnnotationCommentSummary) {
    const pageIndex = clamp(comment.pageIndex, 0, doc.getPageCount() - 1);
    const page = doc.getPages()[pageIndex];
    if (!page) {
        return null;
    }
    const annots = page.node.Annots();

    const explicitRef = resolveCommentPdfRef(comment);
    if (explicitRef && canResolveExplicitRefOnPage(doc, page, explicitRef)) {
        return explicitRef;
    }

    const byGeneratedId = findCommentRefByGeneratedId(doc, comment);
    if (byGeneratedId) {
        return byGeneratedId;
    }

    if (!(annots instanceof PDFArray) || annots.size() === 0) {
        return null;
    }

    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return null;
    }
    const pageRotation = normalizePageRotation(page.getRotation().angle);
    const commentSubtype = normalizeAnnotationSubtypeToken(comment.subtype);
    const commentText = normalizeComparableText(comment.text);
    const commentAuthor = normalizeComparableText(comment.author);
    const commentRect = comment.markerRect
        ? {
            left: clamp(comment.markerRect.left, 0, 1),
            top: clamp(comment.markerRect.top, 0, 1),
            width: clamp(comment.markerRect.width, 0, 1),
            height: clamp(comment.markerRect.height, 0, 1),
        }
        : null;

    let bestMatch: {
        ref: PDFRef;
        score: number;
    } | null = null;
    let secondBestScore = Number.NEGATIVE_INFINITY;
    const noteLikeRefs: PDFRef[] = [];

    for (let index = 0; index < annots.size(); index += 1) {
        const value = annots.get(index);
        if (!(value instanceof PDFRef)) {
            continue;
        }

        const dict = doc.context.lookupMaybe(value, PDFDict);
        if (!dict) {
            continue;
        }

        const subtype = normalizeAnnotationSubtypeToken(getPdfDictSubtype(dict));
        if (subtype === 'popup') {
            continue;
        }
        if (isNoteLikeAnnotationSubtype(subtype)) {
            noteLikeRefs.push(value);
        }

        const popupDict = getPdfPopupDict(doc, dict);
        const candidateText = normalizeComparableText(
            getPdfDictContents(dict) || getPdfDictContents(popupDict),
        );
        const candidateAuthor = normalizeComparableText(
            getPdfDictAuthor(dict) || getPdfDictAuthor(popupDict),
        );
        const candidateRect = toMarkerRectFromPdfRect(
            readPdfRectFromDict(dict),
            pageView,
            pageRotation,
        );

        let score = 0;
        if (commentSubtype) {
            if (commentSubtype === subtype) {
                score += 5;
            } else if (
                (commentSubtype === 'text' && subtype === 'freetext')
                || (commentSubtype === 'freetext' && subtype === 'text')
            ) {
                score += 2;
            } else {
                score -= 1.5;
            }
        }

        if (commentText) {
            if (candidateText === commentText) {
                score += 6;
            } else if (
                candidateText.length > 0
                && (candidateText.includes(commentText) || commentText.includes(candidateText))
            ) {
                score += 3;
            } else {
                score -= 1;
            }
        } else if (!candidateText) {
            score += 0.5;
        }

        if (commentAuthor && candidateAuthor && commentAuthor === candidateAuthor) {
            score += 1;
        }

        const rectIoU = markerRectIoU(commentRect, candidateRect);
        if (rectIoU > 0) {
            score += rectIoU * 8;
        } else if (commentRect) {
            score -= 0.2;
        }

        if (!bestMatch || score > bestMatch.score) {
            if (bestMatch) {
                secondBestScore = Math.max(secondBestScore, bestMatch.score);
            }
            bestMatch = {
                ref: value,
                score,
            };
            continue;
        }
        secondBestScore = Math.max(secondBestScore, score);
    }

    if (bestMatch && bestMatch.score >= 2) {
        return bestMatch.ref;
    }

    const isEditorWithoutExplicitRef = comment.source === 'editor' && !comment.annotationId;
    if (isEditorWithoutExplicitRef) {
        if (noteLikeRefs.length === 1) {
            return noteLikeRefs[0] ?? null;
        }

        if (
            bestMatch
            && bestMatch.score >= 0.5
            && (
                secondBestScore === Number.NEGATIVE_INFINITY
                || (bestMatch.score - secondBestScore) >= 1.5
            )
        ) {
            return bestMatch.ref;
        }
    }

    return null;
}
