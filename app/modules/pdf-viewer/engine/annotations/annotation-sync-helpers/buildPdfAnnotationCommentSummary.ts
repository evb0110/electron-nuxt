import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { getAnnotationAuthor } from '@app/services/pdf/annotationMetadata';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { toMarkerRectFromPdfRect } from '@app/modules/pdf-viewer/engine/annotation-geometry/toMarkerRectFromPdfRect';
import type { TPageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/pageRotation';
import { toCssColor } from '@app/modules/pdf-viewer/engine/annotation-css-utils/toCssColor';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import { resolvePdfAnnotationPreviewText } from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/resolvePdfAnnotationPreviewText';
import type {
    IPdfAnnotationRecord,
    IPdfCommentSummaryDeps,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';
import { pickEarliestAnnotationCreationTimestamp } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/pickEarliestAnnotationCreationTimestamp';
import { pickLatestAnnotationTimestamp } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/pickLatestAnnotationTimestamp';
import { resolveCombinedAnnotationText } from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/resolveCombinedAnnotationText';
import { isPointNoteMarkerSizedRect } from '@app/modules/pdf-viewer/engine/annotations/annotation-rules/pointNoteMarkerPolicy';
import { toCanonicalTextMarkupGeometryFromRecord } from '@app/modules/pdf-viewer/engine/annotation-geometry/canonicalTextMarkupGeometry';

const FREE_TEXT_SUBTYPE_LOWER = 'freetext';

function isFreeTextNoteMarkerRect(
    subtype: string | null | undefined,
    hasLinkedPopup: boolean,
    rect: IAnnotationMarkerRect | null,
) {
    if (!hasLinkedPopup) {
        return false;
    }
    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
    return normalizedSubtype === FREE_TEXT_SUBTYPE_LOWER
        && isPointNoteMarkerSizedRect(rect);
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
    markerRect: IAnnotationMarkerRect | null,
) {
    const normalizedSubtype = (subtype ?? '').trim().toLowerCase();
    const isFreeTextNote = normalizedSubtype === FREE_TEXT_SUBTYPE_LOWER
        && isFreeTextNoteMarkerRect(subtype, hasLinkedPopup, markerRect);
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

/**
 * The one rule that turns a stored annotation into the note text this project
 * treats as the annotation's own: a linked popup's text stands in for empty
 * `/Contents`, and `/Contents` that merely repeats the highlighted document
 * text is not note text at all.
 *
 * Save verification reopens the staged file and needs the same answer the
 * opened document gave, so it calls this rather than reading `/Contents`
 * directly — a markup whose note lives in its popup would otherwise look like
 * text the save had dropped.
 */
export function resolvePdfAnnotationCommentText(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
    extractedPreviewText: string | null,
) {
    const rawText = resolveCombinedAnnotationText(annotation, popupAnnotation);
    const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
    return shouldTreatTextMarkupContentsAsPreview(
        annotation.subtype ?? null,
        hasLinkedPopup,
        rawText,
        extractedPreviewText,
    )
        ? ''
        : rawText;
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
    const text = resolvePdfAnnotationCommentText(annotation, popupAnnotation, extractedPreviewText);
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
        hasNote: hasPdfAnnotationNote(subtype, hasLinkedPopup, text, rawMarkerRect),
        markerRect: rawMarkerRect,
        markupGeometry: isTextMarkupSubtype(subtype)
            ? toCanonicalTextMarkupGeometryFromRecord(annotation, pageView, pageRotation)
            : null,
    };
}
