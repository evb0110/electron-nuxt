import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import {
    getOptionalNumber,
    getOptionalNumberArray,
} from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import type {
    IPdfAnnotationRecord,
    IPdfPageAnnotationBundle,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

function attachPdfAnnotationNames(
    annotations: IPdfAnnotationRecord[],
    annotationNamesById: ReadonlyMap<string, string> | null | undefined,
) {
    if (!annotationNamesById || annotationNamesById.size === 0) {
        return annotations;
    }

    return annotations.map((annotation) => {
        const annotationName = annotation.id ? annotationNamesById.get(annotation.id) : null;
        return annotationName
            ? {
                ...annotation,
                annotationName,
            }
            : annotation;
    });
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

export async function loadPdfPageAnnotations(
    doc: PDFDocumentProxy,
    pageNumber: number,
    annotationNamesById?: ReadonlyMap<string, string> | null,
): Promise<IPdfPageAnnotationBundle | null> {
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    try {
        page = await doc.getPage(pageNumber);
        const rawAnnotations: unknown = await page.getAnnotations();
        const annotations = attachPdfAnnotationNames(
            Array.isArray(rawAnnotations)
                ? rawAnnotations as IPdfAnnotationRecord[]
                : [],
            annotationNamesById,
        );
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
