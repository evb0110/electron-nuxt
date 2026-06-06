import type { PDFDocument } from 'pdf-lib';
import { normalizePageRotation } from '@app/utils/pdf-viewer/annotation-geometry/normalizePageRotation';
import { resolvePdfPageView } from '@app/utils/pdf-viewer/pdf-page-boxes/resolvePdfPageView';

export function resolveShapePageContext(page: ReturnType<PDFDocument['getPages']>[number]) {
    const pageView = resolvePdfPageView(page);
    if (!pageView) {
        return null;
    }

    return {
        pageView,
        pageRotation: normalizePageRotation(page.getRotation().angle),
    };
}
