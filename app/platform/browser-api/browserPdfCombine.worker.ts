import { PDFDocument } from 'pdf-lib';
import {
    DEFAULT_TIFF_DECODE_LIMITS,
    iterateDecodedTiffFrames,
} from '@pdf-core';
import type {
    IBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import {
    getBrowserPdfCombineWorkerRequestId,
    parseBrowserPdfCombineWorkerRequest,
} from '@app/platform/browser-api/browserPdfCombineWorker.types';
import { appendPdfImagePage } from '@app/platform/browser-api/appendPdfImagePage';
import {
    BROWSER_COMBINE_IMAGE_EXTENSIONS,
    getBrowserFileExtension,
    toBrowserOwnedArrayBuffer,
} from '@app/platform/browser-api/browserPlatformHelpers';
import { tryCombineImageInputsWithWasm } from '@app/platform/browser-api/tryCombineImageInputsWithWasm';
import { toTransferableUint8Array } from '@app/platform/browser-api/toTransferableUint8Array';
import { getErrorMessage } from '@app/utils/error';

async function convertWorkerImageBytesToPng(fileName: string, bytes: Uint8Array) {
    if (
        typeof createImageBitmap !== 'function'
        || typeof OffscreenCanvas === 'undefined'
    ) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const blob = new Blob([toBrowserOwnedArrayBuffer(bytes, { copy: true })]);
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
    input: IBrowserPdfCombineWorkerRequest['payload']['inputs'][number],
) {
    let addedPages = 0;

    for (const {
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(input.data, {
            ...DEFAULT_TIFF_DECODE_LIMITS,
            sourceLabel: input.fileName,
        })) {
        const pngBytes = await convertWorkerRgbaToPng(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image);
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }
}

async function appendInputToPdfDocument(
    pdfDocument: PDFDocument,
    input: IBrowserPdfCombineWorkerRequest['payload']['inputs'][number],
) {
    const extension = getBrowserFileExtension(input.fileName);
    if (extension === '.pdf') {
        const sourcePdf = await PDFDocument.load(input.data);
        const copiedPages = await pdfDocument.copyPages(
            sourcePdf,
            sourcePdf.getPageIndices(),
        );
        copiedPages.forEach((page) => pdfDocument.addPage(page));
        return;
    }

    if (!BROWSER_COMBINE_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }

    if (extension === '.tif' || extension === '.tiff') {
        await appendWorkerTiffPages(pdfDocument, input);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(input.data);
        appendPdfImagePage(pdfDocument, image);
        return;
    }

    const pngBytes = extension === '.png'
        ? input.data
        : await convertWorkerImageBytesToPng(input.fileName, input.data);
    const image = await pdfDocument.embedPng(pngBytes);
    appendPdfImagePage(pdfDocument, image);
}

async function handleCombinePdfsRequest(
    request: IBrowserPdfCombineWorkerRequest,
) {
    const wasmResult = await tryCombineImageInputsWithWasm(
        request.payload.inputs,
        request.payload.wasmImagePreprocessing,
    );
    if (wasmResult) {
        return {data: wasmResult};
    }
    if (request.payload.wasmImagePreprocessing) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_WASM_PREPROCESSING_UNAVAILABLE');
    }

    const pdfDocument = await PDFDocument.create();

    for (const input of request.payload.inputs) {
        await appendInputToPdfDocument(pdfDocument, input);
    }

    const data = toTransferableUint8Array(new Uint8Array(await pdfDocument.save()));
    return { data };
}

self.addEventListener('message', async (event: MessageEvent<unknown>) => {
    const request = parseBrowserPdfCombineWorkerRequest(event.data);
    if (request === null) {
        const id = getBrowserPdfCombineWorkerRequestId(event.data);
        if (id !== null) {
            self.postMessage({
                id,
                ok: false,
                error: 'Invalid browser PDF combine worker request',
            } satisfies TBrowserPdfCombineWorkerResponse);
        }
        return;
    }

    try {
        const data = await handleCombinePdfsRequest(
            request,
        );
        const response = {
            id: request.id,
            type: request.type,
            ok: true,
            data: data,
        } satisfies TBrowserPdfCombineWorkerResponse;
        self.postMessage(response, [data.data.buffer]);
    } catch (error) {
        const response = {
            id: request.id,
            ok: false,
            error: getErrorMessage(error),
        } satisfies TBrowserPdfCombineWorkerResponse;
        self.postMessage(response);
    }
});
