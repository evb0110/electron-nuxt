import {
    describe,
    expect,
    it,
} from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { sumBy } from 'es-toolkit/math';
import { StreamingImagePdfWriter } from '@app/platform/browser-api/streamingImagePdfWriter';

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
    });
});
