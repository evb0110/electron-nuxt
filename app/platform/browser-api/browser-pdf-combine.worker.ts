import { PDFDocument } from 'pdf-lib';
import UTIF from 'utif';
import type {
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browser-pdf-combine-worker.types';

interface IUtifFrame {
    width?: number;
    height?: number;
    [key: string]: unknown;
}

interface IUtifModule {
    decode(data: Uint8Array | ArrayBufferLike): IUtifFrame[];
    decodeImage(data: Uint8Array | ArrayBufferLike, ifd: IUtifFrame): void;
    toRGBA8(ifd: IUtifFrame): Uint8Array;
}

const WORKER_RASTER_IMAGE_EXTENSIONS = new Set([
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.tif',
    '.tiff',
    '.webp',
]);
const UTIF_MODULE = UTIF as IUtifModule;

function getExtension(fileName: string) {
    const lowerName = fileName.toLowerCase();
    const lastDot = lowerName.lastIndexOf('.');
    return lastDot >= 0 ? lowerName.slice(lastDot) : '';
}

function toTransferableUint8Array(data: Uint8Array) {
    if (
        data.byteOffset === 0
        && data.byteLength === data.buffer.byteLength
    ) {
        return data;
    }

    return data.slice();
}

function toOwnedArrayBuffer(bytes: Uint8Array) {
    const copied = new Uint8Array(bytes.byteLength);
    copied.set(bytes);
    return copied.buffer;
}

async function convertWorkerImageBytesToPng(fileName: string, bytes: Uint8Array) {
    if (
        typeof createImageBitmap !== 'function'
        || typeof OffscreenCanvas === 'undefined'
    ) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const blob = new Blob([toOwnedArrayBuffer(bytes)]);
    const bitmap = await createImageBitmap(blob);

    try {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
        }

        context.drawImage(bitmap, 0, 0);
        const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
        return new Uint8Array(await pngBlob.arrayBuffer());
    } catch (error) {
        throw error instanceof Error
            ? error
            : new Error(`Failed to convert image in browser combine worker: ${fileName}`);
    } finally {
        bitmap.close();
    }
}

function createWorkerImageData(width: number, height: number, rgba: Uint8Array) {
    if (typeof ImageData === 'undefined') {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const clamped = new Uint8ClampedArray(rgba.byteLength);
    clamped.set(rgba);
    return new ImageData(clamped, width, height);
}

async function convertWorkerRgbaToPng(width: number, height: number, rgba: Uint8Array) {
    if (typeof OffscreenCanvas === 'undefined') {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    context.putImageData(createWorkerImageData(width, height, rgba), 0, 0);
    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    return new Uint8Array(await pngBlob.arrayBuffer());
}

async function appendWorkerTiffPages(
    pdfDocument: PDFDocument,
    input: TBrowserPdfCombineWorkerRequest<'combinePdfs'>['payload']['inputs'][number],
) {
    const ifds = UTIF_MODULE.decode(input.data);
    let addedPages = 0;

    for (const ifd of ifds) {
        UTIF_MODULE.decodeImage(input.data, ifd);

        const width = typeof ifd.width === 'number' ? ifd.width : 0;
        const height = typeof ifd.height === 'number' ? ifd.height : 0;
        if (width <= 0 || height <= 0) {
            continue;
        }

        const rgba = UTIF_MODULE.toRGBA8(ifd);
        if (!rgba || rgba.byteLength === 0) {
            continue;
        }

        const pngBytes = await convertWorkerRgbaToPng(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        const page = pdfDocument.addPage([
            image.width,
            image.height,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
        });
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }
}

async function appendInputToPdfDocument(
    pdfDocument: PDFDocument,
    input: TBrowserPdfCombineWorkerRequest<'combinePdfs'>['payload']['inputs'][number],
) {
    const extension = getExtension(input.fileName);
    if (extension === '.pdf') {
        const sourcePdf = await PDFDocument.load(input.data);
        const copiedPages = await pdfDocument.copyPages(
            sourcePdf,
            sourcePdf.getPageIndices(),
        );
        copiedPages.forEach((page) => pdfDocument.addPage(page));
        return;
    }

    if (!WORKER_RASTER_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }

    if (extension === '.tif' || extension === '.tiff') {
        await appendWorkerTiffPages(pdfDocument, input);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(input.data);
        const page = pdfDocument.addPage([
            image.width,
            image.height,
        ]);
        page.drawImage(image, {
            x: 0,
            y: 0,
            width: image.width,
            height: image.height,
        });
        return;
    }

    const pngBytes = extension === '.png'
        ? input.data
        : await convertWorkerImageBytesToPng(input.fileName, input.data);
    const image = await pdfDocument.embedPng(pngBytes);
    const page = pdfDocument.addPage([
        image.width,
        image.height,
    ]);
    page.drawImage(image, {
        x: 0,
        y: 0,
        width: image.width,
        height: image.height,
    });
}

async function handleCombinePdfsRequest(
    request: TBrowserPdfCombineWorkerRequest<'combinePdfs'>,
) {
    const pdfDocument = await PDFDocument.create();

    for (const input of request.payload.inputs) {
        await appendInputToPdfDocument(pdfDocument, input);
    }

    const data = toTransferableUint8Array(new Uint8Array(await pdfDocument.save()));
    return { data };
}

self.addEventListener('message', async (event: MessageEvent<TBrowserPdfCombineWorkerRequest>) => {
    const request = event.data;

    try {
        const data = await handleCombinePdfsRequest(
            request as TBrowserPdfCombineWorkerRequest<'combinePdfs'>,
        );
        const response: TBrowserPdfCombineWorkerResponse = {
            id: request.id,
            type: request.type,
            ok: true,
            data: data as IBrowserPdfCombineWorkerResultMap['combinePdfs'],
        };
        self.postMessage(response, [data.data.buffer]);
    } catch (error) {
        const response: TBrowserPdfCombineWorkerResponse = {
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
        };
        self.postMessage(response);
    }
});
