import {
    PDFHexString,
    PDFName,
    PDFNumber,
} from 'pdf-lib';
import type {
    PDFDocument,
    PDFDict,
    PDFRef,
} from 'pdf-lib';
import type { IPdfBookmarkEntry } from '@contracts/pdf';

export function applyBookmarksToPdfDocument(
    document: PDFDocument,
    bookmarks: IPdfBookmarkEntry[],
) {
    if (bookmarks.length === 0) {
        return;
    }

    const outlinesName = PDFName.of('Outlines');
    const parentName = PDFName.of('Parent');
    const prevName = PDFName.of('Prev');
    const nextName = PDFName.of('Next');
    const firstName = PDFName.of('First');
    const lastName = PDFName.of('Last');
    const countName = PDFName.of('Count');
    const titleName = PDFName.of('Title');
    const destName = PDFName.of('Dest');
    const typeName = PDFName.of('Type');

    const pdfNull = document.context.obj(null);

    interface INodeBuild {
        ref: PDFRef;
        dict: PDFDict;
        item: IPdfBookmarkEntry;
        visibleCount: number;
    }

    function buildLevel(items: IPdfBookmarkEntry[], parentRef: PDFRef) {
        if (items.length === 0) {
            return {
                first: null,
                last: null,
                visibleCount: 0,
            };
        }

        const pageCount = document.getPageCount();
        const nodes: INodeBuild[] = items.map((item) => {
            const dict = document.context.obj({});
            dict.set(titleName, PDFHexString.fromText(item.title));

            if (
                typeof item.pageIndex === 'number'
                && item.pageIndex >= 0
                && item.pageIndex < pageCount
            ) {
                const pageRef = document.getPage(item.pageIndex).ref;
                const destArray = document.context.obj([
                    pageRef,
                    PDFName.of('XYZ'),
                    pdfNull,
                    pdfNull,
                    pdfNull,
                ]);
                dict.set(destName, destArray);
            }

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
            node.dict.set(parentName, parentRef);
            if (index > 0) {
                const previous = nodes[index - 1];
                if (previous) {
                    node.dict.set(prevName, previous.ref);
                }
            }
            if (index + 1 < nodes.length) {
                const next = nodes[index + 1];
                if (next) {
                    node.dict.set(nextName, next.ref);
                }
            }
        }

        for (const node of nodes) {
            const childResult = buildLevel(node.item.items, node.ref);
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

    const outlinesDict = document.context.obj({});
    outlinesDict.set(typeName, PDFName.of('Outlines'));
    const outlinesRef = document.context.register(outlinesDict);

    const tree = buildLevel(bookmarks, outlinesRef);
    if (tree.first && tree.last) {
        outlinesDict.set(firstName, tree.first);
        outlinesDict.set(lastName, tree.last);
        outlinesDict.set(countName, PDFNumber.of(tree.visibleCount));
        document.catalog.set(outlinesName, outlinesRef);
    }
}
