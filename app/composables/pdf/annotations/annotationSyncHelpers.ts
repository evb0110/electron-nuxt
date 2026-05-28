import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
    ILinkAnnotation,
    TMarkupSubtype,
} from '@app/types/annotations';
import type { PDFDocumentProxy } from '@app/types/pdf';
import type { IPdfjsEditor } from '@app/types/pdfjs';
import { markerRectCenterDistance } from '@app/composables/pdf/annotations/annotationRules';
import {
    getAnnotationAuthor,
    getAnnotationCommentText,
    parsePdfDateTimestamp,
} from '@app/services/pdf/annotationMetadata';
import {
    isLinkSubtype,
    isPopupSubtype,
    isTextMarkupSubtype,
} from '@app/services/pdf/annotationSubtype';
import {
    normalizeMarkerRect,
    normalizePageRotation,
    toMarkerRectFromEditorRect,
    toMarkerRectFromPdfRect,
} from '@app/composables/pdf/annotationGeometry';
import type { TPageRotation } from '@app/composables/pdf/annotationGeometry';
import { isImportedEmbeddedShapeSubtype } from '@app/composables/pdf/pdfEmbeddedShapeAnnotations';
import { toMarkerRectFromEditor } from '@app/composables/pdf/pdfAnnotationEditorUtils';
import { toCssColor } from '@app/composables/pdf/annotationCssUtils';
import {
    getOptionalNumber,
    getOptionalNumberArray,
    getOptionalString,
} from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import {
    resolvePdfAnnotationPreviewText,
    type IPdfTextPreviewItem,
    type IPdfTextPreviewViewport,
} from '@app/composables/pdf/annotations/pdfAnnotationPreviewText';

export interface IPdfAnnotationRecord {
    id?: string;
    pageIndex?: number;
    rect?: number[];
    contents?: string;
    contentsObj?: { str?: string | null };
    richText?: { str?: string | null };
    title?: string;
    titleObj?: { str?: string | null };
    color?: ArrayLike<number> | string | null;
    opacity?: number;
    modificationDate?: string | null;
    creationDate?: string | null;
    subtype?: string;
    quadPoints?: ArrayLike<number> | null;
    popupRef?: string | null;
    url?: string;
}

export interface IPdfPageAnnotationBundle {
    annotations: IPdfAnnotationRecord[];
    pageView: number[] | null;
    pageRotation: TPageRotation;
    textItems?: IPdfTextPreviewItem[] | undefined;
    textViewport?: IPdfTextPreviewViewport | null | undefined;
}

export interface IComputeSummaryStableKeyParams {
    pageIndex: number;
    id: string;
    source: IAnnotationCommentSummary['source'];
    uid?: string | null;
    annotationId?: string | null;
}

export type TComputeSummaryStableKey = (params: IComputeSummaryStableKeyParams) => string;

export interface IPdfCommentSummaryDeps {
    computeStableKey: TComputeSummaryStableKey;
    resolveKindLabel: (subtype: string | null | undefined) => string;
}

export interface IEditorMarkerRectResult {
    markerRect: IAnnotationMarkerRect | null;
    markerRectFromEditor: IAnnotationMarkerRect | null;
    pendingAnchorRect: IAnnotationMarkerRect | null;
    markerDistanceFromPending: number;
    shouldUsePendingAnchor: boolean;
}

export interface IMarkupSubtypeOverrideRegistration {
    annotationId: string;
    subtype: TMarkupSubtype;
}

const NOTE_INVISIBLE_CHAR_REGEX = /[\u200B\uFEFF]/g;
const FREE_TEXT_SUBTYPE_LOWER = 'freetext';
const PENDING_ANCHOR_DISTANCE_THRESHOLD = 0.14;
const POINT_NOTE_MARKER_SIZE = 0.0016;
const MAX_FREETEXT_NOTE_MARKER_SIZE = 0.02;
const MARKUP_SUBTYPE_OVERRIDE_BLOCKLIST: ReadonlySet<string> = new Set([
    'Highlight',
    'Ink',
    'Typewriter',
]);

export function isMarkupSubtype(value: unknown): value is TMarkupSubtype {
    return (
        value === 'Highlight'
        || value === 'Underline'
        || value === 'StrikeOut'
        || value === 'Squiggly'
    );
}

export function safeReadEditorData(editor: IPdfjsEditor): ReturnType<NonNullable<IPdfjsEditor['getData']>> {
    try {
        return editor.getData?.() ?? {};
    } catch (error) {
        BrowserLogger.debug(
            'annotations',
            'Failed to read annotation editor data payload',
            error,
        );
        return {};
    }
}

export function resolveMarkupSubtypeOverrideRegistration(
    annotationId: string | null,
    resolvedSubtype: string | null | undefined,
): IMarkupSubtypeOverrideRegistration | null {
    if (!annotationId || !resolvedSubtype) {
        return null;
    }
    if (MARKUP_SUBTYPE_OVERRIDE_BLOCKLIST.has(resolvedSubtype)) {
        return null;
    }
    if (!isMarkupSubtype(resolvedSubtype)) {
        return null;
    }
    return {
        annotationId,
        subtype: resolvedSubtype,
    };
}

export function resolveEditorMarkerRect(editor: IPdfjsEditor): IEditorMarkerRectResult {
    const editorRotation = normalizePageRotation(
        getOptionalNumber(editor, 'pageRotation')
        ?? getOptionalNumber(editor, 'rotation')
        ?? 0,
    );
    const directEditorRect = normalizeMarkerRect({
        left: editor.x ?? Number.NaN,
        top: editor.y ?? Number.NaN,
        width: editor.width ?? Number.NaN,
        height: editor.height ?? Number.NaN,
    });
    const markerRectFromEditor = directEditorRect
        ? toMarkerRectFromEditorRect(directEditorRect, editorRotation)
        : toMarkerRectFromEditor(editor);
    const pendingAnchorRect = normalizeMarkerRect(editor.__evbPendingAnchorRect ?? null);
    const markerDistanceFromPending = markerRectCenterDistance(markerRectFromEditor, pendingAnchorRect);
    const hasPointSizedPendingAnchor = Boolean(
        pendingAnchorRect
        && pendingAnchorRect.width <= MAX_FREETEXT_NOTE_MARKER_SIZE
        && pendingAnchorRect.height <= MAX_FREETEXT_NOTE_MARKER_SIZE,
    );
    const shouldUsePendingAnchor = Boolean(
        pendingAnchorRect
        && (
            hasPointSizedPendingAnchor
            || !markerRectFromEditor
            || markerDistanceFromPending > PENDING_ANCHOR_DISTANCE_THRESHOLD
        ),
    );
    const markerRect = shouldUsePendingAnchor
        ? pendingAnchorRect
        : markerRectFromEditor;

    return {
        markerRect,
        markerRectFromEditor,
        pendingAnchorRect,
        markerDistanceFromPending,
        shouldUsePendingAnchor,
    };
}

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

export function resolveCombinedAnnotationText(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
): string {
    const annotationText = getAnnotationCommentText(annotation);
    const popupText = popupAnnotation
        ? getAnnotationCommentText(popupAnnotation)
        : '';
    // Strip ZWS/BOM left by legacy saves so we detect truly-empty /Contents
    // and fall through to the popup text (see docs/freetext-note-persistence.md)
    const visibleAnnotationText = annotationText.replace(NOTE_INVISIBLE_CHAR_REGEX, '').trim();
    if (visibleAnnotationText.length > 0) {
        return annotationText;
    }
    if (popupText.length > 0) {
        return popupText;
    }
    return annotationText;
}

export function pickLatestAnnotationTimestamp(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
): number | null {
    const own = parsePdfDateTimestamp(annotation.modificationDate)
        ?? parsePdfDateTimestamp(annotation.creationDate);
    const popup = popupAnnotation
        ? (parsePdfDateTimestamp(popupAnnotation.modificationDate)
            ?? parsePdfDateTimestamp(popupAnnotation.creationDate))
        : null;
    if (own && popup) {
        return Math.max(own, popup);
    }
    return own ?? popup;
}

export function pickEarliestAnnotationCreationTimestamp(
    annotation: IPdfAnnotationRecord,
    popupAnnotation: IPdfAnnotationRecord | null,
): number | null {
    const own = parsePdfDateTimestamp(annotation.creationDate);
    const popup = popupAnnotation
        ? parsePdfDateTimestamp(popupAnnotation.creationDate)
        : null;
    if (own && popup) {
        return Math.min(own, popup);
    }
    return own ?? popup;
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

function shouldLoadTextPreviewItems(pageAnnotations: readonly IPdfAnnotationRecord[]) {
    return pageAnnotations.some(annotation => isTextMarkupSubtype(annotation.subtype));
}

function toTextPreviewViewport(viewport: unknown): IPdfTextPreviewViewport | null {
    const width = getOptionalNumber(viewport, 'width');
    const height = getOptionalNumber(viewport, 'height');
    const transform = getOptionalNumberArray(viewport, 'transform');
    if (!width || !height || !transform || transform.length < 6) {
        return null;
    }

    return {
        transform,
        width,
        height,
        scale: getOptionalNumber(viewport, 'scale'),
    };
}

async function loadPageTextPreviewData(
    page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>,
    pageNumber: number,
    pageAnnotations: readonly IPdfAnnotationRecord[],
) {
    if (!shouldLoadTextPreviewItems(pageAnnotations)) {
        return {
            textItems: [],
            textViewport: null,
        };
    }

    try {
        const viewport = toTextPreviewViewport(page.getViewport({ scale: 1 }));
        const textContent = await page.getTextContent();
        const rawItems = Array.isArray(textContent.items)
            ? textContent.items as IPdfTextPreviewItem[]
            : [];
        return {
            textItems: rawItems,
            textViewport: viewport,
        };
    } catch (error) {
        BrowserLogger.debug(
            'annotations',
            `Failed to collect text preview data for page ${pageNumber}`,
            error,
        );
        return {
            textItems: [],
            textViewport: null,
        };
    }
}

export function buildPopupIndex(
    pageAnnotations: readonly IPdfAnnotationRecord[],
): Map<string, IPdfAnnotationRecord> {
    const popupById = new Map<string, IPdfAnnotationRecord>();
    for (const annotation of pageAnnotations) {
        if (!isPopupSubtype(annotation.subtype) || !annotation.id) {
            continue;
        }
        popupById.set(annotation.id, annotation);
    }
    return popupById;
}

export function tryExtractPdfLinkAnnotation(
    annotation: IPdfAnnotationRecord,
    pageNumber: number,
    annotationIndex: number,
    pageView: number[] | null,
    pageRotation: TPageRotation,
): ILinkAnnotation | null {
    const url = getOptionalString(annotation, 'url');
    if (!url || !annotation.rect) {
        return null;
    }
    const rect = toMarkerRectFromPdfRect(annotation.rect, pageView, pageRotation);
    if (!rect) {
        return null;
    }
    return {
        id: annotation.id ?? `link-${pageNumber}-${annotationIndex}`,
        pageNumber,
        url,
        rect,
    };
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
    const text = resolveCombinedAnnotationText(annotation, popupAnnotation);
    const subtype = annotation.subtype ?? null;
    const {
        id,
        annotationId,
    } = resolvePdfCommentIds(annotation, pageNumber, annotationIndex);
    const hasLinkedPopup = Boolean(annotation.popupRef) || Boolean(popupAnnotation);
    const rawMarkerRect = toMarkerRectFromPdfRect(
        annotation.rect ?? popupAnnotation?.rect,
        pageView,
        pageRotation,
    );
    const previewText = text.trim()
        ? null
        : resolvePdfAnnotationPreviewText(annotation, textItems, pageView, pageRotation, textViewport);

    return {
        id,
        stableKey: deps.computeStableKey({
            id,
            pageIndex: pageNumber - 1,
            source: 'pdf',
            uid: null,
            annotationId,
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
        source: 'pdf',
        hasNote: hasPdfAnnotationNote(subtype, hasLinkedPopup, text),
        markerRect: resolvePdfCommentMarkerRect(subtype, hasLinkedPopup, rawMarkerRect),
    };
}

export function collectPagePdfSnapshotEntries(
    pageBundle: IPdfPageAnnotationBundle,
    pageNumber: number,
    summaryDeps: IPdfCommentSummaryDeps,
    comments: IAnnotationCommentSummary[],
    links: ILinkAnnotation[],
) {
    const {
        annotations,
        pageView,
        pageRotation,
        textItems,
        textViewport,
    } = pageBundle;
    const popupById = buildPopupIndex(annotations);

    annotations.forEach((annotation, annotationIndex) => {
        if (isPopupSubtype(annotation.subtype)) {
            return;
        }

        if (isLinkSubtype(annotation.subtype)) {
            const link = tryExtractPdfLinkAnnotation(
                annotation,
                pageNumber,
                annotationIndex,
                pageView,
                pageRotation,
            );
            if (link) {
                links.push(link);
            }
            return;
        }

        if (isImportedEmbeddedShapeSubtype(annotation.subtype)) {
            return;
        }

        const popupAnnotation = annotation.popupRef
            ? (popupById.get(annotation.popupRef) ?? null)
            : null;

        comments.push(buildPdfAnnotationCommentSummary(
            annotation,
            popupAnnotation,
            pageNumber,
            annotationIndex,
            pageView,
            pageRotation,
            summaryDeps,
            textItems,
            textViewport,
        ));
    });
}

export async function loadPdfPageAnnotations(
    doc: PDFDocumentProxy,
    pageNumber: number,
): Promise<IPdfPageAnnotationBundle | null> {
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    try {
        page = await doc.getPage(pageNumber);
        const rawAnnotations: unknown = await page.getAnnotations();
        const annotations = Array.isArray(rawAnnotations)
            ? rawAnnotations as IPdfAnnotationRecord[]
            : [];
        const {
            textItems,
            textViewport,
        } = await loadPageTextPreviewData(page, pageNumber, annotations);
        return {
            annotations,
            pageView: getOptionalNumberArray(page, 'view'),
            pageRotation: normalizePageRotation(getOptionalNumber(page, 'rotate') ?? 0),
            textItems,
            textViewport,
        };
    } catch (error) {
        BrowserLogger.debug(
            'annotations',
            `Failed to collect annotations for page ${pageNumber}`,
            error,
        );
        return null;
    } finally {
        try {
            page?.cleanup();
        } catch (cleanupError) {
            BrowserLogger.debug(
                'annotations',
                `Failed to cleanup annotation page ${pageNumber}`,
                cleanupError,
            );
        }
    }
}
