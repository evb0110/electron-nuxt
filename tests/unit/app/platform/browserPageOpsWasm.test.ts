import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
    PDFDocument,
    degrees,
} from 'pdf-lib';
import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IPageGeometry } from '@contracts/shared';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core';

const NativeWebAssembly = WebAssembly;

interface IPdfPageSummary {
    mediaBox: IPageGeometry['mediaBox'];
    cropBox: IPageGeometry['cropBox'];
    rotation: number;
}

function toArrayBuffer(data: Uint8Array) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
}

async function createPdf(options: {
    pageWidths: number[];
    cropSecondPage?: boolean;
    rotateSecondPage?: boolean;
}) {
    const pdfDocument = await PDFDocument.create();
    for (const [
        index,
        width,
    ] of options.pageWidths.entries()) {
        const page = pdfDocument.addPage([
            width,
            100 + (index * 20),
        ]);
        if (index === 1 && options.cropSecondPage) {
            page.setCropBox(10, 12, width - 30, 80);
        }
        if (index === 1 && options.rotateSecondPage) {
            page.setRotation(degrees(90));
        }
    }

    return new Uint8Array(await pdfDocument.save());
}

async function summarizePdf(data: Uint8Array): Promise<IPdfPageSummary[]> {
    const pdfDocument = await PDFDocument.load(data);
    return pdfDocument.getPages().map((page) => {
        const mediaBox = resolvePdfLibMediaBox(page);
        return {
            mediaBox,
            cropBox: resolvePdfLibCropBox(page, mediaBox),
            rotation: page.getRotation().angle,
        };
    });
}

async function stubSuccessfulWasmFetch() {
    vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
    vi.stubGlobal('WebAssembly', NativeWebAssembly);
    const wasmBytes = await readFile(join(process.cwd(), 'public/wasm/evb-pdf-page-ops.wasm'));
    const fetchMock = vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () => toArrayBuffer(wasmBytes),
    }));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

async function loadWasmRunner() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const module = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
    return {
        fetchMock,
        run: module.tryRunBrowserPageOpsWithWasm,
    };
}

async function loadCoreWithWasm() {
    vi.resetModules();
    vi.unstubAllGlobals();
    const fetchMock = await stubSuccessfulWasmFetch();
    const core = await import('@app/platform/browser-api/browserPageOpsCore');
    return {
        ...core,
        fetchMock,
    };
}

async function loadPdfLibCore() {
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.stubGlobal('WebAssembly', undefined);
    return import('@app/platform/browser-api/browserPageOpsCore');
}

describe('browser page-ops WASM fast path', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.unstubAllGlobals();
    });

    it('matches pdf-lib page summaries for representative operations', async () => {
        const basePdf = await createPdf({
            pageWidths: [
                200,
                300,
                400,
            ],
            cropSecondPage: true,
            rotateSecondPage: true,
        });
        const insertionPdf = await createPdf({pageWidths: [500]});

        const wasm = await loadWasmRunner();
        const wasmDelete = await wasm.run('deletePages', {
            data: basePdf,
            pages: [2],
        });
        const wasmExtract = await wasm.run('extractPages', {
            data: basePdf,
            pages: [
                3,
                1,
            ],
        });
        const wasmReorder = await wasm.run('reorderPages', {
            data: basePdf,
            newOrder: [
                3,
                1,
                2,
            ],
        });
        const wasmInsert = await wasm.run('insertPages', {
            data: basePdf,
            insertionData: insertionPdf,
            afterPage: 1,
        });
        const wasmRotate = await wasm.run('rotate', {
            data: basePdf,
            pages: [
                1,
                3,
            ],
            angle: 90,
        });
        const wasmCrop = await wasm.run('crop', {
            data: basePdf,
            pages: [1],
            margins: {
                top: 4,
                bottom: 6,
                left: 8,
                right: 10,
            },
        });
        const wasmRemoveCrop = await wasm.run('removeCrop', {
            data: basePdf,
            pages: [2],
        });
        const wasmGeometry = await wasm.run('getPageGeometry', {
            data: basePdf,
            pageNumber: 2,
        });

        expect(wasmDelete).not.toBeNull();
        expect(wasmExtract).not.toBeNull();
        expect(wasmReorder).not.toBeNull();
        expect(wasmInsert).not.toBeNull();
        expect(wasmRotate).not.toBeNull();
        expect(wasmCrop).not.toBeNull();
        expect(wasmRemoveCrop).not.toBeNull();
        expect(wasmGeometry).not.toBeNull();
        expect(wasm.fetchMock).toHaveBeenCalledWith('https://viewer.test/wasm/evb-pdf-page-ops.wasm');

        const pdfLibCore = await loadPdfLibCore();
        const pdfLibDelete = await pdfLibCore.deletePdfPages(basePdf, [2]);
        const pdfLibExtract = await pdfLibCore.extractPdfPages(basePdf, [
            3,
            1,
        ]);
        const pdfLibReorder = await pdfLibCore.reorderPdfPages(basePdf, [
            3,
            1,
            2,
        ]);
        const pdfLibInsert = await pdfLibCore.insertPdfPages(basePdf, insertionPdf, 1);
        const pdfLibRotate = await pdfLibCore.rotatePdfBytes(basePdf, [
            1,
            3,
        ], 90);
        const pdfLibCrop = await pdfLibCore.cropPdfBytes(basePdf, [1], {
            top: 4,
            bottom: 6,
            left: 8,
            right: 10,
        });
        const pdfLibRemoveCrop = await pdfLibCore.removeCropPdfBytes(basePdf, [2]);
        const pdfLibGeometry = await pdfLibCore.getPageGeometryFromPdfBytes(basePdf, 2);

        expect(await summarizePdf(wasmDelete!.data)).toEqual(await summarizePdf(pdfLibDelete.data));
        expect(await summarizePdf(wasmExtract!.data)).toEqual(await summarizePdf(pdfLibExtract.data));
        expect(await summarizePdf(wasmReorder!.data)).toEqual(await summarizePdf(pdfLibReorder.data));
        expect(await summarizePdf(wasmInsert!.data)).toEqual(await summarizePdf(pdfLibInsert.data));
        expect(await summarizePdf(wasmRotate!.data)).toEqual(await summarizePdf(pdfLibRotate.data));
        expect(await summarizePdf(wasmCrop!.data)).toEqual(await summarizePdf(pdfLibCrop.data));
        expect(await summarizePdf(wasmRemoveCrop!.data)).toEqual(await summarizePdf(pdfLibRemoveCrop.data));
        expect(wasmGeometry).toEqual(pdfLibGeometry);
    });

    it('leaves non-integer runtime page fields to the pdf-lib fallback validation', async () => {
        const basePdf = await createPdf({pageWidths: [200]});
        const insertionPdf = await createPdf({pageWidths: [300]});
        const core = await loadCoreWithWasm();

        await expect(core.deletePdfPages(basePdf, [1.5]))
            .rejects.toThrow('deletePages: invalid page number 1.5');
        await expect(core.insertPdfPages(basePdf, insertionPdf, 1.5))
            .rejects.toThrow('Invalid afterPage');
        await expect(core.getPageGeometryFromPdfBytes(basePdf, 1.5))
            .rejects.toThrow();
        expect(core.fetchMock).toHaveBeenCalledWith('https://viewer.test/wasm/evb-pdf-page-ops.wasm');
    });

    it('returns null when the WASM asset is unavailable', async () => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/workspace'});
        vi.stubGlobal('WebAssembly', NativeWebAssembly);
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: false,
            arrayBuffer: async () => new ArrayBuffer(0),
        })));
        const { tryRunBrowserPageOpsWithWasm } = await import('@app/platform/browser-api/tryRunBrowserPageOpsWithWasm');
        const basePdf = await createPdf({pageWidths: [200]});

        await expect(tryRunBrowserPageOpsWithWasm('deletePages', {
            data: basePdf,
            pages: [1],
        })).resolves.toBeNull();
    });
});
