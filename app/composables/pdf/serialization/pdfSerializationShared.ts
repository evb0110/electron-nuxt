import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
} from 'pdf-lib';
import type {
    IAnnotationCommentSummary,
    IAnnotationMarkerRect,
} from '@app/types/annotations';
import { formatPdfJsAnnotationRef } from '@app/composables/pdf/pdfSerializationRefs';

export function appendAnnotationRefToPage(
    page: ReturnType<PDFDocument['getPages']>[number],
    doc: PDFDocument,
    annotRef: PDFRef,
) {
    const annots = page.node.Annots() ?? doc.context.obj([]);
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        page.node.set(PDFName.of('Annots'), annots);
        return;
    }

    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}

export function isAnnotationMarkerRect(value: IAnnotationCommentSummary['markerRect']): value is IAnnotationMarkerRect {
    return Boolean(
        value
        && Number.isFinite(value.left)
        && Number.isFinite(value.top)
        && Number.isFinite(value.width)
        && Number.isFinite(value.height),
    );
}

export function refToTag(ref: PDFRef) {
    return formatPdfJsAnnotationRef(ref);
}
