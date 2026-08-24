import {
    readFile,
    rm,
} from 'fs/promises';
import { join } from 'path';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@contracts/getErrorMessage';
import type {
    IPdfPageSize,
    IReadPdfPageSizesOptions,
} from '@scan-cleanup-core/types';

export type {
    IPdfPageSize, IReadPdfPageSizesOptions,
} from '@scan-cleanup-core/types';

const PAGE_SIZES_TIMEOUT_MS = 60 * 1000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/mu;
// `Page 4 size: 595.276 x 841.89 pts (A4)`: the page view Poppler renders with
// `-cropbox`, which is the same rectangle evb-pdf-page-ops reports.
const PDFINFO_PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+(-?[0-9.]+)\s+x\s+(-?[0-9.]+)\s+pts/gmu;
const PDFINFO_PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gmu;
const PDFINFO_PAGE_BOX_RE = /^Page\s+(\d+)\s+(MediaBox|CropBox):\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s+(-?[0-9.]+)\s*$/gmu;

const MIN_CROP_FALLBACK_DOCUMENT_PAGES = 3;
const MIN_CROP_FALLBACK_LANDSCAPE_SHARE = 0.75;
const LANDSCAPE_GEOMETRY_RATIO = 1.1;
/** A retry candidate must lose at least this share of its physical paper. */
const MATERIAL_CROP_AREA_RATIO = 0.8;

interface IPdfBox {
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
}

interface IPageBoxes {
    media?: IPdfBox;
    crop?: IPdfBox;
}

function invalidPageNumbering(reason: string) {
    return new Error(`evb-pdf-page-ops returned invalid page numbering: ${reason}`);
}

/**
 * The geometry a page carries: the page view (CropBox intersected with
 * MediaBox) in PDF user space, plus the display rotation that view is presented
 * under. It is the same rectangle `split-pages` writes back and the same one
 * `pdftoppm -cropbox` rasterizes, so a canvas measured from it is the canvas the
 * assembled document ends up carrying.
 */
function decodeFinite(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parsePdfBox(
    x1Value: string,
    y1Value: string,
    x2Value: string,
    y2Value: string,
): IPdfBox | null {
    const x1 = Number.parseFloat(x1Value);
    const y1 = Number.parseFloat(y1Value);
    const x2 = Number.parseFloat(x2Value);
    const y2 = Number.parseFloat(y2Value);
    const widthPoints = x2 - x1;
    const heightPoints = y2 - y1;
    if (
        !Number.isFinite(x1)
        || !Number.isFinite(y1)
        || !Number.isFinite(widthPoints)
        || !Number.isFinite(heightPoints)
        || widthPoints <= 0
        || heightPoints <= 0
    ) {
        return null;
    }
    return {
        xPoints: x1,
        yPoints: y1,
        widthPoints,
        heightPoints,
    };
}

function parsePdfInfoBoxes(output: string) {
    const boxes = new Map<number, IPageBoxes>();
    for (const match of output.matchAll(PDFINFO_PAGE_BOX_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const box = parsePdfBox(match[3] ?? '', match[4] ?? '', match[5] ?? '', match[6] ?? '');
        const boxName = match[2];
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || box === null) {
            continue;
        }
        const pageBoxes = boxes.get(pageNumber) ?? {};
        if (boxName === 'MediaBox') {
            pageBoxes.media = box;
        } else if (boxName === 'CropBox') {
            pageBoxes.crop = box;
        }
        boxes.set(pageNumber, pageBoxes);
    }
    return boxes;
}

function attachMediaBoxes(pageSizes: readonly IPdfPageSize[], output: string) {
    const boxes = parsePdfInfoBoxes(output);
    return pageSizes.map(page => {
        const media = boxes.get(page.pageNumber)?.media;
        const crop = boxes.get(page.pageNumber)?.crop;
        return media === undefined
            ? crop === undefined
                ? page
                : {
                    ...page,
                    cropXPoints: crop.xPoints,
                    cropYPoints: crop.yPoints,
                    cropWidthPoints: crop.widthPoints,
                    cropHeightPoints: crop.heightPoints,
                }
            : {
                ...page,
                mediaXPoints: media.xPoints,
                mediaYPoints: media.yPoints,
                mediaWidthPoints: media.widthPoints,
                mediaHeightPoints: media.heightPoints,
                ...(crop === undefined
                    ? {}
                    : {
                        cropXPoints: crop.xPoints,
                        cropYPoints: crop.yPoints,
                        cropWidthPoints: crop.widthPoints,
                        cropHeightPoints: crop.heightPoints,
                    }),
            };
    });
}

export function toCropBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (
        page.cropXPoints === undefined
        || page.cropYPoints === undefined
        || page.cropWidthPoints === undefined
        || page.cropHeightPoints === undefined
    ) {
        return page;
    }
    return {
        ...page,
        xPoints: page.cropXPoints,
        yPoints: page.cropYPoints,
        widthPoints: page.cropWidthPoints,
        heightPoints: page.cropHeightPoints,
        renderBox: 'cropbox',
    };
}

function isLandscape(widthPoints: number, heightPoints: number) {
    return widthPoints >= heightPoints * LANDSCAPE_GEOMETRY_RATIO;
}

function hasMediaGeometry(page: IPdfPageSize): page is IPdfPageSize & {
    mediaXPoints: number;
    mediaYPoints: number;
    mediaWidthPoints: number;
    mediaHeightPoints: number;
} {
    return page.mediaXPoints !== undefined
        && page.mediaYPoints !== undefined
        && page.mediaWidthPoints !== undefined
        && page.mediaHeightPoints !== undefined
        && Number.isFinite(page.mediaXPoints)
        && Number.isFinite(page.mediaYPoints)
        && Number.isFinite(page.mediaWidthPoints)
        && Number.isFinite(page.mediaHeightPoints)
        && page.mediaWidthPoints > 0
        && page.mediaHeightPoints > 0;
}

export function isCropBoxOrientationMismatch(page: IPdfPageSize) {
    return page.heightPoints >= page.widthPoints * LANDSCAPE_GEOMETRY_RATIO
        && hasMediaGeometry(page)
        && isLandscape(page.mediaWidthPoints, page.mediaHeightPoints);
}

/**
 * A large area difference alone is not enough to render a page twice. This
 * predicate is for the native retry after a first-pass classification has
 * supplied content evidence, not for the ordinary renderer fallback.
 */
export function isMateriallySmallerCropBox(page: IPdfPageSize) {
    if (!hasMediaGeometry(page)) {
        return false;
    }
    const cropArea = page.widthPoints * page.heightPoints;
    const mediaArea = page.mediaWidthPoints * page.mediaHeightPoints;
    return Number.isFinite(cropArea)
        && Number.isFinite(mediaArea)
        && cropArea > 0
        && mediaArea > 0
        && cropArea / mediaArea < MATERIAL_CROP_AREA_RATIO;
}

export function toMediaBoxPageSize(page: IPdfPageSize): IPdfPageSize {
    if (!hasMediaGeometry(page)) {
        return page;
    }
    return {
        ...page,
        xPoints: page.mediaXPoints,
        yPoints: page.mediaYPoints,
        widthPoints: page.mediaWidthPoints,
        heightPoints: page.mediaHeightPoints,
        renderBox: 'mediabox',
    };
}

/**
 * Returns the pages where a portrait CropBox is incompatible with the
 * document's dominant landscape paper. This is intentionally a high bar. A
 * normal crop, even a large same-orientation crop, keeps its existing CropBox.
 * A later analysis-driven retry can safely widen that set once the native
 * classifier proves that the MediaBox contains a two-page spread.
 */
export function shouldUseMediaBoxForSuspiciousCrop(
    page: IPdfPageSize,
    pageSizes: readonly IPdfPageSize[],
) {
    if (!hasMediaGeometry(page)) {
        return false;
    }
    const pagesWithMedia = pageSizes.filter(hasMediaGeometry);
    if (pagesWithMedia.length < MIN_CROP_FALLBACK_DOCUMENT_PAGES) {
        return false;
    }
    const landscapePages = pagesWithMedia.filter(candidate => isLandscape(
        candidate.mediaWidthPoints,
        candidate.mediaHeightPoints,
    ));
    if (landscapePages.length / pagesWithMedia.length < MIN_CROP_FALLBACK_LANDSCAPE_SHARE) {
        return false;
    }
    if (!isLandscape(page.mediaWidthPoints, page.mediaHeightPoints)) {
        return false;
    }

    return isCropBoxOrientationMismatch(page);
}

/**
 * Replaces only the suspicious page views with their physical MediaBox. The
 * caller can use the same predicate for the Poppler command, keeping the
 * raster and the page geometry on one rectangle.
 */
export function resolveSuspiciousCropBoxPageSizes(pageSizes: readonly IPdfPageSize[]) {
    return pageSizes.map(page => {
        if (!shouldUseMediaBoxForSuspiciousCrop(page, pageSizes) || !hasMediaGeometry(page)) {
            return page;
        }
        return toMediaBoxPageSize({
            ...page,
            cropXPoints: page.cropXPoints ?? page.xPoints,
            cropYPoints: page.cropYPoints ?? page.yPoints,
            cropWidthPoints: page.cropWidthPoints ?? page.widthPoints,
            cropHeightPoints: page.cropHeightPoints ?? page.heightPoints,
        });
    });
}

export function parsePdfPageSizesPayload(payload: unknown): IPdfPageSize[] {
    if (!isRecord(payload) || !Array.isArray(payload.pages) || payload.pages.length === 0) {
        throw new Error('evb-pdf-page-ops page-sizes returned no pages');
    }
    const pageCount = payload.pages.length;
    const decoded = new Map<number, IPdfPageSize>();
    payload.pages.forEach((page, index) => {
        if (!isRecord(page)) throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(index + 1)}`);
        const widthPoints = decodeFinite(page.widthPoints);
        const heightPoints = decodeFinite(page.heightPoints);
        const pageNumber = decodeFinite(page.pageNumber);
        if (
            pageNumber === null
            || !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
        ) {
            throw invalidPageNumbering(`invalid page number at record ${String(index + 1)}`);
        }
        if (decoded.has(pageNumber)) {
            throw invalidPageNumbering(`duplicate geometry for page ${String(pageNumber)}`);
        }
        if (widthPoints === null || heightPoints === null || widthPoints <= 0 || heightPoints <= 0) {
            throw new Error(`evb-pdf-page-ops returned invalid geometry for page ${String(pageNumber)}`);
        }
        const dominantImageWidthPx = decodeFinite(page.dominantImageWidthPx);
        const dominantImageHeightPx = decodeFinite(page.dominantImageHeightPx);
        const dominantImageWidthPoints = decodeFinite(page.dominantImageWidthPoints);
        const dominantImageHeightPoints = decodeFinite(page.dominantImageHeightPoints);
        const hasDominantImage = dominantImageWidthPx !== null
            && dominantImageHeightPx !== null
            && dominantImageWidthPoints !== null
            && dominantImageHeightPoints !== null
            && Number.isSafeInteger(dominantImageWidthPx)
            && Number.isSafeInteger(dominantImageHeightPx)
            && dominantImageWidthPx > 0
            && dominantImageHeightPx > 0
            && dominantImageWidthPoints > 0
            && dominantImageHeightPoints > 0;
        decoded.set(pageNumber, {
            pageNumber,
            xPoints: decodeFinite(page.xPoints) ?? 0,
            yPoints: decodeFinite(page.yPoints) ?? 0,
            widthPoints,
            heightPoints,
            rotation: decodeFinite(page.rotation) ?? 0,
            ...(hasDominantImage ? {
                dominantImageWidthPx,
                dominantImageHeightPx,
                dominantImageWidthPoints,
                dominantImageHeightPoints,
            } : {}),
        });
    });
    return Array.from({length: pageCount}, (_, index) => {
        const pageNumber = index + 1;
        const page = decoded.get(pageNumber);
        if (!page) {
            throw invalidPageNumbering(`no geometry for page ${String(pageNumber)}`);
        }
        return page;
    });
}

/**
 * The same geometry read out of `pdfinfo -f 1 -l N`. Poppler reports the page
 * view it would render and the page's own rotation. With `-box`, it also gives
 * us the physical MediaBox needed to recognize a clearly undersized CropBox.
 */
export function parsePdfInfoPageGeometry(output: string): IPdfPageSize[] {
    const pageCount = Number.parseInt(PDFINFO_PAGE_COUNT_RE.exec(output)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pdfinfo returned no page count');
    }
    const rotations = new Map<number, number>();
    for (const match of output.matchAll(PDFINFO_PAGE_ROTATION_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const rotation = Number.parseInt(match[2] ?? '', 10);
        if (Number.isSafeInteger(pageNumber) && Number.isSafeInteger(rotation)) {
            rotations.set(pageNumber, rotation);
        }
    }
    const boxes = parsePdfInfoBoxes(output);
    const sizes = new Map<number, IPdfPageSize>();
    for (const match of output.matchAll(PDFINFO_PAGE_SIZE_RE)) {
        const pageNumber = Number.parseInt(match[1] ?? '', 10);
        const widthPoints = Number.parseFloat(match[2] ?? '');
        const heightPoints = Number.parseFloat(match[3] ?? '');
        if (
            !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > pageCount
            || !Number.isFinite(widthPoints)
            || !Number.isFinite(heightPoints)
            || widthPoints <= 0
            || heightPoints <= 0
        ) {
            continue;
        }
        const media = boxes.get(pageNumber)?.media;
        const crop = boxes.get(pageNumber)?.crop;
        sizes.set(pageNumber, {
            pageNumber,
            xPoints: crop?.xPoints ?? 0,
            yPoints: crop?.yPoints ?? 0,
            widthPoints,
            heightPoints,
            rotation: rotations.get(pageNumber) ?? 0,
            ...(crop === undefined
                ? {}
                : {
                    cropXPoints: crop.xPoints,
                    cropYPoints: crop.yPoints,
                    cropWidthPoints: crop.widthPoints,
                    cropHeightPoints: crop.heightPoints,
                }),
            ...(media === undefined
                ? {}
                : {
                    mediaXPoints: media.xPoints,
                    mediaYPoints: media.yPoints,
                    mediaWidthPoints: media.widthPoints,
                    mediaHeightPoints: media.heightPoints,
                }),
        });
    }
    return Array.from({length: pageCount}, (_, index) => {
        const pageSize = sizes.get(index + 1);
        // A document canvas is the largest rectangle the document carries, so a
        // page whose geometry is missing is not a page to guess at: it could be
        // the one that decides the answer.
        if (!pageSize) throw new Error(`pdfinfo returned no geometry for page ${String(index + 1)}`);
        return pageSize;
    });
}

async function readPdfInfoBoxes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
    binary: string,
    pageCount: number,
) {
    const result = await options.runCommand(binary, [
        '-f',
        '1',
        '-l',
        String(pageCount),
        '-box',
        pdfPath,
    ], {
        timeoutMs: PAGE_SIZES_TIMEOUT_MS,
        commandLabel: 'pdfinfo(page-boxes)',
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES + pageCount * 1024,
        rejectOnStdoutTruncation: true,
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.log ? {log: options.log} : {}),
    });
    return result.stdout;
}

async function readWithPageOps(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const runCommand = options.runCommand;
    const outputPath = join(
        options.tempDir,
        `page-sizes-${String(process.pid)}-${String(Date.now())}.json`,
    );
    try {
        await runCommand(binary, [
            'page-sizes',
            '--input',
            pdfPath,
            '--output',
            outputPath,
        ], {
            timeoutMs: PAGE_SIZES_TIMEOUT_MS,
            commandLabel: 'evb-pdf-page-ops(page-sizes)',
            ...(options.signal ? {signal: options.signal} : {}),
            ...(options.log ? {log: options.log} : {}),
        });
        const pageSizes = parsePdfPageSizesPayload(JSON.parse(await readFile(outputPath, 'utf8')));
        if (options.pdfinfoBinary === undefined) {
            return pageSizes;
        }
        try {
            const pageInfo = await readPdfInfoBoxes(pdfPath, options, options.pdfinfoBinary, pageSizes.length);
            const attached = attachMediaBoxes(pageSizes, pageInfo).map(toCropBoxPageSize);
            return options.resolveSuspiciousCropBoxFallback === false
                ? attached
                : resolveSuspiciousCropBoxPageSizes(attached);
        } catch (error) {
            if (options.signal?.aborted) throw error;
            options.log?.(
                'warn',
                `pdfinfo could not expose MediaBox geometry for suspicious CropBox recovery; retaining page-ops geometry: ${getErrorMessage(error)}`,
            );
            return pageSizes;
        }
    } finally {
        await rm(outputPath, {force: true}).catch(() => undefined);
    }
}

async function readWithPdfInfo(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const runCommand = options.runCommand;
    const commandOptions = {
        timeoutMs: PAGE_SIZES_TIMEOUT_MS,
        commandLabel: 'pdfinfo(page-sizes)',
        ...(options.signal ? {signal: options.signal} : {}),
        ...(options.log ? {log: options.log} : {}),
    };
    const overview = await runCommand(binary, [pdfPath], {
        ...commandOptions,
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES,
    });
    const pageCount = Number.parseInt(PDFINFO_PAGE_COUNT_RE.exec(overview.stdout)?.[1] ?? '', 10);
    if (!Number.isSafeInteger(pageCount) || pageCount < 1) {
        throw new Error('pdfinfo returned no page count');
    }
    const detailed = await runCommand(binary, [
        '-f',
        '1',
        '-l',
        String(pageCount),
        '-box',
        pdfPath,
    ], {
        ...commandOptions,
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES + pageCount * 1024,
        rejectOnStdoutTruncation: true,
    });
    const pageSizes = parsePdfInfoPageGeometry(detailed.stdout);
    return options.resolveSuspiciousCropBoxFallback === false
        ? pageSizes
        : resolveSuspiciousCropBoxPageSizes(pageSizes);
}

/**
 * The paper rectangle of every page. It is document metadata rather than
 * content, so it costs one fast process on a scan of any size and answers
 * before a page has been rendered — and preview and final run never disagree
 * about the geometry, because they read it through the same order of tools.
 *
 * evb-pdf-page-ops answers first: it is the tool the lossless assembler writes
 * these boxes back with, so a run that has it measures and writes the same
 * rectangle. Poppler answers when it is missing or disabled, which keeps
 * matched page size — a default setting — working on an installation that
 * carries no page-ops rather than failing the feature over geometry every PDF
 * tool can report.
 */
export async function readPdfPageSizes(
    pdfPath: string,
    options: IReadPdfPageSizesOptions,
) {
    if (options.pdfPageOpsBinary) {
        try {
            return await readWithPageOps(pdfPath, options, options.pdfPageOpsBinary);
        } catch (error) {
            if (options.signal?.aborted || !options.pdfinfoBinary) throw error;
            options.log?.(
                'warn',
                `evb-pdf-page-ops could not report page geometry, falling back to pdfinfo: ${getErrorMessage(error)}`,
            );
        }
    }
    if (options.pdfinfoBinary) {
        return readWithPdfInfo(pdfPath, options, options.pdfinfoBinary);
    }
    throw new Error('No PDF tool is available to read page geometry');
}
