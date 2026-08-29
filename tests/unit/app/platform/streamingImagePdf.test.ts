import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { sumBy } from 'es-toolkit/math';
import { StreamingImagePdfWriter } from '@app/platform/browser-api/streamingImagePdfWriter';

const PAGE_TREE_FANOUT = 64;

const MINIMAL_PAGE = {
    bytes: new Uint8Array([
        0xff,
        0xd8,
        0xff,
        0xd9,
    ]),
    width: 1,
    height: 1,
    dpi: 72,
};

function collectKidsArrays(pdfText: string) {
    return pdfText.match(/\/Kids \[([^\]]*)\]/gu) ?? [];
}

function largestKidsArraySize(kidsArrays: string[]) {
    return Math.max(0, ...kidsArrays.map(kidsArray => (kidsArray.match(/ 0 R/gu) ?? []).length));
}

class MemorySink {
    public readonly chunks: Uint8Array[] = [];

    public async write(bytes: Uint8Array) {
        this.chunks.push(bytes.slice());
    }

    public toUint8Array() {
        const totalLength = sumBy(this.chunks, chunk => chunk.byteLength);
        const output = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of this.chunks) {
            output.set(chunk, offset);
            offset += chunk.byteLength;
        }

        return output;
    }
}

describe('StreamingImagePdfWriter', () => {
    it('builds a readable single-page PDF with outlines', async () => {
        const sink = new MemorySink();
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: 1,
            bookmarks: [{
                title: 'Chapter 1',
                pageIndex: 0,
                pageYRatio: 0.5,
                namedDest: null,
                bold: false,
                italic: false,
                color: null,
                items: [],
            }],
        });

        await writer.start();
        await writer.addPage({
            bytes: new Uint8Array([
                0xff,
                0xd8,
                0xff,
                0xd9,
            ]),
            width: 1,
            height: 1,
            dpi: 72,
        });
        await writer.finish();

        const pdfBytes = sink.toUint8Array();
        const pdf = await PDFDocument.load(pdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pdfText = new TextDecoder('latin1').decode(pdfBytes);

        expect(pdf.getPageCount()).toBe(1);
        expect(pdfText).toContain('/Type /Outlines');
        expect(pdfText).toContain('/PageMode /UseOutlines');
        expect(pdfText).toContain('/Title <FEFF004300680061007000740065007200200031>');
        expect(pdfText).toContain('/Dest [2 0 R /XYZ null 0.5 null]');
        expect(pdfText).not.toContain('/XYZ null null null');
    });

    it('keeps a single flat /Kids array at the page-tree fanout boundary', async () => {
        const sink = new MemorySink();
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: PAGE_TREE_FANOUT,
        });

        await writer.start();
        for (let pageIndex = 0; pageIndex < PAGE_TREE_FANOUT; pageIndex += 1) {
            await writer.addPage(MINIMAL_PAGE);
        }
        await writer.finish();

        const pdfBytes = sink.toUint8Array();
        const pdf = await PDFDocument.load(pdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pdfText = new TextDecoder('latin1').decode(pdfBytes);

        expect(pdf.getPageCount()).toBe(PAGE_TREE_FANOUT);
        expect(collectKidsArrays(pdfText)).toHaveLength(1);
        expect(largestKidsArraySize(collectKidsArrays(pdfText))).toBe(PAGE_TREE_FANOUT);
    });

    it('builds a bounded page tree when the output exceeds the fanout', async () => {
        const sink = new MemorySink();
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount: PAGE_TREE_FANOUT + 1,
        });

        await writer.start();
        for (let pageIndex = 0; pageIndex <= PAGE_TREE_FANOUT; pageIndex += 1) {
            await writer.addPage(MINIMAL_PAGE);
        }
        await writer.finish();

        const pdfBytes = sink.toUint8Array();
        const pdf = await PDFDocument.load(pdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pdfText = new TextDecoder('latin1').decode(pdfBytes);

        expect(pdf.getPageCount()).toBe(PAGE_TREE_FANOUT + 1);
        expect(collectKidsArrays(pdfText).length).toBeGreaterThan(1);
        expect(largestKidsArraySize(collectKidsArrays(pdfText))).toBeLessThanOrEqual(PAGE_TREE_FANOUT);
        expect(pdfText).toContain('/Count 65');
    });

    it('builds a multi-level page tree when the output spans several fanout levels', async () => {
        const pageCount = PAGE_TREE_FANOUT * PAGE_TREE_FANOUT + 1;
        const sink = new MemorySink();
        const writer = new StreamingImagePdfWriter({
            sink,
            pageCount,
        });

        await writer.start();
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
            await writer.addPage(MINIMAL_PAGE);
        }
        await writer.finish();

        const pdfBytes = sink.toUint8Array();
        const pdf = await PDFDocument.load(pdfBytes, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const pdfText = new TextDecoder('latin1').decode(pdfBytes);

        expect(pdf.getPageCount()).toBe(pageCount);
        expect(collectKidsArrays(pdfText).length).toBeGreaterThan(2);
        expect(largestKidsArraySize(collectKidsArrays(pdfText))).toBeLessThanOrEqual(PAGE_TREE_FANOUT);
        expect(pdfText).toContain(`/Count ${pageCount}`);
    }, 20_000);

    it('constructs a million-page tree without a page-sized Array.from allocation', () => {
        const arrayFromSpy = vi.spyOn(Array, 'from').mockImplementation(() => {
            throw new Error('million-page tree must not call Array.from');
        });

        try {
            expect(() => new StreamingImagePdfWriter({
                sink: new MemorySink(),
                pageCount: 1_000_000,
            })).not.toThrow();
        } finally {
            arrayFromSpy.mockRestore();
        }
    });
});
