import {
    formatPdfJsAnnotationRef,
    parsePdfJsAnnotationRef,
    type IPdfAnnotationRef,
} from '@app/utils/pdfAnnotationRefs';

export interface IPdfAnnotationStableKey {
    stableKey: string;
    pageIndex: number;
    annotationId: string;
}

export interface IPdfAnnotationStableKeyRef extends IPdfAnnotationStableKey {
    ref: IPdfAnnotationRef;
    normalizedAnnotationId: string;
}

const PDF_ANNOTATION_STABLE_KEY_RE = /^ann:(\d+):(.+)$/u;
const PDF_ANNOTATION_REF_STABLE_KEY_RE = /^ann:(\d+):(\d+R(?:\d+)?)$/iu;

function parseStableKeyPageIndex(value: string | undefined) {
    if (!value) {
        return null;
    }

    const pageIndex = Number(value);
    return Number.isInteger(pageIndex) && pageIndex >= 0 ? pageIndex : null;
}

export function parsePdfAnnotationStableKey(
    stableKey: string | null | undefined,
): IPdfAnnotationStableKey | null {
    const trimmed = stableKey?.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(PDF_ANNOTATION_STABLE_KEY_RE);
    const pageIndex = parseStableKeyPageIndex(match?.[1]);
    const annotationId = match?.[2]?.trim();
    if (pageIndex === null || !annotationId) {
        return null;
    }

    return {
        stableKey: trimmed,
        pageIndex,
        annotationId,
    };
}

export function parsePdfAnnotationStableKeyRef(
    stableKey: string | null | undefined,
): IPdfAnnotationStableKeyRef | null {
    const trimmed = stableKey?.trim();
    if (!trimmed) {
        return null;
    }

    const match = trimmed.match(PDF_ANNOTATION_REF_STABLE_KEY_RE);
    const pageIndex = parseStableKeyPageIndex(match?.[1]);
    const refText = match?.[2];
    const ref = parsePdfJsAnnotationRef(refText);
    if (pageIndex === null || !refText || !ref) {
        return null;
    }

    return {
        stableKey: trimmed,
        pageIndex,
        annotationId: refText,
        ref,
        normalizedAnnotationId: formatPdfJsAnnotationRef(ref),
    };
}

export function getPdfAnnotationIdFromStableKey(
    stableKey: string | null | undefined,
) {
    return parsePdfAnnotationStableKey(stableKey)?.annotationId ?? null;
}
