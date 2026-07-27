import {
    readFile,
    rm,
} from 'fs/promises';
import { join } from 'path';
import { isRecord } from '@contracts/runtimeGuards';
import { getErrorMessage } from '@contracts/getErrorMessage';
import { runNativeToolCommand } from '@electron/native-tools/runNativeToolCommand';

const PAGE_SIZES_TIMEOUT_MS = 60 * 1000;
const PDFINFO_BASE_STDOUT_BYTES = 256 * 1024;
const PDFINFO_PER_PAGE_STDOUT_BYTES = 512;
const PDFINFO_PAGE_COUNT_RE = /^Pages:\s+(\d+)\s*$/mu;
// `Page 4 size: 595.276 x 841.89 pts (A4)`: the page view Poppler renders with
// `-cropbox`, which is the same rectangle evb-pdf-page-ops reports.
const PDFINFO_PAGE_SIZE_RE = /^Page\s+(\d+)\s+size:\s+([0-9.]+)\s+x\s+([0-9.]+)\s+pts/gmu;
const PDFINFO_PAGE_ROTATION_RE = /^Page\s+(\d+)\s+rot:\s+(-?\d+)\s*$/gmu;

/**
 * The geometry a page carries: the page view (CropBox intersected with
 * MediaBox) in PDF user space, plus the display rotation that view is presented
 * under. It is the same rectangle `split-pages` writes back and the same one
 * `pdftoppm -cropbox` rasterizes, so a canvas measured from it is the canvas the
 * assembled document ends up carrying.
 */
export interface IPdfPageSize {
    pageNumber: number;
    xPoints: number;
    yPoints: number;
    widthPoints: number;
    heightPoints: number;
    rotation: number;
    /**
     * The largest image XObject whose actual placement covers the page view.
     * These are absent for vector/mixed pages and deliberately do not describe
     * same-aspect thumbnails: the native metadata reader verifies placement
     * before exposing them.
     */
    dominantImageWidthPx?: number;
    dominantImageHeightPx?: number;
    dominantImageWidthPoints?: number;
    dominantImageHeightPoints?: number;
}

function decodeFinite(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function parsePdfPageSizesPayload(payload: unknown): IPdfPageSize[] {
    if (!isRecord(payload) || !Array.isArray(payload.pages)) {
        throw new Error('evb-pdf-page-ops page-sizes returned no pages');
    }
    return payload.pages.map((page, index) => {
        if (!isRecord(page)) throw new Error(`evb-pdf-page-ops returned no geometry for page ${String(index + 1)}`);
        const widthPoints = decodeFinite(page.widthPoints);
        const heightPoints = decodeFinite(page.heightPoints);
        const pageNumber = decodeFinite(page.pageNumber) ?? index + 1;
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
        return {
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
        };
    });
}

/**
 * The same geometry read out of `pdfinfo -f 1 -l N`. Poppler reports the page
 * view it would render and the page's own rotation, which is everything a
 * document canvas is measured from — it cannot report the box origin, and
 * nothing that reads this fallback needs one: mapping content back into PDF
 * user space is the lossless assembler's job, and that path already carries
 * evb-pdf-page-ops.
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
        sizes.set(pageNumber, {
            pageNumber,
            xPoints: 0,
            yPoints: 0,
            widthPoints,
            heightPoints,
            rotation: rotations.get(pageNumber) ?? 0,
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

export interface IReadPdfPageSizesOptions {
    log?: (level: 'debug' | 'warn' | 'error', message: string) => void;
    // The callers own these: this module runs inside the scan-cleanup worker
    // thread, where importing an Electron feature to resolve a binary or an
    // app path fails to link. Every caller already holds resolved tool paths
    // and a scratch directory.
    pdfPageOpsBinary?: string | undefined;
    pdfinfoBinary?: string | undefined;
    tempDir: string;
    runCommand?: typeof runNativeToolCommand;
    signal?: AbortSignal;
}

async function readWithPageOps(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const runCommand = options.runCommand ?? runNativeToolCommand;
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
        return parsePdfPageSizesPayload(JSON.parse(await readFile(outputPath, 'utf8')));
    } finally {
        await rm(outputPath, {force: true}).catch(() => undefined);
    }
}

async function readWithPdfInfo(pdfPath: string, options: IReadPdfPageSizesOptions, binary: string) {
    const runCommand = options.runCommand ?? runNativeToolCommand;
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
        pdfPath,
    ], {
        ...commandOptions,
        maxStdoutBytes: PDFINFO_BASE_STDOUT_BYTES + pageCount * PDFINFO_PER_PAGE_STDOUT_BYTES,
        rejectOnStdoutTruncation: true,
    });
    return parsePdfInfoPageGeometry(detailed.stdout);
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
