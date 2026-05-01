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
import type { IPdfBookmarkEntry } from '@app/types/pdf';

interface IOutlineNodeBuild {
    ref: PDFRef;
    dict: PDFDict;
    item: IPdfBookmarkEntry;
    visibleCount: number;
}

export function writeBookmarkOutlines(
    doc: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    const outlinesName = PDFName.of('Outlines');
    if (bookmarks.length === 0) {
        const hadOutlines = doc.catalog.has(outlinesName);
        doc.catalog.delete(outlinesName);
        return hadOutlines;
    }

    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');
    const flagsName = PDFName.of('F');
    const colorName = PDFName.of('C');
    const pdfNull = doc.context.obj(null);

    function setNodeDestination(dict: PDFDict, item: IPdfBookmarkEntry) {
        if (typeof item.pageIndex === 'number') {
            const pageRef = doc.getPage(item.pageIndex).ref;
            dict.set(destName, doc.context.obj([
                pageRef,
                PDFName.of('XYZ'),
                pdfNull,
                pdfNull,
                pdfNull,
            ]));
            return;
        }

        if (item.namedDest) {
            dict.set(destName, PDFString.of(item.namedDest));
        }
    }

    function setNodeStyle(dict: PDFDict, item: IPdfBookmarkEntry) {
        const flags = (item.italic ? 1 : 0) | (item.bold ? 2 : 0);
        if (flags > 0) {
            dict.set(flagsName, PDFNumber.of(flags));
        }

        if (!item.color) {
            return;
        }

        const value = item.color.replace('#', '');
        const red = Number.parseInt(value.slice(0, 2), 16) / 255;
        const green = Number.parseInt(value.slice(2, 4), 16) / 255;
        const blue = Number.parseInt(value.slice(4, 6), 16) / 255;
        dict.set(colorName, doc.context.obj([
            red,
            green,
            blue,
        ]));
    }

    function buildOutlineLevel(items: IPdfBookmarkEntry[], parentRef: PDFRef) {
        if (items.length === 0) {
            return {
                first: null as PDFRef | null,
                last: null as PDFRef | null,
                visibleCount: 0,
            };
        }

        const nodes: IOutlineNodeBuild[] = items.map((item) => {
            const dict = doc.context.obj({});
            dict.set(titleName, PDFHexString.fromText(item.title));
            setNodeDestination(dict, item);
            setNodeStyle(dict, item);
            const ref = doc.context.register(dict);
            return {
                ref,
                dict,
                item,
                visibleCount: 1,
            };
        });

        nodes.forEach((node, index) => {
            node.dict.set(parentName, parentRef);
            const previous = nodes[index - 1];
            if (previous) {
                node.dict.set(prevName, previous.ref);
            }
            const next = nodes[index + 1];
            if (next) {
                node.dict.set(nextName, next.ref);
            }
        });

        for (const node of nodes) {
            const childResult = buildOutlineLevel(node.item.items, node.ref);
            if (childResult.first && childResult.last) {
                node.dict.set(firstName, childResult.first);
                node.dict.set(lastName, childResult.last);
                if (childResult.visibleCount > 0) {
                    node.dict.set(countName, PDFNumber.of(childResult.visibleCount));
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

    const outlinesDict = doc.context.obj({});
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = doc.context.register(outlinesDict);
    const tree = buildOutlineLevel(bookmarks, outlinesRef);
    if (!tree.first || !tree.last) {
        doc.catalog.delete(outlinesName);
        return true;
    }

    outlinesDict.set(firstName, tree.first);
    outlinesDict.set(lastName, tree.last);
    outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
    doc.catalog.set(outlinesName, outlinesRef);
    return true;
}
