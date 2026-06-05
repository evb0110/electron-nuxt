import {
    PDFArray,
    PDFDict,
    type PDFDocument,
    PDFRef,
} from 'pdf-lib';
import { normalizePageRotation } from '@app/composables/pdf/annotationGeometry';
import { resolvePdfPageView } from '@app/composables/pdf/pdfPageBoxes';

export interface IPdfAnnotationRefDict {
    dict: PDFDict;
    ref: PDFRef;
}

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

export function resolvePageAnnotationContext(
    page: ReturnType<PDFDocument['getPages']>[number],
) {
    const pageView = resolvePdfPageView(page);
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

export function computePointsMinMax(points: ReadonlyArray<{
    x: number;
    y: number;
}>) {
    const first = points[0];
    if (!first) {
        return null;
    }

    let minX = first.x;
    let minY = first.y;
    let maxX = first.x;
    let maxY = first.y;
    for (let index = 1; index < points.length; index += 1) {
        const point = points[index]!;
        minX = Math.min(minX, point.x);
        minY = Math.min(minY, point.y);
        maxX = Math.max(maxX, point.x);
        maxY = Math.max(maxY, point.y);
    }
    return {
        minX,
        minY,
        maxX,
        maxY,
    };
}
