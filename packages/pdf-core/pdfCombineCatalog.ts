import type {IPdfBookmarkEntry} from '@contracts/pdfBookmarkEntry';
import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFRef,
    PDFString,
    type PDFDocument,
    type PDFObject,
} from 'pdf-lib';

export const PDF_COMBINE_CATALOG_POLICY = Object.freeze({
    pages: 'preserve',
    outlines: 'preserve-and-remap-destinations',
    pageLabels: 'preserve-and-offset-number-tree',
    forms: 'reject',
    attachments: 'reject',
    javascript: 'reject',
    documentMetadata: 'source-specific-metadata-is-not-promoted-to-output-catalog',
    viewerPreferences: 'source-specific-preferences-are-not-promoted-to-output-catalog',
} as const);

export interface IPdfCombinePageLabelRange {
    pageIndex: number;
    style?: string;
    prefix?: string;
    start?: number;
}

const textValue = (value: PDFObject | undefined) => value instanceof PDFString || value instanceof PDFHexString
    ? value.decodeText()
    : undefined;

const refKey = (value: PDFObject | undefined) => value instanceof PDFRef
    ? `${value.objectNumber}:${value.generationNumber}`
    : null;

function readOutlineItems(
    document: PDFDocument,
    first: PDFObject | undefined,
    pageRefs: Map<string, number>,
    visited = new WeakSet<PDFDict>(),
): IPdfBookmarkEntry[] {
    const output: IPdfBookmarkEntry[] = [];
    let current = first;
    while (current) {
        const dict = current instanceof PDFRef ? document.context.lookup(current, PDFDict) : current;
        if (!(dict instanceof PDFDict) || visited.has(dict)) break;
        visited.add(dict);
        let destination = dict.get(PDFName.of('Dest')) ?? dict.lookupMaybe(PDFName.of('A'), PDFDict)?.get(PDFName.of('D'));
        if (destination instanceof PDFRef) destination = document.context.lookup(destination);
        if (destination instanceof PDFDict) destination = destination.get(PDFName.of('D'));
        if (destination instanceof PDFRef) destination = document.context.lookup(destination);
        const pageIndex = destination instanceof PDFArray
            ? pageRefs.get(refKey(destination.get(0)) ?? '') ?? null
            : null;
        const flags = dict.lookupMaybe(PDFName.of('F'), PDFNumber)?.asNumber() ?? 0;
        output.push({
            title: textValue(dict.get(PDFName.of('Title'))) ?? 'Untitled',
            pageIndex,
            namedDest: null,
            bold: (flags & 2) !== 0,
            italic: (flags & 1) !== 0,
            color: null,
            items: readOutlineItems(document, dict.get(PDFName.of('First')), pageRefs, visited),
        });
        current = dict.get(PDFName.of('Next'));
    }
    return output;
}

export function inspectPdfCombineCatalog(document: PDFDocument) {
    const names = document.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
    if (document.catalog.has(PDFName.of('AcroForm'))) throw new Error('PDF combine does not support source forms');
    if (document.catalog.has(PDFName.of('AF')) || names?.has(PDFName.of('EmbeddedFiles'))) throw new Error('PDF combine does not support source attachments');
    if (names?.has(PDFName.of('JavaScript'))) throw new Error('PDF combine does not support source JavaScript');
    const pageRefs = new Map(document.getPages().map((page, index) => [
        refKey(page.ref)!,
        index,
    ]));
    const outlines = document.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict);
    const bookmarks = outlines ? readOutlineItems(document, outlines.get(PDFName.of('First')), pageRefs) : [];
    const labels = document.catalog.lookupMaybe(PDFName.of('PageLabels'), PDFDict);
    const nums = labels?.lookupMaybe(PDFName.of('Nums'), PDFArray);
    const pageLabels: IPdfCombinePageLabelRange[] = [];
    if (nums) {
        for (let index = 0; index + 1 < nums.size(); index += 2) {
            const pageIndex = nums.lookup(index, PDFNumber).asNumber();
            const dict = nums.lookup(index + 1, PDFDict);
            const style = dict.lookupMaybe(PDFName.of('S'), PDFName)?.asString().replace(/^\//u, '');
            const prefix = textValue(dict.get(PDFName.of('P')));
            const start = dict.lookupMaybe(PDFName.of('St'), PDFNumber)?.asNumber();
            pageLabels.push({
                pageIndex,
                ...(style ? {style} : {}),
                ...(prefix !== undefined ? {prefix} : {}),
                ...(start !== undefined ? {start} : {}),
            });
        }
    }
    return {
        bookmarks,
        pageLabels,
    };
}

export function applyCombinedPdfPageLabels(document: PDFDocument, ranges: readonly IPdfCombinePageLabelRange[]) {
    if (ranges.length === 0) {
        return;
    }
    const nums: PDFObject[] = [];
    for (const range of [...ranges].sort((left, right) => left.pageIndex - right.pageIndex)) {
        const dict = document.context.obj({});
        if (range.style) dict.set(PDFName.of('S'), PDFName.of(range.style));
        if (range.prefix !== undefined) dict.set(PDFName.of('P'), PDFString.of(range.prefix));
        if (range.start !== undefined) dict.set(PDFName.of('St'), PDFNumber.of(range.start));
        nums.push(PDFNumber.of(range.pageIndex), dict);
    }
    document.catalog.set(PDFName.of('PageLabels'), document.context.obj({Nums: document.context.obj(nums)}));
}

export function offsetPdfCombineBookmarks(
    bookmarks: readonly IPdfBookmarkEntry[],
    pageOffset: number,
): IPdfBookmarkEntry[] {
    return bookmarks.map(bookmark => ({
        ...bookmark,
        pageIndex: bookmark.pageIndex === null ? null : bookmark.pageIndex + pageOffset,
        namedDest: null,
        items: offsetPdfCombineBookmarks(bookmark.items, pageOffset),
    }));
}
