import type { PDFRef } from 'pdf-lib';
import { formatPdfJsAnnotationRef } from '@app/utils/pdfAnnotationRefs';

export function refToTag(ref: PDFRef) {
    return formatPdfJsAnnotationRef(ref);
}
