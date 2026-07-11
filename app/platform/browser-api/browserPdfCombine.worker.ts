import { PDFDocument } from 'pdf-lib';
import {
    DEFAULT_TIFF_DECODE_LIMITS,
    applyCombinedPdfPageLabels,
    inspectPdfCombineCatalog,
    offsetPdfCombineBookmarks,
    iterateDecodedTiffFrames,
    writePdfBookmarkOutlines,
} from '@pdf-core';
import type {IPdfCombinePageLabelRange} from '@pdf-core';
import type { IPdfBookmarkEntry } from '@contracts/pdfBookmarkEntry';
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
import {
    readBrowserRasterImageMetadata,
    readBrowserTiffFrameDpi,
    resolveBrowserRasterIccProfile,
} from '@app/platform/browser-api/browserRasterImageMetadata';
import {embedPdfImageIccProfile} from '@app/platform/browser-api/embedPdfImageIccProfile';

const MAX_COMBINE_PAGES = 500;
const MAX_IMAGE_PIXELS = 80_000_000;
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
const MAX_DECODED_WORKING_BYTES = 256 * 1024 * 1024;

interface IDecodedWorkingSetBudget {usedBytes: number;}

function consumeDecodedWorkingSet(budget: IDecodedWorkingSetBudget, width: number, height: number, fileName: string) {
    const decodedBytes = width * height * 4;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 0 || budget.usedBytes > MAX_DECODED_WORKING_BYTES - decodedBytes) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_DECODED_WORKING_SET_TOO_LARGE:${fileName}`);
    }
    budget.usedBytes += decodedBytes;
}

function assertImageDimensions(width: number, height: number, fileName: string) {
    if (width < 1 || height < 1 || width > MAX_IMAGE_PIXELS / height) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_IMAGE_TOO_LARGE:${fileName}`);
    }
}

async function convertWorkerImageBytesToPng(fileName: string, bytes: Uint8Array) {
    if (
        typeof createImageBitmap !== 'function'
        || typeof OffscreenCanvas === 'undefined'
    ) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_IMAGE_RUNTIME');
    }

    const extension = getBrowserFileExtension(fileName);
    const metadata = readBrowserRasterImageMetadata(bytes, extension);
    if (!metadata) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${fileName}`);
    }
    assertImageDimensions(metadata.width, metadata.height, fileName);
    const blob = new Blob([toBrowserOwnedArrayBuffer(bytes, { copy: true })]);
    const bitmap = await createImageBitmap(blob);

    try {
        assertImageDimensions(bitmap.width, bitmap.height, fileName);
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
    decodedBudget: IDecodedWorkingSetBudget,
) {
    let addedPages = 0;

    for (const {
        frame,
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(input.data, {
            ...DEFAULT_TIFF_DECODE_LIMITS,
            sourceLabel: input.fileName,
        })) {
        assertImageDimensions(width, height, input.fileName);
        consumeDecodedWorkingSet(decodedBudget, width, height, input.fileName);
        const pngBytes = await convertWorkerRgbaToPng(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image, {dpi: readBrowserTiffFrameDpi(frame)});
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }
    return addedPages;
}

async function appendInputToPdfDocument(
    pdfDocument: PDFDocument,
    input: IBrowserPdfCombineWorkerRequest['payload']['inputs'][number],
    decodedBudget: IDecodedWorkingSetBudget,
): Promise<{
    pageCount: number;
    bookmarks: IPdfBookmarkEntry[];
    pageLabels: IPdfCombinePageLabelRange[]
}> {
    const extension = getBrowserFileExtension(input.fileName);
    if (extension === '.pdf') {
        const sourcePdf = await PDFDocument.load(input.data);
        const catalog = inspectPdfCombineCatalog(sourcePdf);
        const copiedPages = await pdfDocument.copyPages(
            sourcePdf,
            sourcePdf.getPageIndices(),
        );
        if (copiedPages.length > MAX_COMBINE_PAGES) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
        }
        copiedPages.forEach((page) => pdfDocument.addPage(page));
        return {
            pageCount: copiedPages.length,
            ...catalog,
        };
    }

    if (!BROWSER_COMBINE_IMAGE_EXTENSIONS.has(extension)) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_WORKER_UNSUPPORTED_INPUT:${input.fileName}`);
    }

    if (extension === '.tif' || extension === '.tiff') {
        return {
            pageCount: await appendWorkerTiffPages(pdfDocument, input, decodedBudget),
            bookmarks: [],
            pageLabels: [],
        };
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const metadata = readBrowserRasterImageMetadata(input.data, extension);
        if (!metadata) {
            throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${input.fileName}`);
        }
        assertImageDimensions(metadata.width, metadata.height, input.fileName);
        consumeDecodedWorkingSet(decodedBudget, metadata.width, metadata.height, input.fileName);
        const image = await pdfDocument.embedJpg(input.data);
        embedPdfImageIccProfile(pdfDocument, image, await resolveBrowserRasterIccProfile(metadata));
        appendPdfImagePage(pdfDocument, image, metadata);
        return {
            pageCount: 1,
            bookmarks: [],
            pageLabels: [],
        };
    }

    const metadata = readBrowserRasterImageMetadata(input.data, extension);
    if (!metadata) {
        throw new Error(`ERR_BROWSER_PDF_COMBINE_UNREADABLE_IMAGE_HEADER:${input.fileName}`);
    }
    assertImageDimensions(metadata.width, metadata.height, input.fileName);
    consumeDecodedWorkingSet(decodedBudget, metadata.width, metadata.height, input.fileName);
    const pngBytes = extension === '.png'
        ? input.data
        : await convertWorkerImageBytesToPng(input.fileName, input.data);
    const image = await pdfDocument.embedPng(pngBytes);
    embedPdfImageIccProfile(pdfDocument, image, await resolveBrowserRasterIccProfile(metadata));
    appendPdfImagePage(pdfDocument, image, metadata);
    return {
        pageCount: 1,
        bookmarks: [],
        pageLabels: [],
    };
}

async function handleCombinePdfsRequest(
    request: IBrowserPdfCombineWorkerRequest,
) {
    if (request.payload.inputs.length === 0) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_NO_INPUTS');
    }
    if (request.payload.inputs.length > MAX_COMBINE_PAGES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
    }
    const wasmResult = request.payload.inputs.length <= 1 || request.payload.wasmImagePreprocessing
        ? await tryCombineImageInputsWithWasm(
            request.payload.inputs,
            request.payload.wasmImagePreprocessing,
        )
        : {status: 'unsupported'} as const;
    if (wasmResult.status === 'success') {
        return {data: wasmResult.data};
    }
    if (wasmResult.status === 'fatal') {
        throw wasmResult.error;
    }
    if (request.payload.wasmImagePreprocessing) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_WORKER_WASM_PREPROCESSING_UNAVAILABLE');
    }

    const pdfDocument = await PDFDocument.create();
    let pageCount = 0;
    const sourceOutlines: IPdfBookmarkEntry[] = [];
    const pageLabelRanges: IPdfCombinePageLabelRange[] = [];
    const decodedBudget: IDecodedWorkingSetBudget = {usedBytes: 0};

    for (const input of request.payload.inputs) {
        const firstPageIndex = pageCount;
        const appended = await appendInputToPdfDocument(pdfDocument, input, decodedBudget);
        pageCount += appended.pageCount;
        if (pageCount > MAX_COMBINE_PAGES) {
            throw new Error('ERR_BROWSER_PDF_COMBINE_TOO_MANY_PAGES');
        }
        sourceOutlines.push({
            title: input.fileName,
            pageIndex: firstPageIndex,
            namedDest: null,
            bold: false,
            italic: false,
            color: null,
            items: offsetPdfCombineBookmarks(appended.bookmarks, firstPageIndex),
        });
        pageLabelRanges.push(...appended.pageLabels.map(range => ({
            ...range,
            pageIndex: firstPageIndex + range.pageIndex,
        })));
    }
    writePdfBookmarkOutlines(pdfDocument, sourceOutlines);
    applyCombinedPdfPageLabels(pdfDocument, pageLabelRanges);

    const data = toTransferableUint8Array(new Uint8Array(await pdfDocument.save()));
    if (data.byteLength === 0 || data.byteLength > MAX_OUTPUT_BYTES) {
        throw new Error('ERR_BROWSER_PDF_COMBINE_INVALID_OUTPUT');
    }
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
