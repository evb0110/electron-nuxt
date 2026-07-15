import { readFile } from 'node:fs/promises';
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
import { cast } from '@tests/helpers/cast';

export interface IPdfCanvasFidelityMetrics {
    darkPixelRatio: number;
    height: number;
    inkPixelRatio: number;
    meanLuminance: number;
    textItemCount: number;
    width: number;
}

export async function renderPdfCanvasFidelityMetrics(path: string): Promise<IPdfCanvasFidelityMetrics> {
    Object.assign(globalThis, {
        DOMMatrix,
        ImageData,
        Path2D,
    });
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const bytes = await readFile(path);
    const documentParameters = cast<Parameters<typeof pdfjs.getDocument>[0]>({
        data: new Uint8Array(bytes),
        disableWorker: true,
        // Fidelity fixtures contain unembedded standard fonts. Resolve those
        // from the same vendored PDF.js payload as the app so this corpus
        // measures rendering rather than whichever Helvetica substitute is
        // installed on the current macOS/Linux runner image.
        standardFontDataUrl: `${resolve(process.cwd(), 'public/pdf/standard_fonts')}${sep}`,
        useSystemFonts: false,
        useWorkerFetch: false,
    });
    const document = await pdfjs.getDocument(documentParameters).promise;
    try {
        const page = await document.getPage(1);
        // PDF points are 1/72 inch. Scale 1 therefore compares every fixture at
        // the same physical 72-DPI output size rather than at source pixel size.
        const viewport = page.getViewport({scale: 1});
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext('2d');
        await page.render({
            canvas: cast<HTMLCanvasElement>(canvas),
            canvasContext: cast<CanvasRenderingContext2D>(context),
            viewport,
        }).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let darkPixels = 0;
        let inkPixels = 0;
        let luminanceTotal = 0;
        for (let offset = 0; offset < pixels.length; offset += 4) {
            const luminance = (pixels[offset]! * 0.2126)
                + (pixels[offset + 1]! * 0.7152)
                + (pixels[offset + 2]! * 0.0722);
            luminanceTotal += luminance;
            if (luminance < 245) {
                inkPixels += 1;
            }
            if (luminance < 128) {
                darkPixels += 1;
            }
        }
        const pixelCount = canvas.width * canvas.height;
        const textContent = await page.getTextContent();
        return {
            darkPixelRatio: darkPixels / pixelCount,
            height: canvas.height,
            inkPixelRatio: inkPixels / pixelCount,
            meanLuminance: luminanceTotal / pixelCount,
            textItemCount: textContent.items.length,
            width: canvas.width,
        };
    } finally {
        await document.destroy();
    }
}
