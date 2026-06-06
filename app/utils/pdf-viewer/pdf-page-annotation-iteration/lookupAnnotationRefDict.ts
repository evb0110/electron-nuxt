import {
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import type { IPdfAnnotationRefDict } from '@app/utils/pdf-viewer/pdf-page-annotation-iteration/pdfAnnotationRefDict';

export function lookupAnnotationRefDict(
    doc: PDFDocument,
    value: unknown,
): IPdfAnnotationRefDict | null {
    const ref = value instanceof PDFRef ? value : null;
    if (!ref) {
        return null;
    }

    const dict = doc.context.lookupMaybe(ref, PDFDict);
    return dict
        ? {
            dict,
            ref,
        }
        : null;
}
