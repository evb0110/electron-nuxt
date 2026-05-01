import { join } from 'path';
import { randomUUID } from 'node:crypto';
import {
    rename,
    unlink,
    readFile,
    writeFile,
} from 'fs/promises';
import { existsSync } from 'fs';
import {
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import type {
    ICropMargins,
    IPageGeometry,
} from '@contracts/shared';
import { createLogger } from '@electron/utils/logger';
import { getErrorMessage } from '@electron/utils/error';

const log = createLogger('page-ops-crop');

function isValidCropMargin(value: number) {
    return Number.isFinite(value) && value >= 0;
}

function assertValidMargins(margins: ICropMargins) {
    if (
        !isValidCropMargin(margins.top)
        || !isValidCropMargin(margins.bottom)
        || !isValidCropMargin(margins.left)
        || !isValidCropMargin(margins.right)
    ) {
        throw new Error('Invalid crop margins');
    }
}

function boxesEqual(
    left: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
    right: {
        x: number;
        y: number;
        width: number;
        height: number;
    },
) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

function makeTempPath(workingCopyPath: string) {
    const dir = join(workingCopyPath, '..');
    const id = `tmp-${randomUUID()}`;
    return join(dir, `${id}.pdf`);
}

async function atomicReplace(tempPath: string, targetPath: string) {
    await rename(tempPath, targetPath);
}

async function cleanupTemp(tempPath: string) {
    try {
        if (existsSync(tempPath)) {
            await unlink(tempPath);
        }
    } catch (cleanupError) {
        log.debug(`Failed to cleanup temp file "${tempPath}": ${
            getErrorMessage(cleanupError)
        }`);
    }
}

export async function cropPagesLocal(
    workingCopyPath: string,
    pages: number[],
    margins: ICropMargins,
) {
    assertValidMargins(margins);

    const pdfBytes = await readFile(workingCopyPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const allPages = pdfDoc.getPages();

    for (const pageNum of pages) {
        const page = allPages[pageNum - 1];
        if (!page) continue;

        const mediaBox = page.getMediaBox();
        const cropX = mediaBox.x + margins.left;
        const cropY = mediaBox.y + margins.bottom;
        const cropWidth = mediaBox.width - margins.left - margins.right;
        const cropHeight = mediaBox.height - margins.top - margins.bottom;

        if (cropWidth <= 0 || cropHeight <= 0) {
            log.debug(`Skipping page ${pageNum}: crop dimensions invalid (${cropWidth}x${cropHeight})`);
            continue;
        }

        page.setCropBox(cropX, cropY, cropWidth, cropHeight);
    }

    const tempPath = makeTempPath(workingCopyPath);
    try {
        const outputBytes = await pdfDoc.save();
        await writeFile(tempPath, outputBytes);
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }
}

export async function removeCropFromPagesLocal(
    workingCopyPath: string,
    pages: number[],
) {
    const pdfBytes = await readFile(workingCopyPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const allPages = pdfDoc.getPages();

    for (const pageNum of pages) {
        const page = allPages[pageNum - 1];
        if (!page) continue;

        const mediaBox = page.getMediaBox();
        const cropBox = page.getCropBox();

        if (boxesEqual(cropBox, mediaBox)) {
            page.node.delete(PDFName.of('CropBox'));
            continue;
        }

        page.setCropBox(mediaBox.x, mediaBox.y, mediaBox.width, mediaBox.height);
    }

    const tempPath = makeTempPath(workingCopyPath);
    try {
        const outputBytes = await pdfDoc.save();
        await writeFile(tempPath, outputBytes);
        await atomicReplace(tempPath, workingCopyPath);
    } catch (err) {
        await cleanupTemp(tempPath);
        throw err;
    }
}

export async function getPageGeometryLocal(
    workingCopyPath: string,
    pageNumber: number,
): Promise<IPageGeometry> {
    const pdfBytes = await readFile(workingCopyPath);
    const pdfDoc = await PDFDocument.load(pdfBytes);
    const allPages = pdfDoc.getPages();
    const page = allPages[pageNumber - 1];

    if (!page) {
        throw new Error(`Page ${pageNumber} not found`);
    }

    const mediaBox = page.getMediaBox();
    const resolvedCropBox = page.getCropBox();
    const cropBox = boxesEqual(resolvedCropBox, mediaBox) ? null : resolvedCropBox;
    const rotation = page.getRotation().angle;

    return {
        mediaBox: {
            x: mediaBox.x,
            y: mediaBox.y,
            width: mediaBox.width,
            height: mediaBox.height,
        },
        cropBox: cropBox
            ? {
                x: cropBox.x,
                y: cropBox.y,
                width: cropBox.width,
                height: cropBox.height,
            }
            : null,
        rotation,
    };
}
