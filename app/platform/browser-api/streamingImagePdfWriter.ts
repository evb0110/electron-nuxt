import { sumBy } from 'es-toolkit/math';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';

export interface IStreamingPdfSink { write(bytes: Uint8Array): Promise<void>; }

interface IStreamingPdfPage {
    bytes: Uint8Array;
    width: number;
    height: number;
    dpi: number;
}

interface IBookmarkNodeBuild {
    ref: number;
    item: IPdfBookmarkEntry;
    parentRef: number;
    prevRef: number | null;
    nextRef: number | null;
    firstChildRef: number | null;
    lastChildRef: number | null;
    childVisibleCount: number;
    visibleCount: number;
    children: IBookmarkNodeBuild[];
}

const encoder = new TextEncoder();

// Maximum number of direct /Kids entries per /Pages node. Keeping every
// /Kids array bounded avoids degraded viewer performance on large documents.
const PAGE_TREE_FANOUT = 64;

interface IPageTreeLevelBuild {
    firstNodeRef: number;
    nodeCount: number;
    pageSpan: number;
}

interface IPageTreeBuild {
    rootRef: number;
    rootChildRefs: number[];
    levels: IPageTreeLevelBuild[];
    intermediateNodeCount: number;
    getPageParentRef: (pageIndex: number) => number;
}

function encodeAscii(text: string) {
    return encoder.encode(text);
}

function formatPdfNumber(value: number) {
    if (!Number.isFinite(value)) {
        return '0';
    }

    if (Number.isInteger(value)) {
        return `${value}`;
    }

    return value
        .toFixed(4)
        .replace(/\.?0+$/u, '');
}

function encodePdfTextHex(value: string) {
    let hex = 'FEFF';

    for (let index = 0; index < value.length; index += 1) {
        hex += value.charCodeAt(index).toString(16).padStart(4, '0');
    }

    return `<${hex.toUpperCase()}>`;
}

// Builds a balanced /Pages tree with at most PAGE_TREE_FANOUT entries per
// /Kids array. Outputs within the fanout keep the original flat layout:
// object 1 is the /Pages root and every page is a direct child of it. Larger
// outputs get intermediate /Pages nodes whose object numbers are allocated
// right after the per-page image objects, before the bookmarks. The plan keeps
// only one descriptor per tree level, so catalog setup does not allocate a
// page-sized list before the first page is written.
function buildPageTree(pageCount: number, rootRef: number, firstNodeRef: number): IPageTreeBuild {
    if (pageCount <= PAGE_TREE_FANOUT) {
        const rootChildRefs: number[] = [];
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            rootChildRefs.push(pageObjectNumber(pageIndex));
        }
        return {
            rootRef,
            rootChildRefs,
            levels: [],
            intermediateNodeCount: 0,
            getPageParentRef: () => rootRef,
        };
    }

    const levels: IPageTreeLevelBuild[] = [];
    let nodeCount = Math.ceil(pageCount / PAGE_TREE_FANOUT);
    let pageSpan = PAGE_TREE_FANOUT;
    let intermediateNodeCount = 0;

    while (true) {
        levels.push({
            firstNodeRef: firstNodeRef + intermediateNodeCount,
            nodeCount,
            pageSpan,
        });
        intermediateNodeCount += nodeCount;
        if (nodeCount <= PAGE_TREE_FANOUT) {
            break;
        }
        nodeCount = Math.ceil(nodeCount / PAGE_TREE_FANOUT);
        pageSpan *= PAGE_TREE_FANOUT;
    }

    const rootLevel = levels.at(-1);
    if (!rootLevel) {
        throw new Error('Page tree build produced no root level');
    }
    const rootChildRefs: number[] = [];
    for (let nodeIndex = 0; nodeIndex < rootLevel.nodeCount; nodeIndex += 1) {
        rootChildRefs.push(rootLevel.firstNodeRef + nodeIndex);
    }

    const leafLevel = levels[0];
    return {
        rootRef,
        rootChildRefs,
        levels,
        intermediateNodeCount,
        getPageParentRef: pageIndex => leafLevel
            ? leafLevel.firstNodeRef + Math.floor(pageIndex / PAGE_TREE_FANOUT)
            : rootRef,
    };
}

function formatObjectRef(ref: number) {
    return `${ref} 0 R`;
}

function pageObjectNumber(pageIndex: number) {
    return 2 + (pageIndex * 3);
}

function contentObjectNumber(pageIndex: number) {
    return pageObjectNumber(pageIndex) + 1;
}

function imageObjectNumber(pageIndex: number) {
    return pageObjectNumber(pageIndex) + 2;
}

function resolveBookmarkDestinationTop(pageHeight: number, pageYRatio: number | null | undefined) {
    const normalizedRatio = typeof pageYRatio === 'number' && Number.isFinite(pageYRatio)
        ? Math.min(1, Math.max(0, pageYRatio))
        : 0;
    return pageHeight - normalizedRatio * Math.max(0, pageHeight);
}

function createBookmarkNodes(items: IPdfBookmarkEntry[], parentRef: number) {
    return items.map((item) => ({
        ref: 0,
        item,
        parentRef,
        prevRef: null,
        nextRef: null,
        firstChildRef: null,
        lastChildRef: null,
        childVisibleCount: 0,
        visibleCount: 1,
        children: [],
    }));
}

function assignBookmarkRefs(nodes: IBookmarkNodeBuild[], nextRef: number) {
    let cursorRef = nextRef;
    for (const node of nodes) {
        node.ref = cursorRef;
        cursorRef += 1;
    }
    return cursorRef;
}

function linkBookmarkSiblings(nodes: IBookmarkNodeBuild[]) {
    for (const [
        index,
        node,
    ] of nodes.entries()) {
        node.prevRef = nodes[index - 1]?.ref ?? null;
        node.nextRef = nodes[index + 1]?.ref ?? null;
    }
}

function flattenBookmarkLevel(
    items: IPdfBookmarkEntry[],
    parentRef: number,
    nextRef: number,
): {
    nodes: IBookmarkNodeBuild[];
    nextRef: number;
    visibleCount: number;
} {
    const nodes: IBookmarkNodeBuild[] = createBookmarkNodes(items, parentRef);
    let cursorRef = assignBookmarkRefs(nodes, nextRef);
    linkBookmarkSiblings(nodes);

    for (const node of nodes) {
        const childBuild = flattenBookmarkLevel(
            node.item.items ?? [],
            node.ref,
            cursorRef,
        );
        cursorRef = childBuild.nextRef;
        node.children = childBuild.nodes;
        node.firstChildRef = childBuild.nodes[0]?.ref ?? null;
        node.lastChildRef = childBuild.nodes.at(-1)?.ref ?? null;
        node.childVisibleCount = childBuild.visibleCount;
        node.visibleCount += childBuild.visibleCount;
    }

    return {
        nodes,
        nextRef: cursorRef,
        visibleCount: sumBy(nodes, node => node.visibleCount),
    };
}

export class StreamingImagePdfWriter {
    private readonly objectOffsets = new Map<number, number>();
    private readonly bookmarks: IPdfBookmarkEntry[];
    private readonly pageCount: number;
    private readonly sink: IStreamingPdfSink;
    private readonly pageHeights = new Map<number, number>();
    private readonly pageTree: IPageTreeBuild;
    private bytesWritten = 0;
    private pagesWritten = 0;

    public constructor(options: {
        sink: IStreamingPdfSink;
        pageCount: number;
        bookmarks?: IPdfBookmarkEntry[];
    }) {
        this.sink = options.sink;
        this.pageCount = options.pageCount;
        this.bookmarks = options.bookmarks ?? [];
        this.pageTree = buildPageTree(
            this.pageCount,
            1,
            imageObjectNumber(this.pageCount - 1) + 1,
        );
    }

    public async start() {
        await this.writeBytes(new Uint8Array([
            0x25,
            0x50,
            0x44,
            0x46,
            0x2d,
            0x31,
            0x2e,
            0x37,
            0x0a,
            0x25,
            0xff,
            0xff,
            0xff,
            0xff,
            0x0a,
        ]));
    }

    public async addPage(page: IStreamingPdfPage) {
        const pageIndex = this.pagesWritten;
        if (pageIndex >= this.pageCount) {
            throw new Error('StreamingImagePdfWriter received more pages than declared');
        }

        const pageWidth = (page.width / Math.max(1, page.dpi)) * 72;
        const pageHeight = (page.height / Math.max(1, page.dpi)) * 72;
        const imageRef = imageObjectNumber(pageIndex);
        const contentRef = contentObjectNumber(pageIndex);
        const pageRef = pageObjectNumber(pageIndex);
        this.pageHeights.set(pageIndex, pageHeight);

        await this.writeStreamObject(imageRef, [
            '/Type /XObject',
            '/Subtype /Image',
            `/Width ${page.width}`,
            `/Height ${page.height}`,
            '/ColorSpace /DeviceRGB',
            '/BitsPerComponent 8',
            '/Filter /DCTDecode',
        ], page.bytes);

        const contentBytes = encodeAscii(
            `q ${formatPdfNumber(pageWidth)} 0 0 ${formatPdfNumber(pageHeight)} 0 0 cm /Im0 Do Q\n`,
        );
        await this.writeStreamObject(contentRef, [], contentBytes);

        await this.writeObject(pageRef, [
            '<<',
            '/Type /Page',
            `/Parent ${this.pageTree.getPageParentRef(pageIndex)} 0 R`,
            `/MediaBox [0 0 ${formatPdfNumber(pageWidth)} ${formatPdfNumber(pageHeight)}]`,
            `/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 ${imageRef} 0 R >> >>`,
            `/Contents ${contentRef} 0 R`,
            '>>',
        ]);

        this.pagesWritten += 1;
    }

    public async finish() {
        if (this.pagesWritten !== this.pageCount) {
            throw new Error('StreamingImagePdfWriter finished before all pages were written');
        }

        await this.writePagesRoot();

        for (const [
            levelIndex,
            level,
        ] of this.pageTree.levels.entries()) {
            const childLevel = this.pageTree.levels[levelIndex - 1];
            for (let nodeIndex = 0; nodeIndex < level.nodeCount; nodeIndex += 1) {
                const childStart = nodeIndex * PAGE_TREE_FANOUT;
                const childCount = Math.min(
                    PAGE_TREE_FANOUT,
                    childLevel
                        ? childLevel.nodeCount - childStart
                        : this.pageCount - childStart,
                );
                const childRefs: number[] = [];
                for (let childIndex = 0; childIndex < childCount; childIndex += 1) {
                    const childRef = childLevel
                        ? childLevel.firstNodeRef + childStart + childIndex
                        : pageObjectNumber(childStart + childIndex);
                    childRefs.push(childRef);
                }
                const pageStart = nodeIndex * level.pageSpan;
                const nodePageCount = Math.min(level.pageSpan, this.pageCount - pageStart);
                const parentLevel = this.pageTree.levels[levelIndex + 1];
                const parentRef = parentLevel
                    ? parentLevel.firstNodeRef + Math.floor(nodeIndex / PAGE_TREE_FANOUT)
                    : this.pageTree.rootRef;
                await this.writeObject(level.firstNodeRef + nodeIndex, [
                    '<<',
                    '/Type /Pages',
                    `/Parent ${parentRef} 0 R`,
                    `/Count ${nodePageCount}`,
                    `/Kids [${childRefs.map(formatObjectRef).join(' ')}]`,
                    '>>',
                ]);
            }
        }

        let outlinesRootRef: number | null = null;
        let nextRef = imageObjectNumber(this.pageCount - 1) + 1
            + this.pageTree.intermediateNodeCount;

        if (this.bookmarks.length > 0) {
            outlinesRootRef = nextRef;
            nextRef += 1;
            const bookmarkBuild = flattenBookmarkLevel(
                this.bookmarks,
                outlinesRootRef,
                nextRef,
            );

            for (const node of this.iterateBookmarkNodes(bookmarkBuild.nodes)) {
                await this.writeBookmarkNode(node);
            }

            await this.writeObject(outlinesRootRef, [
                '<<',
                '/Type /Outlines',
                `/First ${bookmarkBuild.nodes[0]?.ref ?? 0} 0 R`,
                `/Last ${bookmarkBuild.nodes.at(-1)?.ref ?? 0} 0 R`,
                `/Count ${bookmarkBuild.visibleCount}`,
                '>>',
            ]);

            nextRef = bookmarkBuild.nextRef;
        }

        const catalogRef = nextRef;
        const catalogLines = [
            '<<',
            '/Type /Catalog',
            '/Pages 1 0 R',
        ];
        if (outlinesRootRef) {
            catalogLines.push(`/Outlines ${outlinesRootRef} 0 R`);
            catalogLines.push('/PageMode /UseOutlines');
        }
        catalogLines.push('>>');
        await this.writeObject(catalogRef, catalogLines);

        const xrefOffset = this.bytesWritten;
        await this.writeXrefTable(catalogRef);
        await this.writeBytes(encodeAscii(
            `trailer\n<<\n/Size ${catalogRef + 1}\n/Root ${catalogRef} 0 R\n>>\nstartxref\n${xrefOffset}\n%%EOF`,
        ));
    }

    private *iterateBookmarkNodes(nodes: IBookmarkNodeBuild[]): Generator<IBookmarkNodeBuild> {
        for (const node of nodes) {
            yield node;
            yield* this.iterateBookmarkNodes(node.children);
        }
    }

    private async writePagesRoot() {
        await this.writeObject(1, [
            '<<',
            '/Type /Pages',
            `/Count ${this.pageCount}`,
            `/Kids [${this.pageTree.rootChildRefs.map(formatObjectRef).join(' ')}]`,
            '>>',
        ]);
    }

    private async writeBookmarkNode(node: IBookmarkNodeBuild) {
        const lines = [
            '<<',
            `/Title ${encodePdfTextHex(node.item.title)}`,
            `/Parent ${node.parentRef} 0 R`,
        ];

        if (node.prevRef) {
            lines.push(`/Prev ${node.prevRef} 0 R`);
        }
        if (node.nextRef) {
            lines.push(`/Next ${node.nextRef} 0 R`);
        }
        if (node.firstChildRef && node.lastChildRef) {
            lines.push(`/First ${node.firstChildRef} 0 R`);
            lines.push(`/Last ${node.lastChildRef} 0 R`);
            lines.push(`/Count ${node.childVisibleCount}`);
        }
        if (
            typeof node.item.pageIndex === 'number'
            && node.item.pageIndex >= 0
            && node.item.pageIndex < this.pageCount
        ) {
            const pageHeight = this.pageHeights.get(node.item.pageIndex) ?? 0;
            const destinationTop = resolveBookmarkDestinationTop(pageHeight, node.item.pageYRatio);
            lines.push(
                `/Dest [${pageObjectNumber(node.item.pageIndex)} 0 R /XYZ null ${formatPdfNumber(destinationTop)} null]`,
            );
        }

        lines.push('>>');
        await this.writeObject(node.ref, lines);
    }

    private async writeXrefTable(maxObjectNumber: number) {
        await this.writeBytes(encodeAscii(`xref\n0 ${maxObjectNumber + 1}\n`));
        await this.writeBytes(encodeAscii('0000000000 65535 f \n'));

        for (let objectNumber = 1; objectNumber <= maxObjectNumber; objectNumber += 1) {
            const offset = this.objectOffsets.get(objectNumber) ?? 0;
            await this.writeBytes(encodeAscii(
                `${offset.toString().padStart(10, '0')} 00000 n \n`,
            ));
        }
    }

    private async writeObject(objectNumber: number, lines: string[]) {
        this.objectOffsets.set(objectNumber, this.bytesWritten);
        await this.writeBytes(encodeAscii(`${objectNumber} 0 obj\n`));
        for (const line of lines) {
            await this.writeBytes(encodeAscii(`${line}\n`));
        }
        await this.writeBytes(encodeAscii('endobj\n'));
    }

    private async writeStreamObject(
        objectNumber: number,
        dictionaryLines: string[],
        bytes: Uint8Array,
    ) {
        this.objectOffsets.set(objectNumber, this.bytesWritten);
        await this.writeBytes(encodeAscii(`${objectNumber} 0 obj\n<<\n`));
        for (const line of dictionaryLines) {
            await this.writeBytes(encodeAscii(`${line}\n`));
        }
        await this.writeBytes(encodeAscii(`/Length ${bytes.byteLength}\n>>\nstream\n`));
        await this.writeBytes(bytes);
        await this.writeBytes(encodeAscii('\nendstream\nendobj\n'));
    }

    private async writeBytes(bytes: Uint8Array) {
        await this.sink.write(bytes);
        this.bytesWritten += bytes.byteLength;
    }
}
