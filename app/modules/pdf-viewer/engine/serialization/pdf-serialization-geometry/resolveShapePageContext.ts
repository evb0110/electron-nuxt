import type { PDFDocument } from 'pdf-lib';
import { normalizePageRotation } from '@app/modules/pdf-viewer/engine/annotation-geometry/normalizePageRotation';
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
