import type { PDFDocument } from 'pdf-lib';
import {
    PDFArray,
    PDFRef,
} from 'pdf-lib';

export function removeAnnotationRefsFromPages(doc: PDFDocument, refsToRemove: PDFRef[]) {
    if (refsToRemove.length === 0) {
        return false;
    }

    const refTags = new Set(refsToRemove.map(ref => ref.toString()));
    let removed = false;

    doc.getPages().forEach((page) => {
        const annots = page.node.Annots();
        if (!(annots instanceof PDFArray)) {
            return;
        }

        for (let index = annots.size() - 1; index >= 0; index -= 1) {
            const value = annots.get(index);
            if (!(value instanceof PDFRef)) {
                continue;
            }
            if (!refTags.has(value.toString())) {
                continue;
            }
            annots.remove(index);
            removed = true;
        }
    });

    return removed;
}
