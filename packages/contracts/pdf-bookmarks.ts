import type {
    PDFDict,
    PDFDocument,
    PDFRef,
} from 'pdf-lib';
import {
    PDFHexString,
    PDFName,
    PDFNumber,
    PDFString,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from './pdf';

interface IBookmarkOutlineNode {
    ref: PDFRef;
    dict: PDFDict;
    item: IPdfBookmarkEntry;
    visibleCount: number;
}

function setNodeDestination(
    document: PDFDocument,
    dict: PDFDict,
    item: IPdfBookmarkEntry,
) {
    if (
        typeof item.pageIndex === 'number'
        && item.pageIndex >= 0
        && item.pageIndex < document.getPageCount()
    ) {
        const pageRef = document.getPage(item.pageIndex).ref;
        dict.set(PDFName.of('Dest'), document.context.obj([
            pageRef,
            PDFName.of('XYZ'),
            document.context.obj(null),
            document.context.obj(null),
            document.context.obj(null),
        ]));
        return;
    }

    if (item.namedDest) {
        dict.set(PDFName.of('Dest'), PDFString.of(item.namedDest));
    }
}

function setNodeStyle(document: PDFDocument, dict: PDFDict, item: IPdfBookmarkEntry) {
    const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
    if (flags > 0) {
        dict.set(PDFName.of('F'), PDFNumber.of(flags));
    }

    if (!item.color) {
        return;
    }

    const value = item.color.replace('#', '');
    const red = Number.parseInt(value.slice(0, 2), 16) / 255;
    const green = Number.parseInt(value.slice(2, 4), 16) / 255;
    const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
    dict.set(PDFName.of('C'), document.context.obj([
        red,
        green,
        blue,
    ]));
}

function buildOutlineLevel(
    document: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
    parentRef: PDFRef,
) {
    if (bookmarks.length === 0) {
        return {
            first: null as PDFRef | null,
            last: null as PDFRef | null,
            visibleCount: 0,
        };
    }

    const nodes: IBookmarkOutlineNode[] = bookmarks.map((item) => {
        const dict = document.context.obj({});
        dict.set(PDFName.of('Title'), PDFHexString.fromText(item.title));

        setNodeDestination(document, dict, item);
        setNodeStyle(document, dict, item);

        const ref = document.context.register(dict);
        return {
            ref,
            dict,
            item,
            visibleCount: 1,
        };
    });

    for (const [
        index,
        node,
    ] of nodes.entries()) {
        node.dict.set(PDFName.of('Parent'), parentRef);
        if (index > 0) {
            const previous = nodes[index - 1];
            if (previous) {
                node.dict.set(PDFName.of('Prev'), previous.ref);
            }
        }
        if (index + 1 < nodes.length) {
            const next = nodes[index + 1];
            if (next) {
                node.dict.set(PDFName.of('Next'), next.ref);
            }
        }
    }

    for (const node of nodes) {
        const childResult = buildOutlineLevel(document, node.item.items, node.ref);
        if (childResult.first && childResult.last) {
            node.dict.set(PDFName.of('First'), childResult.first);
            node.dict.set(PDFName.of('Last'), childResult.last);
            if (childResult.visibleCount > 0) {
                node.dict.set(PDFName.of('Count'), PDFNumber.of(childResult.visibleCount));
            }
            node.visibleCount += childResult.visibleCount;
        }
    }

    return {
        first: nodes[0]?.ref ?? null,
        last: nodes[nodes.length - 1]?.ref ?? null,
        visibleCount: nodes.reduce((total, node) => total + node.visibleCount, 0),
    };
}

export function writePdfBookmarkOutlines(
    document: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    const outlinesName = PDFName.of('Outlines');
    const outlinesDict = document.context.obj({});
    outlinesDict.set(PDFName.of('Type'), PDFName.of('Outlines'));
    const outlinesRef = document.context.register(outlinesDict);

    const tree = buildOutlineLevel(document, bookmarks, outlinesRef);
    if (!tree.first || !tree.last) {
        document.catalog.delete(outlinesName);
        return false;
    }

    outlinesDict.set(PDFName.of('First'), tree.first);
    outlinesDict.set(PDFName.of('Last'), tree.last);
    outlinesDict.set(PDFName.of('Count'), PDFNumber.of(tree.visibleCount));
    document.catalog.set(outlinesName, outlinesRef);
    return true;
}
