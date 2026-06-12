import type {
    PDFArray,
    PDFDocument,
} from 'pdf-lib';
import { lookupAnnotationRefDict } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/lookupAnnotationRefDict';
import type { IPdfAnnotationRefDict } from '@app/modules/pdf-viewer/engine/pdf-page-annotation-iteration/pdfAnnotationRefDict';

export function iterateAnnotationRefDicts(
    doc: PDFDocument,
    annots: PDFArray,
): IPdfAnnotationRefDict[] {
    const items: IPdfAnnotationRefDict[] = [];
    for (let index = 0; index < annots.size(); index += 1) {
        const annotation = lookupAnnotationRefDict(doc, annots.get(index));
        if (annotation) {
            items.push(annotation);
        }
    }
    return items;
}
