import type { PDFDocument } from 'pdf-lib';
import { iterateDecodedTiffFrames } from '@pdf-core/iterateDecodedTiffFrames';
import { getExtension } from '@app/platform/browser-api/browserFileName';
import { toBrowserOwnedArrayBuffer } from '@app/platform/browser-api/browserPlatformHelpers';
import { appendPdfImagePage } from '@app/platform/browser-api/appendPdfImagePage';

async function normalizeImageBytesToPng(fileName: string, bytes: Uint8Array) {
    const extension = getExtension(fileName);
    if (extension === '.png') {
        return bytes;
    }

    if (typeof document === 'undefined' || typeof URL === 'undefined') {
        throw new Error(
            `Image format is not available in the current browser runtime: ${fileName}`,
        );
    }

    const blob = new Blob([toBrowserOwnedArrayBuffer(bytes)]);
    const objectUrl = URL.createObjectURL(blob);

    try {
        const image = await new Promise<HTMLImageElement>((resolve, reject) => {
            const nextImage = new Image();
            nextImage.onload = () => resolve(nextImage);
            nextImage.onerror = () =>
                reject(new Error(`Failed to load image: ${fileName}`));
            nextImage.src = objectUrl;
        });

        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth || image.width;
        canvas.height = image.naturalHeight || image.height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('Canvas 2D context is unavailable');
        }

        context.drawImage(image, 0, 0);
        return await canvasToPngBytes(canvas);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

function createClampedImageData(rgba: Uint8Array, width: number, height: number) {
    if (typeof ImageData === 'undefined') {
        throw new Error('ImageData is unavailable in the current browser runtime');
    }

    const clamped = new Uint8ClampedArray(rgba.byteLength);
    clamped.set(rgba);
    return new ImageData(clamped, width, height);
}

async function canvasToPngBytes(canvas: HTMLCanvasElement) {
    const pngBlob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((nextBlob) => {
            if (!nextBlob) {
                reject(new Error('Failed to convert image to PNG'));
                return;
            }

            resolve(nextBlob);
        }, 'image/png');
    });

    return new Uint8Array(await pngBlob.arrayBuffer());
}

async function encodeRgbaToPngBytes(
    width: number,
    height: number,
    rgba: Uint8Array,
) {
    if (typeof document === 'undefined') {
        throw new Error('Canvas 2D context is unavailable');
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
        throw new Error('Canvas 2D context is unavailable');
    }

    context.putImageData(createClampedImageData(rgba, width, height), 0, 0);
    return canvasToPngBytes(canvas);
}

async function embedTiffPages(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    let addedPages = 0;

    for (const {
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(bytes)) {
        const pngBytes = await encodeRgbaToPngBytes(width, height, rgba);
        const image = await pdfDocument.embedPng(pngBytes);
        appendPdfImagePage(pdfDocument, image);
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`Failed to decode TIFF image: ${fileName}`);
    }
}

export async function embedImagePage(
    pdfDocument: PDFDocument,
    fileName: string,
    bytes: Uint8Array,
) {
    const extension = getExtension(fileName);
    if (extension === '.tif' || extension === '.tiff') {
        await embedTiffPages(pdfDocument, fileName, bytes);
        return;
    }

    if (extension === '.jpg' || extension === '.jpeg') {
        const image = await pdfDocument.embedJpg(bytes);
        appendPdfImagePage(pdfDocument, image);
        return;
    }

    const pngBytes = await normalizeImageBytesToPng(fileName, bytes);
    const image = await pdfDocument.embedPng(pngBytes);
    appendPdfImagePage(pdfDocument, image);
}
