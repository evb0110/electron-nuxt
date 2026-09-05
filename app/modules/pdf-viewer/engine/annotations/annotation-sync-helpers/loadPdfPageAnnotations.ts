import type { TPageNumber } from '@contracts/pageNumbers';

import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { isTextMarkupSubtype } from '@app/services/pdf/annotationSubtype';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
import {
    getOptionalNumber,
    getOptionalNumberArray,
} from '@app/services/pdfjs/runtime';
import { BrowserLogger } from '@app/utils/browserLogger';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import type {
    IPdfTextPreviewItem,
    IPdfTextPreviewViewport,
} from '@app/modules/pdf-viewer/engine/annotations/pdf-annotation-preview-text/pdfAnnotationPreviewTextTypes';
import type {
    IPdfAnnotationRecord,
    IPdfPageAnnotationBundle,
} from '@app/modules/pdf-viewer/engine/annotations/annotation-sync-helpers/annotationSyncHelpersTypes';

interface IPdfPageAnnotationLease {
    page: Awaited<ReturnType<PDFDocumentProxy['getPage']>>;
    release: () => void;
}

type TLeasePdfAnnotationPage = (
    doc: PDFDocumentProxy,
    pageNumber: TPageNumber,
) => Promise<IPdfPageAnnotationLease>;

interface IPdfPageAnnotationLeaseOptions {
    leasePage?: TLeasePdfAnnotationPage;
    signal?: AbortSignal;
}

const MAX_BACKGROUND_PDF_ANNOTATIONS_PER_PAGE = 10_000;

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
    pageNumber: TPageNumber,
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
    pageNumber: TPageNumber,
    annotationNamesById?: ReadonlyMap<string, string> | null,
    pageLeaseOptions?: IPdfPageAnnotationLeaseOptions,
): Promise<IPdfPageAnnotationBundle | null> {
    let page: Awaited<ReturnType<PDFDocumentProxy['getPage']>> | null = null;
    let pageLease: Awaited<ReturnType<NonNullable<IPdfPageAnnotationLeaseOptions['leasePage']>>> | null = null;
    try {
        pageLeaseOptions?.signal?.throwIfAborted();
        if (pageLeaseOptions?.leasePage) {
            pageLease = await pageLeaseOptions.leasePage(doc, pageNumber);
            page = pageLease.page;
        } else {
            page = await doc.getPage(pageNumber);
        }
        pageLeaseOptions?.signal?.throwIfAborted();
        const rawAnnotations: unknown = await page.getAnnotations();
        pageLeaseOptions?.signal?.throwIfAborted();
        if (
            Array.isArray(rawAnnotations)
            && rawAnnotations.length > MAX_BACKGROUND_PDF_ANNOTATIONS_PER_PAGE
        ) {
            // The old limit was a refusal cap. Keep the same number as a
            // page-local scheduling budget so a pathological page yields to
            // paint, while still returning every annotation on that page.
            await yieldToBrowser();
        }
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
        pageLeaseOptions?.signal?.throwIfAborted();
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
        if (pageLease) {
            pageLease.release();
        } else {
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
}
