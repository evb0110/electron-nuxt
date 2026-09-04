import type {
    PDFDocument,
    PDFFont,
    PDFPage,
} from 'pdf-lib';
import {
    PDFArray,
    PDFDict,
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
    rgb,
} from 'pdf-lib';

/**
 * pdf-lib stamps the current time into `/CreationDate` and `/ModDate`, which
 * would make every generated fixture a new SHA-256. The epoch pins both so the
 * manifest can carry a stable hash instead of a "hash after generation" note.
 */
export const FIXTURE_EPOCH = new Date(0);

export const FIXTURE_PRODUCER = 'evb-windows-test-fixtures';

export const FIXTURE_PAGE_WIDTH = 595.28;

export const FIXTURE_PAGE_HEIGHT = 841.89;

export interface IFixtureDocumentIdentity {
    title: string;
    subject: string;
    keywords: string[];
}

export function applyDeterministicDocumentMetadata(
    document: PDFDocument,
    identity: IFixtureDocumentIdentity,
) {
    document.setTitle(identity.title);
    document.setSubject(identity.subject);
    document.setKeywords(identity.keywords);
    document.setAuthor(FIXTURE_PRODUCER);
    document.setProducer(FIXTURE_PRODUCER);
    document.setCreator(FIXTURE_PRODUCER);
    document.setCreationDate(FIXTURE_EPOCH);
    document.setModificationDate(FIXTURE_EPOCH);
}

export function formatPageMarker(packId: string, pageNumber: number) {
    return `EVB-${packId}-PAGE-${String(pageNumber).padStart(2, '0')}`;
}

export function pageFillColor(pageIndex: number, pageCount: number) {
    const ratio = pageCount <= 1 ? 0 : pageIndex / (pageCount - 1);
    return rgb(
        0.55 + (ratio * 0.4),
        0.95 - (ratio * 0.5),
        0.6 + (((pageIndex % 3) / 3) * 0.35),
    );
}

export interface IFixturePageMarkOptions {
    page: PDFPage;
    font: PDFFont;
    marker: string;
    pageIndex: number;
    pageCount: number;
}

export function drawFixturePageMarks({
    page,
    font,
    marker,
    pageIndex,
    pageCount,
}: IFixturePageMarkOptions) {
    const {
        width,
        height,
    } = page.getSize();
    page.drawRectangle({
        x: 18,
        y: 18,
        width: width - 36,
        height: height - 36,
        borderWidth: 2,
        borderColor: rgb(0.1, 0.12, 0.2),
    });
    page.drawRectangle({
        x: 40,
        y: height - 160,
        width: width - 80,
        height: 70,
        color: pageFillColor(pageIndex, pageCount),
    });
    page.drawText(marker, {
        x: 52,
        y: height - 135,
        size: 22,
        font,
        color: rgb(0.05, 0.05, 0.05),
    });
    // A vector mark that moves down the page with the page index, so a page
    // reordered or substituted by a printer path is visible without OCR.
    const markCenterY = height - 220 - (pageIndex * 12);
    page.drawCircle({
        x: 90,
        y: markCenterY,
        size: 26,
        color: rgb(0.15, 0.2, 0.45),
    });
    page.drawLine({
        start: {
            x: 140,
            y: markCenterY - 26,
        },
        end: {
            x: width - 60,
            y: markCenterY + 26,
        },
        thickness: 3,
        color: rgb(0.35, 0.1, 0.1),
    });
    page.drawText(`page ${pageIndex + 1} of ${pageCount}`, {
        x: 52,
        y: 40,
        size: 11,
        font,
        color: rgb(0.2, 0.2, 0.2),
    });
}

export function addNamedDestinations(
    document: PDFDocument,
    destinations: ReadonlyArray<{
        name: string;
        pageIndex: number;
    }>,
) {
    const context = document.context;
    const entries: Array<[PDFString, PDFArray]> = destinations.map((destination) => {
        const page = document.getPage(destination.pageIndex);
        const target = PDFArray.withContext(context);
        target.push(page.ref);
        target.push(PDFName.of('XYZ'));
        target.push(PDFNumber.of(0));
        target.push(PDFNumber.of(page.getHeight()));
        target.push(PDFNumber.of(0));
        return [
            PDFString.of(destination.name),
            target,
        ];
    });
    const names = PDFArray.withContext(context);
    for (const [
        name,
        target,
    ] of entries) {
        names.push(name);
        names.push(target);
    }
    const destinationTree = PDFDict.withContext(context);
    destinationTree.set(PDFName.of('Names'), names);
    const nameTree = PDFDict.withContext(context);
    nameTree.set(PDFName.of('Dests'), context.register(destinationTree));
    document.catalog.set(PDFName.of('Names'), context.register(nameTree));
}

export function addOutline(
    document: PDFDocument,
    items: ReadonlyArray<{
        title: string;
        pageIndex: number;
    }>,
) {
    const context = document.context;
    const outlinesRef = context.nextRef();
    const itemRefs = items.map(() => context.nextRef());
    items.forEach((item, index) => {
        const page = document.getPage(item.pageIndex);
        const destination = PDFArray.withContext(context);
        destination.push(page.ref);
        destination.push(PDFName.of('Fit'));
        const outlineItem = PDFDict.withContext(context);
        outlineItem.set(PDFName.of('Title'), PDFHexString.fromText(item.title));
        outlineItem.set(PDFName.of('Parent'), outlinesRef);
        outlineItem.set(PDFName.of('Dest'), destination);
        const previous = itemRefs[index - 1];
        if (previous !== undefined) {
            outlineItem.set(PDFName.of('Prev'), previous);
        }
        const next = itemRefs[index + 1];
        if (next !== undefined) {
            outlineItem.set(PDFName.of('Next'), next);
        }
        const itemRef = itemRefs[index];
        if (itemRef !== undefined) {
            context.assign(itemRef, outlineItem);
        }
    });
    const outlines = PDFDict.withContext(context);
    outlines.set(PDFName.of('Type'), PDFName.of('Outlines'));
    const first = itemRefs[0];
    const last = itemRefs[itemRefs.length - 1];
    if (first !== undefined && last !== undefined) {
        outlines.set(PDFName.of('First'), first);
        outlines.set(PDFName.of('Last'), last);
    }
    outlines.set(PDFName.of('Count'), PDFNumber.of(items.length));
    context.assign(outlinesRef, outlines);
    document.catalog.set(PDFName.of('Outlines'), outlinesRef);
}

export function addPageLabels(document: PDFDocument, romanPrefixPages: number) {
    const context = document.context;
    const romanRange = PDFDict.withContext(context);
    romanRange.set(PDFName.of('S'), PDFName.of('r'));
    const decimalRange = PDFDict.withContext(context);
    decimalRange.set(PDFName.of('S'), PDFName.of('D'));
    decimalRange.set(PDFName.of('St'), PDFNumber.of(1));
    const numbers = PDFArray.withContext(context);
    numbers.push(PDFNumber.of(0));
    numbers.push(romanRange);
    numbers.push(PDFNumber.of(romanPrefixPages));
    numbers.push(decimalRange);
    const labels = PDFDict.withContext(context);
    labels.set(PDFName.of('Nums'), numbers);
    document.catalog.set(PDFName.of('PageLabels'), context.register(labels));
}

type TAnnotationRect = [number, number, number, number];

function addPageAnnotation(
    document: PDFDocument,
    pageIndex: number,
    subtype: string,
    rect: TAnnotationRect,
    populate: (annotation: PDFDict, rectArray: PDFArray) => void,
) {
    const context = document.context;
    const page = document.getPage(pageIndex);
    const rectArray = PDFArray.withContext(context);
    for (const value of rect) {
        rectArray.push(PDFNumber.of(value));
    }
    const annotation = PDFDict.withContext(context);
    annotation.set(PDFName.of('Type'), PDFName.of('Annot'));
    annotation.set(PDFName.of('Subtype'), PDFName.of(subtype));
    // Callers place /Rect themselves so the dictionary key order, and with it
    // the fixture SHA-256 recorded in the manifest, stays byte-for-byte stable.
    populate(annotation, rectArray);
    page.node.addAnnot(context.register(annotation));
}

export function addLinkAnnotation(
    document: PDFDocument,
    options: {
        pageIndex: number;
        targetPageIndex: number;
        rect: TAnnotationRect;
    },
) {
    const context = document.context;
    const targetPage = document.getPage(options.targetPageIndex);
    const destination = PDFArray.withContext(context);
    destination.push(targetPage.ref);
    destination.push(PDFName.of('Fit'));
    addPageAnnotation(document, options.pageIndex, 'Link', options.rect, (annotation, rectArray) => {
        annotation.set(PDFName.of('Rect'), rectArray);
        annotation.set(PDFName.of('Border'), PDFArray.withContext(context));
        annotation.set(PDFName.of('Dest'), destination);
    });
}

export function addTextAnnotation(
    document: PDFDocument,
    options: {
        pageIndex: number;
        contents: string;
        rect: TAnnotationRect;
    },
) {
    addPageAnnotation(document, options.pageIndex, 'Text', options.rect, (annotation, rectArray) => {
        annotation.set(PDFName.of('Name'), PDFName.of('Comment'));
        annotation.set(PDFName.of('Rect'), rectArray);
        annotation.set(PDFName.of('Contents'), PDFHexString.fromText(options.contents));
        annotation.set(PDFName.of('T'), PDFHexString.fromText(FIXTURE_PRODUCER));
        annotation.set(PDFName.of('F'), PDFNumber.of(4));
    });
}
