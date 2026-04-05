import { PDFDocument } from 'pdf-lib';
import type {
    IBrowserPdfCombineWorkerResultMap,
    TBrowserPdfCombineWorkerRequest,
    TBrowserPdfCombineWorkerResponse,
} from '@app/platform/browser-api/browser-pdf-combine-worker.types';

const WORKER_RASTER_IMAGE_EXTENSIONS = new Set([
    '.apng',
    '.avif',
    '.bmp',
    '.gif',
    '.jpeg',
    '.jpg',
    '.png',
    '.webp',
]);

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
