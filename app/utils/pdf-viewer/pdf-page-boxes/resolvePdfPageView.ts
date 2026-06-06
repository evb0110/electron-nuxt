import type { PDFDocument } from 'pdf-lib';
import { resolvePdfLibPageView } from '@pdf-core/pdfPageBoxes';

export function resolvePdfPageView(page: ReturnType<PDFDocument['getPages']>[number]) {
    try {
        return resolvePdfLibPageView(page);
    } catch {
        return null;
    }
}
