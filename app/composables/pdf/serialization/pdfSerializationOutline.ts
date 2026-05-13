import type { PDFDocument} from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type {
    IPdfBookmarkEntry,
    IPdfPageLabelRange,
} from '@app/types/pdf';
import {
    isImplicitDefaultPageLabels,
    normalizePageLabelRanges,
} from '@app/utils/pdfPageLabels';
import { normalizeBookmarkEntries } from '@app/composables/pdf/usePdfBookmarkSerialization';
import { writeBookmarkOutlines } from '@app/composables/pdf/pdfBookmarkOutlineWriter';

export function applyPageLabels(
    doc: PDFDocument,
    pageLabelsDirty: boolean,
    pageLabelRanges: IPdfPageLabelRange[],
    totalPages: number,
) {
    if (!pageLabelsDirty || totalPages <= 0) {
        return false;
    }

    const normalizedRanges = normalizePageLabelRanges(pageLabelRanges, totalPages);
    const pageLabelsName = PDFName.of('PageLabels');

    if (isImplicitDefaultPageLabels(normalizedRanges, totalPages)) {
        const hadLabels = doc.catalog.has(pageLabelsName);
        doc.catalog.delete(pageLabelsName);
        return hadLabels;
    }

    const nums = doc.context.obj([]);
    const styleName = PDFName.of('S');
    const prefixName = PDFName.of('P');
    const startName = PDFName.of('St');
    const typeName = PDFName.of('Type');
    const pageLabelName = PDFName.of('PageLabel');

    for (const range of normalizedRanges) {
        nums.push(PDFNumber.of(range.startPage - 1));

        const labelDict = doc.context.obj({});
        labelDict.set(typeName, pageLabelName);
        if (range.style) {
            labelDict.set(styleName, PDFName.of(range.style));
        }
        if (range.prefix.length > 0) {
            labelDict.set(prefixName, PDFHexString.fromText(range.prefix));
        }
        if (range.style && range.startNumber > 1) {
            labelDict.set(startName, PDFNumber.of(range.startNumber));
        }

        nums.push(labelDict);
    }

    doc.catalog.set(pageLabelsName, doc.context.obj({Nums: nums}));
    return true;
}

export function applyBookmarks(
    doc: PDFDocument,
    bookmarksDirty: boolean,
    bookmarkItems: IPdfBookmarkEntry[],
    totalPages: number,
    untitledLabel: string,
) {
    if (!bookmarksDirty) {
        return false;
    }

    const normalizedBookmarks = normalizeBookmarkEntries(bookmarkItems, totalPages, untitledLabel);
    return writeBookmarkOutlines(doc, normalizedBookmarks);
}
