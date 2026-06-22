import type {
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFArray,
    PDFName,
} from 'pdf-lib';
import { safePdfPageAnnots } from '@pdf-core';

export function appendAnnotationRefToPage(
    page: ReturnType<PDFDocument['getPages']>[number],
    doc: PDFDocument,
    annotRef: PDFRef,
) {
    const annots = safePdfPageAnnots(page) ?? doc.context.obj([]);
    if (annots instanceof PDFArray) {
        annots.push(annotRef);
        page.node.set(PDFName.of('Annots'), annots);
        return;
    }

    page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
}
