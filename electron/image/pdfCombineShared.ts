import {
    open,
    readFile,
    stat,
} from 'fs/promises';
import { extname } from 'path';
import { encode } from 'fast-png';
import {
    PDFDocument,
    type PDFImage,
} from 'pdf-lib';
import { iterateDecodedTiffFrames } from '@pdf-core';
import {
    pixelsToPdfPoints,
    readImageDpi,
    readTiffFrameDpi,
} from '@electron/image/imageDpi';
import { parseIntegerEnv } from '@electron/utils/parseIntegerEnv';
import { tryCreatePdfWithNativeImageCombiner } from '@electron/image/tryCreatePdfWithNativeImageCombiner';

export interface ICreateCombinedPdfProgress {
    processed: number;
    total: number;
    percent: number;
    elapsedMs: number;
    estimatedRemainingMs: number | null;
}

interface ICreateCombinedPdfOptions {
    onProgress?: (progress: ICreateCombinedPdfProgress) => void;
    unsupportedFileError: (sourcePath: string) => string;
    appendDjvuPages?: (targetPdf: PDFDocument, sourcePath: string) => Promise<number>;
}

interface IPdfCombineResourceLimits {
    maxInputBytes: number;
    maxPages: number;
    maxTiffFrames: number;
    maxImagePixels: number;
    maxOutputBytes: number;
}

export const PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS = [
    '.png',
    '.jpg',
    '.jpeg',
    '.tif',
    '.tiff',
    '.bmp',
    '.webp',
    '.gif',
] as const;

const SUPPORTED_IMAGE_EXTENSION_SET = new Set<string>(
    PDF_COMBINE_SUPPORTED_IMAGE_EXTENSIONS,
);
const DEFAULT_RESOURCE_LIMITS: IPdfCombineResourceLimits = {
    maxInputBytes: parseIntegerEnv('EVB_PDF_COMBINE_MAX_INPUT_MB', 512, 16, 4096) * 1024 * 1024,
    maxPages: parseIntegerEnv('EVB_PDF_COMBINE_MAX_PAGES', 500, 1, 10_000),
    maxTiffFrames: parseIntegerEnv('EVB_PDF_COMBINE_MAX_TIFF_FRAMES', 250, 1, 5_000),
    maxImagePixels: parseIntegerEnv('EVB_PDF_COMBINE_MAX_IMAGE_PIXELS', 80_000_000, 1_000_000),
    maxOutputBytes: parseIntegerEnv('EVB_PDF_COMBINE_MAX_OUTPUT_MB', 512, 1, 4096) * 1024 * 1024,
};
const PNG_SIGNATURE = [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
] as const;
const JPEG_START_OF_IMAGE = 0xd8;
const JPEG_START_OF_SCAN = 0xda;
const BITMAP_HEADER_PREFIX_BYTES = 64;

interface IImageDimensions {
    width: number;
    height: number;
}

function getDefaultResourceLimits(): IPdfCombineResourceLimits {
    return { ...DEFAULT_RESOURCE_LIMITS };
}

function assertPageLimit(nextPageCount: number, limits: IPdfCombineResourceLimits) {
    if (nextPageCount > limits.maxPages) {
        throw new Error(`Combined PDF is capped at ${limits.maxPages} pages`);
    }
}

function assertPixelLimit(width: number, height: number, sourcePath: string, limits: IPdfCombineResourceLimits) {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
        throw new Error(`Image has invalid dimensions: ${sourcePath}`);
    }
    if (width > limits.maxImagePixels / height) {
        throw new Error(`Image dimensions are too large to combine safely: ${sourcePath}`);
    }
}

function assertOutputLimit(outputBytes: Uint8Array, limits: IPdfCombineResourceLimits) {
    if (outputBytes.byteLength > limits.maxOutputBytes) {
        throw new Error('Combined PDF output is too large to return safely');
    }
}

async function assertInputByteLimit(sourcePath: string, limits: IPdfCombineResourceLimits) {
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile()) {
        throw new Error(`Input path is not a regular file: ${sourcePath}`);
    }
    if (fileStat.size > limits.maxInputBytes) {
        throw new Error(`Input file is too large to combine safely: ${sourcePath}`);
    }
}

function readUint16BE(data: Uint8Array, offset: number) {
    return (data[offset]! << 8) | data[offset + 1]!;
}

function readUint16LE(data: Uint8Array, offset: number) {
    return data[offset]! | (data[offset + 1]! << 8);
}

function readInt32LE(data: Uint8Array, offset: number) {
    return (
        data[offset]!
        | (data[offset + 1]! << 8)
        | (data[offset + 2]! << 16)
        | (data[offset + 3]! << 24)
    );
}

function readUint24LE(data: Uint8Array, offset: number) {
    return data[offset]! | (data[offset + 1]! << 8) | (data[offset + 2]! << 16);
}

function readUint32LE(data: Uint8Array, offset: number) {
    return (
        data[offset]!
        | (data[offset + 1]! << 8)
        | (data[offset + 2]! << 16)
        | (data[offset + 3]! << 24)
    ) >>> 0;
}

function readUint32BE(data: Uint8Array, offset: number) {
    return ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;
}

function readPngDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 24
        || !PNG_SIGNATURE.every((value, index) => data[index] === value)
        || data[12] !== 0x49
        || data[13] !== 0x48
        || data[14] !== 0x44
        || data[15] !== 0x52
    ) {
        return null;
    }
    return {
        width: readUint32BE(data, 16),
        height: readUint32BE(data, 20),
    };
}

function isJpegStartOfFrameMarker(marker: number) {
    return (
        (marker >= 0xc0 && marker <= 0xc3)
        || (marker >= 0xc5 && marker <= 0xc7)
        || (marker >= 0xc9 && marker <= 0xcb)
        || (marker >= 0xcd && marker <= 0xcf)
    );
}

function readJpegDimensions(data: Uint8Array): IImageDimensions | null {
    if (data.byteLength < 4 || data[0] !== 0xff || data[1] !== JPEG_START_OF_IMAGE) {
        return null;
    }
    let offset = 2;
    while (offset + 4 < data.byteLength) {
        if (data[offset] !== 0xff) {
            return null;
        }
        while (offset < data.byteLength && data[offset] === 0xff) {
            offset += 1;
        }
        const marker = data[offset]!;
        offset += 1;
        if (marker === JPEG_START_OF_SCAN) {
            return null;
        }
        if (offset + 2 > data.byteLength) {
            return null;
        }
        const segmentLength = readUint16BE(data, offset);
        if (segmentLength < 2 || offset + segmentLength > data.byteLength) {
            return null;
        }
        if (isJpegStartOfFrameMarker(marker)) {
            if (segmentLength < 7) {
                return null;
            }
            return {
                height: readUint16BE(data, offset + 3),
                width: readUint16BE(data, offset + 5),
            };
        }
        offset += segmentLength;
    }
    return null;
}

function readBmpDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 22
        || data[0] !== 0x42
        || data[1] !== 0x4d
    ) {
        return null;
    }

    const dibHeaderSize = readUint32LE(data, 14);
    if (dibHeaderSize === 12) {
        if (data.byteLength < 22) {
            return null;
        }
        return {
            width: readUint16LE(data, 18),
            height: readUint16LE(data, 20),
        };
    }

    if (dibHeaderSize < 40 || data.byteLength < 26) {
        return null;
    }

    return {
        width: readInt32LE(data, 18),
        height: Math.abs(readInt32LE(data, 22)),
    };
}

function readGifDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 10
        || data[0] !== 0x47
        || data[1] !== 0x49
        || data[2] !== 0x46
        || data[3] !== 0x38
        || (data[4] !== 0x37 && data[4] !== 0x39)
        || data[5] !== 0x61
    ) {
        return null;
    }

    return {
        width: readUint16LE(data, 6),
        height: readUint16LE(data, 8),
    };
}

function readWebpLossyDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 10 || payloadOffset + 10 > data.byteLength) {
        return null;
    }

    return {
        width: readUint16LE(data, payloadOffset + 6) & 0x3fff,
        height: readUint16LE(data, payloadOffset + 8) & 0x3fff,
    };
}

function readWebpLosslessDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 5 || payloadOffset + 5 > data.byteLength || data[payloadOffset] !== 0x2f) {
        return null;
    }

    const bits = readUint32LE(data, payloadOffset + 1);
    return {
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >>> 14) & 0x3fff),
    };
}

function readWebpExtendedDimensions(data: Uint8Array, payloadOffset: number, chunkSize: number): IImageDimensions | null {
    if (chunkSize < 10 || payloadOffset + 10 > data.byteLength) {
        return null;
    }

    return {
        width: 1 + readUint24LE(data, payloadOffset + 4),
        height: 1 + readUint24LE(data, payloadOffset + 7),
    };
}

function readWebpDimensions(data: Uint8Array): IImageDimensions | null {
    if (
        data.byteLength < 20
        || data[0] !== 0x52
        || data[1] !== 0x49
        || data[2] !== 0x46
        || data[3] !== 0x46
        || data[8] !== 0x57
        || data[9] !== 0x45
        || data[10] !== 0x42
        || data[11] !== 0x50
    ) {
        return null;
    }

    const chunkType = String.fromCharCode(
        data[12]!,
        data[13]!,
        data[14]!,
        data[15]!,
    );
    const chunkSize = readUint32LE(data, 16);
    const payloadOffset = 20;

    // The first WEBP chunk carries canvas dimensions before any compressed payload decode.
    if (chunkType === 'VP8 ') {
        return readWebpLossyDimensions(data, payloadOffset, chunkSize);
    }
    if (chunkType === 'VP8L') {
        return readWebpLosslessDimensions(data, payloadOffset, chunkSize);
    }
    if (chunkType === 'VP8X') {
        return readWebpExtendedDimensions(data, payloadOffset, chunkSize);
    }
    return null;
}

function readKnownBitmapDimensions(data: Uint8Array, extension: string) {
    if (extension === '.png') {
        return readPngDimensions(data);
    }
    if (extension === '.jpg' || extension === '.jpeg') {
        return readJpegDimensions(data);
    }
    if (extension === '.bmp') {
        return readBmpDimensions(data);
    }
    if (extension === '.gif') {
        return readGifDimensions(data);
    }
    if (extension === '.webp') {
        return readWebpDimensions(data);
    }
    return null;
}

function shouldFailClosedForBitmapHeader(extension: string) {
    return extension === '.bmp' || extension === '.gif' || extension === '.webp';
}

function assertKnownBitmapPixelLimit(
    data: Uint8Array,
    extension: string,
    sourcePath: string,
    limits: IPdfCombineResourceLimits,
) {
    const dimensions = readKnownBitmapDimensions(data, extension);
    if (dimensions) {
        assertPixelLimit(dimensions.width, dimensions.height, sourcePath, limits);
        return;
    }
    if (shouldFailClosedForBitmapHeader(extension)) {
        throw new Error(`Image dimensions are too large to combine safely: ${sourcePath}`);
    }
}

async function readBitmapHeaderPrefix(sourcePath: string) {
    const file = await open(sourcePath, 'r');
    try {
        const data = new Uint8Array(BITMAP_HEADER_PREFIX_BYTES);
        const { bytesRead } = await file.read(data, 0, data.byteLength, 0);
        return data.subarray(0, bytesRead);
    } finally {
        await file.close();
    }
}

async function normalizeImageWithElectron(sourcePath: string) {
    const { nativeImage } = await import('electron');
    const image = nativeImage.createFromPath(sourcePath);
    if (image.isEmpty()) {
        throw new Error(`Unsupported or unreadable image: ${sourcePath}`);
    }
    return image.toPNG();
}

function appendEmbeddedImagePage(
    targetPdf: PDFDocument,
    embeddedImage: PDFImage,
    dpi: number,
) {
    const pageWidth = pixelsToPdfPoints(embeddedImage.width, dpi);
    const pageHeight = pixelsToPdfPoints(embeddedImage.height, dpi);
    const page = targetPdf.addPage([
        pageWidth,
        pageHeight,
    ]);

    page.drawImage(embeddedImage, {
        x: 0,
        y: 0,
        width: pageWidth,
        height: pageHeight,
    });

    return 1;
}

function normalizeCombineInputPaths(inputPaths: string[]): string[] {
    return inputPaths
        .map((path) => path.trim())
        .filter((path) => path.length > 0);
}

export function isImagePath(filePath: string) {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

function isDjvuPath(filePath: string) {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number) {
    if (processed <= 0 || total <= processed) {
        return 0;
    }
    const averagePerItem = elapsedMs / processed;
    const remainingItems = total - processed;
    return Math.max(0, Math.round(averagePerItem * remainingItems));
}

function createCombineProgress(
    startedAt: number,
    processed: number,
    total: number,
): ICreateCombinedPdfProgress {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    return {
        processed,
        total,
        percent: Math.round((processed / total) * 100),
        elapsedMs,
        estimatedRemainingMs: estimateRemainingMs(elapsedMs, processed, total),
    };
}

async function appendPdfPages(
    targetPdf: PDFDocument,
    sourcePath: string,
    currentPageCount: number,
    limits: IPdfCombineResourceLimits,
) {
    await assertInputByteLimit(sourcePath, limits);
    const sourceBytes = await readFile(sourcePath);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const pageIndices = sourcePdf.getPageIndices();
    assertPageLimit(currentPageCount + pageIndices.length, limits);

    if (pageIndices.length === 0) {
        return 0;
    }

    const copiedPages = await targetPdf.copyPages(sourcePdf, pageIndices);
    for (const page of copiedPages) {
        targetPdf.addPage(page);
    }

    return copiedPages.length;
}

async function appendBitmapPage(
    targetPdf: PDFDocument,
    sourcePath: string,
    currentPageCount: number,
    limits: IPdfCombineResourceLimits,
) {
    assertPageLimit(currentPageCount + 1, limits);
    await assertInputByteLimit(sourcePath, limits);
    const extension = extname(sourcePath).toLowerCase();
    if (shouldFailClosedForBitmapHeader(extension)) {
        assertKnownBitmapPixelLimit(await readBitmapHeaderPrefix(sourcePath), extension, sourcePath, limits);
    }
    const originalBytes = await readFile(sourcePath);
    if (!shouldFailClosedForBitmapHeader(extension)) {
        assertKnownBitmapPixelLimit(originalBytes, extension, sourcePath, limits);
    }
    const dpi = readImageDpi(originalBytes, extension);

    let embeddedImage: PDFImage;
    if (extension === '.png') {
        embeddedImage = await targetPdf.embedPng(originalBytes);
    } else if (extension === '.jpg' || extension === '.jpeg') {
        embeddedImage = await targetPdf.embedJpg(originalBytes);
    } else {
        embeddedImage = await targetPdf.embedPng(await normalizeImageWithElectron(sourcePath));
    }
    assertPixelLimit(embeddedImage.width, embeddedImage.height, sourcePath, limits);

    return appendEmbeddedImagePage(targetPdf, embeddedImage, dpi);
}

async function appendTiffPages(
    targetPdf: PDFDocument,
    sourcePath: string,
    currentPageCount: number,
    limits: IPdfCombineResourceLimits,
) {
    await assertInputByteLimit(sourcePath, limits);
    const tiffBytes = new Uint8Array(await readFile(sourcePath));
    let addedPages = 0;

    for (const {
        frame,
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(tiffBytes)) {
        assertPageLimit(currentPageCount + addedPages + 1, limits);
        if (addedPages >= limits.maxTiffFrames) {
            throw new Error(`TIFF frame count is capped at ${limits.maxTiffFrames}: ${sourcePath}`);
        }
        assertPixelLimit(width, height, sourcePath, limits);
        const dpi = readTiffFrameDpi(frame as Record<string, unknown>) ?? 72;
        const pngBytes = encode({
            width,
            height,
            data: rgba,
            channels: 4,
        });
        const embeddedImage = await targetPdf.embedPng(pngBytes);

        appendEmbeddedImagePage(targetPdf, embeddedImage, dpi);
        addedPages += 1;
    }

    if (addedPages === 0) {
        throw new Error(`No decodable TIFF pages found in ${sourcePath}`);
    }

    return addedPages;
}

async function appendImagePages(
    targetPdf: PDFDocument,
    sourcePath: string,
    currentPageCount: number,
    limits: IPdfCombineResourceLimits,
) {
    const extension = extname(sourcePath).toLowerCase();
    if (extension === '.tif' || extension === '.tiff') {
        return appendTiffPages(targetPdf, sourcePath, currentPageCount, limits);
    }
    return appendBitmapPage(targetPdf, sourcePath, currentPageCount, limits);
}

export async function createCombinedPdf(
    inputPaths: string[],
    options: ICreateCombinedPdfOptions,
) {
    const normalizedPaths = normalizeCombineInputPaths(inputPaths);
    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const limits = getDefaultResourceLimits();
    assertPageLimit(normalizedPaths.length, limits);

    const nativeOptions = options.onProgress
        ? {onProgress: options.onProgress}
        : undefined;
    const nativeImagePdf = await tryCreatePdfWithNativeImageCombiner(normalizedPaths, nativeOptions);
    if (nativeImagePdf) {
        assertOutputLimit(nativeImagePdf, limits);
        return nativeImagePdf;
    }

    const targetPdf = await PDFDocument.create();
    let pageCount = 0;
    const startedAt = Date.now();

    for (let index = 0; index < normalizedPaths.length; index++) {
        const sourcePath = normalizedPaths[index]!;
        const extension = extname(sourcePath).toLowerCase();

        if (extension === '.pdf') {
            pageCount += await appendPdfPages(targetPdf, sourcePath, pageCount, limits);
        } else if (isDjvuPath(sourcePath) && options.appendDjvuPages) {
            const addedPages = await options.appendDjvuPages(targetPdf, sourcePath);
            assertPageLimit(pageCount + addedPages, limits);
            pageCount += addedPages;
        } else if (isImagePath(sourcePath)) {
            pageCount += await appendImagePages(targetPdf, sourcePath, pageCount, limits);
        } else {
            throw new Error(options.unsupportedFileError(sourcePath));
        }

        if (options.onProgress) {
            options.onProgress(createCombineProgress(
                startedAt,
                index + 1,
                normalizedPaths.length,
            ));
        }
    }

    if (pageCount === 0) {
        throw new Error('No pages were generated from the input files');
    }

    const outputBytes = await targetPdf.save();
    assertOutputLimit(outputBytes, limits);
    return outputBytes;
}
