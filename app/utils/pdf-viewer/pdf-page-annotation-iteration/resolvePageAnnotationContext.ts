import { PDFArray } from 'pdf-lib';
import type { PDFDocument } from 'pdf-lib';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { tryResolvePdfLibPageView } from '@pdf-core';

export function resolvePageAnnotationContext(
    page: ReturnType<PDFDocument['getPages']>[number],
) {
    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        return null;
    }

    let annots: PDFArray | undefined;
    try {
        annots = page.node.Annots();
    } catch {
        return null;
    }
    if (!(annots instanceof PDFArray)) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
        annots,
    };
}
