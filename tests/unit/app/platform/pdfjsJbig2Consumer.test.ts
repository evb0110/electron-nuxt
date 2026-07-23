import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {readFile} from 'node:fs/promises';
import {
    resolve,
    sep,
} from 'node:path';
import {
    DOMMatrix,
    ImageData,
    Path2D,
    createCanvas,
} from '@napi-rs/canvas';
import {cast} from '@tests/helpers/cast';

function decodePbm(bytes: Uint8Array) {
    let offset = 0;
    const tokens: string[] = [];
    while (tokens.length < 3) {
        while (offset < bytes.length && /\s/u.test(String.fromCharCode(bytes[offset]!))) offset += 1;
        if (bytes[offset] === 0x23) {
            while (offset < bytes.length && bytes[offset] !== 0x0a) offset += 1;
            continue;
        }
        const start = offset;
        while (offset < bytes.length && !/\s/u.test(String.fromCharCode(bytes[offset]!))) offset += 1;
        tokens.push(new TextDecoder().decode(bytes.subarray(start, offset)));
    }
    while (offset < bytes.length && /\s/u.test(String.fromCharCode(bytes[offset]!))) offset += 1;
    const [
        magic,
        widthText,
        heightText,
    ] = tokens;
    if (magic !== 'P4') throw new Error('Expected a binary PBM fixture');
    const width = Number(widthText);
    const height = Number(heightText);
    const stride = Math.ceil(width / 8);
    const pixels = new Uint8Array(width * height);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            pixels[(y * width) + x] = (bytes[offset + (y * stride) + (x >> 3)]! >> (7 - (x & 7))) & 1;
        }
    }
    return {
        height,
        pixels,
        width,
    };
}

describe('pdf.js JBIG2 consumer compatibility', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.stubGlobal('location', {href: 'https://viewer.test/'});
        Object.assign(globalThis, {
            DOMMatrix,
            ImageData,
            Path2D,
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders the release-combiner JBIG2 mask with the source polarity and ink statistics', async () => {
        const fixtureBytes = new Uint8Array(await readFile(resolve(
            process.cwd(),
            'native/jbig2-codec/tests/fixtures/scan-page-000-body.pbm',
        )));
        const wasmBytes = await readFile(resolve(
            process.cwd(),
            'public/wasm/evb-pdf-image-combine.wasm',
        ));
        vi.stubGlobal('fetch', vi.fn(async () => new Response(wasmBytes, {status: 200})));
        const source = decodePbm(fixtureBytes);
        const {tryCombineImageInputsWithWasm} = await import(
            '@app/platform/browser-api/tryCombineImageInputsWithWasm'
        );
        const combined = await tryCombineImageInputsWithWasm([], {pageSpecs: [{
            kind: 'mask',
            pageSize: {
                widthPoints: source.width,
                heightPoints: source.height,
            },
            mask: {
                fileName: 'scan-page-000-body.pbm',
                data: fixtureBytes,
            },
        }]});
        expect(combined.status).toBe('success');
        if (combined.status !== 'success') throw new Error(`Combiner failed: ${combined.status}`);
        expect(new TextDecoder('latin1').decode(combined.data)).toContain('/JBIG2Decode');

        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const documentParameters = cast<Parameters<typeof pdfjs.getDocument>[0]>({
            data: combined.data,
            disableWorker: true,
            useWorkerFetch: false,
            wasmUrl: `${resolve(process.cwd(), 'node_modules/pdfjs-dist/wasm')}${sep}`,
        });
        const document = await pdfjs.getDocument(documentParameters).promise;
        try {
            const page = await document.getPage(1);
            const viewport = page.getViewport({scale: 1});
            const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
            const context = canvas.getContext('2d');
            await page.render({
                canvas: cast<HTMLCanvasElement>(canvas),
                canvasContext: cast<CanvasRenderingContext2D>(context),
                viewport,
            }).promise;
            const rendered = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let sourceInk = 0;
            let renderedInk = 0;
            let mismatches = 0;
            for (let pixel = 0; pixel < source.pixels.length; pixel += 1) {
                const sourceIsInk = source.pixels[pixel] === 1;
                const renderedIsInk = rendered[pixel * 4]! < 128;
                if (sourceIsInk) sourceInk += 1;
                if (renderedIsInk) renderedInk += 1;
                if (sourceIsInk !== renderedIsInk) mismatches += 1;
            }
            expect(canvas.width).toBe(source.width);
            expect(canvas.height).toBe(source.height);
            expect(renderedInk).toBeGreaterThan(0);
            expect(renderedInk / sourceInk).toBeCloseTo(1, 3);
            expect(mismatches / source.pixels.length).toBeLessThan(0.001);
        } finally {
            await document.destroy();
        }
    }, 30_000);
});
