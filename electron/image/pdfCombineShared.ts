import { readFile } from 'fs/promises';
import { extname } from 'path';
import { encode } from 'fast-png';
import {
    PDFDocument,
    type PDFImage,
} from 'pdf-lib';
import { iterateDecodedTiffFrames } from '@contracts/tiffDecode';
import {
    pixelsToPdfPoints,
    readImageDpi,
    readTiffFrameDpi,
} from '@electron/image/imageDpi';

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
): number {
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

export function isImagePath(filePath: string): boolean {
    return SUPPORTED_IMAGE_EXTENSION_SET.has(extname(filePath).toLowerCase());
}

function isDjvuPath(filePath: string): boolean {
    const extension = extname(filePath).toLowerCase();
    return extension === '.djvu' || extension === '.djv';
}

function estimateRemainingMs(elapsedMs: number, processed: number, total: number): number {
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
): Promise<number> {
    const sourceBytes = await readFile(sourcePath);
    const sourcePdf = await PDFDocument.load(sourceBytes);
    const pageIndices = sourcePdf.getPageIndices();

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
): Promise<number> {
    const originalBytes = await readFile(sourcePath);
    const extension = extname(sourcePath).toLowerCase();
    const dpi = readImageDpi(originalBytes, extension);

    let embeddedImage: PDFImage;
    if (extension === '.png') {
        embeddedImage = await targetPdf.embedPng(originalBytes);
    } else if (extension === '.jpg' || extension === '.jpeg') {
        embeddedImage = await targetPdf.embedJpg(originalBytes);
    } else {
        embeddedImage = await targetPdf.embedPng(await normalizeImageWithElectron(sourcePath));
    }

    return appendEmbeddedImagePage(targetPdf, embeddedImage, dpi);
}

async function appendTiffPages(
    targetPdf: PDFDocument,
    sourcePath: string,
): Promise<number> {
    const tiffBytes = new Uint8Array(await readFile(sourcePath));
    let addedPages = 0;

    for (const {
        frame,
        width,
        height,
        rgba,
    } of iterateDecodedTiffFrames(tiffBytes)) {
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
): Promise<number> {
    const extension = extname(sourcePath).toLowerCase();
    if (extension === '.tif' || extension === '.tiff') {
        return appendTiffPages(targetPdf, sourcePath);
    }
    return appendBitmapPage(targetPdf, sourcePath);
}

export async function createCombinedPdf(
    inputPaths: string[],
    options: ICreateCombinedPdfOptions,
): Promise<Uint8Array> {
    const normalizedPaths = normalizeCombineInputPaths(inputPaths);
    if (normalizedPaths.length === 0) {
        throw new Error('No input files were provided');
    }

    const targetPdf = await PDFDocument.create();
    let pageCount = 0;
    const startedAt = Date.now();

    for (let index = 0; index < normalizedPaths.length; index++) {
        const sourcePath = normalizedPaths[index]!;
        const extension = extname(sourcePath).toLowerCase();

        if (extension === '.pdf') {
            pageCount += await appendPdfPages(targetPdf, sourcePath);
        } else if (isDjvuPath(sourcePath) && options.appendDjvuPages) {
            pageCount += await options.appendDjvuPages(targetPdf, sourcePath);
        } else if (isImagePath(sourcePath)) {
            pageCount += await appendImagePages(targetPdf, sourcePath);
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

    return targetPdf.save();
}
