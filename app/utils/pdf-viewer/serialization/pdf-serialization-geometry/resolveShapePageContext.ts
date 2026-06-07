import type { PDFDocument } from 'pdf-lib';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { tryResolvePdfLibPageView } from '@pdf-core';

export function resolveShapePageContext(page: ReturnType<PDFDocument['getPages']>[number]) {
    const pageView = tryResolvePdfLibPageView(page);
    if (!pageView) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
    };
}
