import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { getAnnotationAuthor } from '@app/services/pdf/annotationMetadata';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { normalizeMarkerRect } from '@app/utils/pdf-viewer/annotation-geometry/normalizeMarkerRect';
import { toMarkerRectFromPdfRect } from '@app/utils/pdf-viewer/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/utils/pdf-viewer/annotation-geometry/pageRotation';
import { toCssColor } from '@app/utils/pdf-viewer/annotation-css-utils/toCssColor';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/utils/pdf-viewer/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import { resolvePdfAnnotationPreviewText } from '@app/utils/pdf-viewer/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';
import type {
    IPdfAnnotationRecord,
    IPdfCommentSummaryDeps,
} from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import { pickEarliestAnnotationCreationTimestamp } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/pickEarliestAnnotationCreationTimestamp';
import { pickLatestAnnotationTimestamp } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/pickLatestAnnotationTimestamp';
import { resolveCombinedAnnotationText } from '@app/utils/pdf-viewer/annotations/annotation-sync-helpers/resolveCombinedAnnotationText';

const FREE_TEXT_SUBTYPE_LOWER = 'freetext';

const POINT_NOTE_MARKER_SIZE = 0.0016;

const MAX_FREETEXT_NOTE_MARKER_SIZE = 0.02;

function isFreeTextNoteMarkerRect(
    subtype: string | null | undefined,
    hasLinkedPopup: boolean,
    rect: IAnnotationMarkerRect | null,
): rect is IAnnotationMarkerRect {
    if (!rect || !hasLinkedPopup) {
        return false;
    }
    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
    return normalizedSubtype === FREE_TEXT_SUBTYPE_LOWER;
}

function toPointMarkerRectFromTopLeft(rect: IAnnotationMarkerRect) {
    return normalizeMarkerRect({
        left: rect.left,
        top: rect.top,
        width: POINT_NOTE_MARKER_SIZE,
        height: POINT_NOTE_MARKER_SIZE,
    });
}

function resolvePdfCommentMarkerRect(
    subtype: string | null | undefined,
    hasLinkedPopup: boolean,
    rawMarkerRect: IAnnotationMarkerRect | null,
) {
    if (!isFreeTextNoteMarkerRect(subtype, hasLinkedPopup, rawMarkerRect)) {
        return rawMarkerRect;
    }
    if (
        rawMarkerRect.width <= MAX_FREETEXT_NOTE_MARKER_SIZE
        && rawMarkerRect.height <= MAX_FREETEXT_NOTE_MARKER_SIZE
    ) {
        return rawMarkerRect;
    }
    return toPointMarkerRectFromTopLeft(rawMarkerRect);
}

function resolvePdfCommentIds(
    annotation: IPdfAnnotationRecord,
    pageNumber: number,
    annotationIndex: number,
) {
    const id = annotation.id ?? `pdf-${pageNumber}-${annotationIndex}`;
    return {
        id,
        annotationId: annotation.id ?? null,
    };
}

function resolvePdfCommentAnnotationName(annotation: IPdfAnnotationRecord) {
    const rawName = annotation.annotationName ?? null;
    const name = typeof rawName === 'string'
        ? rawName.trim()
        : '';
    return name || null;
}

function resolvePdfCommentAuthor(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    return getAnnotationAuthor(annotation)
        ?? (popupAnnotation ? getAnnotationAuthor(popupAnnotation) : null);
}

function resolvePdfCommentColor(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
) {
    return toCssColor(
        annotation.color ?? popupAnnotation?.color ?? null,
        annotation.opacity ?? popupAnnotation?.opacity ?? 1,
    );
}

function hasPdfAnnotationNote(
    subtype: string | null,
    hasLinkedPopup: boolean,
    text: string,
) {
    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
    const isFreeTextNote = normalizedSubtype === FREE_TEXT_SUBTYPE_LOWER && hasLinkedPopup;
    return Boolean(
        (isTextMarkupSubtype(subtype) || isFreeTextNote)
        && (hasLinkedPopup || text.trim().length > 0),
    );
}

function normalizeGeneratedMarkupText(value: string) {
    return value.replace(/\s+/gu, ' ').trim().toLowerCase();
}

function normalizeGeneratedMarkupTextCompact(value: string) {
    return normalizeGeneratedMarkupText(value).replace(/\s+/gu, '');
}

function looksLikeGeneratedTextMarkupContents(text: string, previewText: string | null) {
    const normalizedText = normalizeGeneratedMarkupText(text);
    const normalizedPreview = normalizeGeneratedMarkupText(previewText ?? '');
    if (!normalizedText || !normalizedPreview) {
        return false;
    }
    if (normalizedText.includes(normalizedPreview) || normalizedPreview.includes(normalizedText)) {
        return true;
    }

    const compactText = normalizeGeneratedMarkupTextCompact(text);
    const compactPreview = normalizeGeneratedMarkupTextCompact(previewText ?? '');
    return Boolean(
        compactText
        && compactPreview
        && (compactText.includes(compactPreview) || compactPreview.includes(compactText)),
    );
}

function shouldTreatTextMarkupContentsAsPreview(
    subtype: string | null,
    hasLinkedPopup: boolean,
    text: string,
    previewText: string | null,
) {
    return isTextMarkupSubtype(subtype)
        && !hasLinkedPopup
        && looksLikeGeneratedTextMarkupContents(text, previewText);
}

export function buildPdfAnnotationCommentSummary(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
    pageNumber: number,
    annotationIndex: number,
    pageView: number[] | null,
    pageRotation: TPageRotation,
    deps: IPdfCommentSummaryDeps,
    textItems: readonly IPdfTextPreviewItem[] = [],
    textViewport: IPdfTextPreviewViewport | null = null,
): IAnnotationCommentSummary {
    const rawText = resolveCombinedAnnotationText(annotation, popupAnnotation);
    const subtype = annotation.subtype ?? null;
    const {
        id,
        annotationId,
    } = resolvePdfCommentIds(annotation, pageNumber, annotationIndex);
    const annotationName = resolvePdfCommentAnnotationName(annotation);
    const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
    const rawMarkerRect = toMarkerRectFromPdfRect(
        annotation.rect ?? popupAnnotation?.rect,
        pageView,
        pageRotation,
    );
    const extractedPreviewText = resolvePdfAnnotationPreviewText(
        annotation,
        textItems,
        pageView,
        pageRotation,
        textViewport,
    );
    const text = shouldTreatTextMarkupContentsAsPreview(
        subtype,
        hasLinkedPopup,
        rawText,
        extractedPreviewText,
    )
        ? ''
        : rawText;
    const previewText = text.trim() ? null : extractedPreviewText;

    return {
        id,
        stableKey: deps.computeStableKey({
            id,
            pageIndex: pageNumber - 1,
            source: 'pdf',
            uid: null,
            annotationId,
            annotationName,
        }),
        sortIndex: null,
        pageIndex: pageNumber - 1,
        pageNumber,
        text,
        previewText,
        kindLabel: deps.resolveKindLabel(subtype),
        subtype,
        author: resolvePdfCommentAuthor(annotation, popupAnnotation),
        createdAt: pickEarliestAnnotationCreationTimestamp(annotation, popupAnnotation),
        modifiedAt: pickLatestAnnotationTimestamp(annotation, popupAnnotation),
        color: resolvePdfCommentColor(annotation, popupAnnotation),
        uid: null,
        annotationId,
        annotationName,
        source: 'pdf',
        hasNote: hasPdfAnnotationNote(subtype, hasLinkedPopup, text),
        markerRect: resolvePdfCommentMarkerRect(subtype, hasLinkedPopup, rawMarkerRect),
    };
}
