import {
    PDFDocument,
    type PageBoundingBox,
    type PDFEmbeddedPage,
    type PDFPage,
} from 'pdf-lib';
import {
    compact,
    uniq,
} from 'es-toolkit/array';
import {
    range,
    sumBy,
} from 'es-toolkit/math';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfPageMetric } from '@app/types/pdf';
import {
    getPdfjsAssetDir,
    getPdfjsWorkerUrl,
} from '@app/utils/viewerAssets';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from 'pdfjs-dist';

export type TPrintOrientation = 'auto' | 'portrait' | 'landscape';

interface IPrintEmbeddedPage {
    pageNumber: number;
    width: number;
    height: number;
    embeddedPage: PDFEmbeddedPage;
}

interface IBuildPrintablePdfDataOptions {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

interface IPreferredSinglePagePrintSheet {
    key: 'a4' | 'letter';
    width: number;
    height: number;
    fitScale: number;
    aspectDelta: number;
}

interface IPdfPageBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface IRenderPdfPagesForBrowserPrintOptions {signal?: AbortSignal;}

const SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD = 0.97;
const SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD = 0.1;
const SINGLE_PAGE_PRINT_SAFE_MARGIN_PT = 0;
const BROWSER_PRINT_RESOLUTION_DPI = 300;
const PDF_POINTS_PER_INCH = 72;
const BROWSER_PRINT_RENDER_SCALE = BROWSER_PRINT_RESOLUTION_DPI / PDF_POINTS_PER_INCH;
const BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT = 0.5;
const STANDARD_SINGLE_PAGE_PRINT_SHEETS = [
    {
        key: 'a4' as const,
        width: 595.28,
        height: 841.89,
    },
    {
        key: 'letter' as const,
        width: 612,
        height: 792,
    },
] as const;

export const BROWSER_PRINT_ROOT_SELECTOR = '[data-browser-print-root]';

interface IBrowserPrintRoot {
    append: (...nodes: unknown[]) => unknown;
    replaceChildren: (...nodes: unknown[]) => unknown;
}

interface IBrowserPrintPageContainer {
    append: (...nodes: unknown[]) => unknown;
    className: string;
    style: Record<string, string>;
}

interface IBrowserPrintStyleElement {textContent: string;}

interface IBrowserPrintCanvas {
    getContext: (
        contextId: '2d',
        options?: CanvasRenderingContext2DSettings,
    ) => CanvasRenderingContext2D | null;
    height: number;
    style: Record<string, string>;
    width: number;
}

export interface IBrowserPrintDocument {
    querySelector(selector: string): IBrowserPrintRoot | null;
    createElement(tag: 'section' | 'canvas' | 'style'):
        | IBrowserPrintPageContainer
        | IBrowserPrintCanvas
        | IBrowserPrintStyleElement;
}

function createBrowserPrintAbortError() {
    const error = new Error('Print preparation was canceled');
    error.name = 'AbortError';
    return error;
}

function throwIfBrowserPrintAborted(signal: AbortSignal | undefined) {
    if (signal?.aborted) {
        throw createBrowserPrintAbortError();
    }
}

function normalizePdfPageBox(box: IPdfPageBox): IPdfPageBox | null {
    const minX = Math.min(box.x, box.x + box.width);
    const minY = Math.min(box.y, box.y + box.height);
    const maxX = Math.max(box.x, box.x + box.width);
    const maxY = Math.max(box.y, box.y + box.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

function arePdfPageBoxesEqual(left: IPdfPageBox, right: IPdfPageBox) {
    return left.x === right.x
        && left.y === right.y
        && left.width === right.width
        && left.height === right.height;
}

function intersectPdfPageBoxes(left: IPdfPageBox, right: IPdfPageBox) {
    const minX = Math.max(left.x, right.x);
    const minY = Math.max(left.y, right.y);
    const maxX = Math.min(left.x + left.width, right.x + right.width);
    const maxY = Math.min(left.y + left.height, right.y + right.height);
    const width = maxX - minX;
    const height = maxY - minY;

    if (width <= 0 || height <= 0) {
        return null;
    }

    return {
        x: minX,
        y: minY,
        width,
        height,
    };
}

function resolvePdfJsPageViewBox(page: PDFPage): IPdfPageBox {
    const mediaBox = normalizePdfPageBox(page.getMediaBox())
        ?? normalizePdfPageBox({
            x: 0,
            y: 0,
            ...page.getSize(),
        });

    if (!mediaBox) {
        throw new Error('PDF page has an invalid media box');
    }

    const cropBox = normalizePdfPageBox(page.getCropBox());
    if (!cropBox || arePdfPageBoxesEqual(cropBox, mediaBox)) {
        return mediaBox;
    }

    return intersectPdfPageBoxes(cropBox, mediaBox) ?? mediaBox;
}

function toPageBoundingBox(box: IPdfPageBox): PageBoundingBox {
    return {
        left: box.x,
        bottom: box.y,
        right: box.x + box.width,
        top: box.y + box.height,
    };
}

export function buildBrowserPrintFrameMarkup() {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <title>Printable PDF</title>
    <style>
        @page {
            margin: 0;
        }

        html, body {
            margin: 0;
            width: 100%;
            height: 100%;
            background: #ffffff;
        }

        ${BROWSER_PRINT_ROOT_SELECTOR} {
            display: block;
            width: 100%;
        }

        .browser-print-page {
            break-inside: avoid;
            page-break-inside: avoid;
            break-before: page;
            page-break-before: always;
            display: flex;
            align-items: center;
            justify-content: center;
            box-sizing: border-box;
            background: #ffffff;
            overflow: hidden;
            width: 100%;
            height: 100%;
        }

        .browser-print-page:first-child {
            break-before: auto;
            page-break-before: auto;
        }

        .browser-print-page canvas {
            display: block;
            margin: 0 auto;
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            break-inside: avoid;
            page-break-inside: avoid;
        }

        @media print {
            html, body {
                height: 100%;
            }

            ${BROWSER_PRINT_ROOT_SELECTOR} {
                display: block;
                width: 100%;
            }
        }
    </style>
</head>
<body>
    <main data-browser-print-root></main>
</body>
</html>`;
}

async function getPdfjsPrintLib() {
    const pdfjsLib = await import('pdfjs-dist');
    const globalWorkerOptions = pdfjsLib.GlobalWorkerOptions as { workerSrc?: string };
    const workerSrc = getPdfjsWorkerUrl();

    if (globalWorkerOptions.workerSrc !== workerSrc) {
        globalWorkerOptions.workerSrc = workerSrc;
    }

    return pdfjsLib;
}

function clonePdfBytes(data: Uint8Array | ArrayBufferLike) {
    const source = data instanceof Uint8Array ? data : new Uint8Array(data);
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
}

function getBrowserPrintRoot(targetDocument: IBrowserPrintDocument) {
    const root = targetDocument.querySelector(BROWSER_PRINT_ROOT_SELECTOR);
    if (root && typeof root.append === 'function' && typeof root.replaceChildren === 'function') {
        return root;
    }

    throw new Error('Missing browser print root');
}

function createBrowserPrintPageContainer(targetDocument: IBrowserPrintDocument) {
    return targetDocument.createElement('section') as IBrowserPrintPageContainer;
}

function createBrowserPrintCanvas(targetDocument: IBrowserPrintDocument) {
    if (
        typeof document !== 'undefined'
        && document !== targetDocument
        && typeof document.createElement === 'function'
    ) {
        return document.createElement('canvas') as unknown as IBrowserPrintCanvas;
    }

    return targetDocument.createElement('canvas') as IBrowserPrintCanvas;
}

function formatPdfPointSizeAsCssInches(sizeInPoints: number) {
    const sizeInInches = Math.max(1, sizeInPoints) / PDF_POINTS_PER_INCH;
    return `${Number(sizeInInches.toFixed(4))}in`;
}

function formatPdfPointSizeAsCssPoints(sizeInPoints: number) {
    return `${Number(Math.max(1, sizeInPoints).toFixed(2))}pt`;
}

function setBrowserPrintPageSize(
    targetDocument: IBrowserPrintDocument,
    width: number,
    height: number,
) {
    const head = (targetDocument as IBrowserPrintDocument & {head?: { appendChild?: (node: IBrowserPrintStyleElement) => unknown } | null;}).head;
    if (!head || typeof head.appendChild !== 'function') {
        return;
    }

    const style = targetDocument.createElement('style') as IBrowserPrintStyleElement;
    style.textContent = `
        @page {
            size: ${formatPdfPointSizeAsCssPoints(width)} ${formatPdfPointSizeAsCssPoints(height)};
            margin: 0;
        }
    `;
    head.appendChild(style);
}

function assertBrowserPrintPageMatchesFirstPage(
    pageNumber: number,
    width: number,
    height: number,
    firstPageSize: {
        width: number;
        height: number;
    },
) {
    const widthDelta = Math.abs(width - firstPageSize.width);
    const heightDelta = Math.abs(height - firstPageSize.height);

    if (
        widthDelta > BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT
        || heightDelta > BROWSER_PRINT_PAGE_SIZE_TOLERANCE_PT
    ) {
        throw new Error(
            `Browser printing does not support mixed page sizes or orientations. Page ${pageNumber} is ${width.toFixed(2)}x${height.toFixed(2)}pt, but page 1 is ${firstPageSize.width.toFixed(2)}x${firstPageSize.height.toFixed(2)}pt.`,
        );
    }
}

export async function renderPdfPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    printablePdf: Blob | Uint8Array,
    options: IRenderPdfPagesForBrowserPrintOptions = {},
) {
    const root = getBrowserPrintRoot(targetDocument);
    root.replaceChildren();

    const pdfjsLib = await getPdfjsPrintLib();
    const pdfData = printablePdf instanceof Blob
        ? clonePdfBytes(new Uint8Array(await printablePdf.arrayBuffer()))
        : clonePdfBytes(printablePdf);
    const loadingTask = pdfjsLib.getDocument({
        data: pdfData,
        verbosity: pdfjsLib.VerbosityLevel.ERRORS,
        standardFontDataUrl: getPdfjsAssetDir('standard_fonts'),
        cMapUrl: getPdfjsAssetDir('cmaps'),
        cMapPacked: true,
        wasmUrl: getPdfjsAssetDir('wasm'),
        iccUrl: getPdfjsAssetDir('iccs'),
        useSystemFonts: false,
    });
    let pdfDocument: PDFDocumentProxy;
    try {
        throwIfBrowserPrintAborted(options.signal);
        pdfDocument = await loadingTask.promise;
        throwIfBrowserPrintAborted(options.signal);
    } catch (error) {
        await loadingTask.destroy();
        throwIfBrowserPrintAborted(options.signal);
        throw error;
    }

    try {
        await renderPdfPageNumbersForBrowserPrint(
            targetDocument,
            root,
            range(1, pdfDocument.numPages + 1),
            pageNumber => pdfDocument.getPage(pageNumber),
            options,
        );
    } finally {
        await pdfDocument.destroy();
        await loadingTask.destroy();
    }
}

export async function renderPdfDocumentPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    pdfDocument: PDFDocumentProxy,
    pageNumbers: number[],
    options: IRenderPdfPagesForBrowserPrintOptions = {},
) {
    const root = getBrowserPrintRoot(targetDocument);
    root.replaceChildren();
    await renderPdfPageNumbersForBrowserPrint(
        targetDocument,
        root,
        normalizePrintPageNumbers(pageNumbers, pdfDocument.numPages),
        pageNumber => pdfDocument.getPage(pageNumber),
        options,
    );
}

async function renderPdfPageNumbersForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    root: IBrowserPrintRoot,
    pageNumbers: number[],
    getPage: (pageNumber: number) => Promise<PDFPageProxy>,
    options: IRenderPdfPagesForBrowserPrintOptions,
) {
    let firstPageSize: {
        width: number;
        height: number;
    } | null = null;

    for (const pageNumber of pageNumbers) {
        throwIfBrowserPrintAborted(options.signal);
        const page = await getPage(pageNumber);

        try {
            throwIfBrowserPrintAborted(options.signal);
            const displayViewport = page.getViewport({ scale: 1 });
            if (!firstPageSize) {
                firstPageSize = {
                    width: displayViewport.width,
                    height: displayViewport.height,
                };
                setBrowserPrintPageSize(targetDocument, displayViewport.width, displayViewport.height);
            } else {
                assertBrowserPrintPageMatchesFirstPage(
                    pageNumber,
                    displayViewport.width,
                    displayViewport.height,
                    firstPageSize,
                );
            }

            const renderViewport = page.getViewport({ scale: BROWSER_PRINT_RENDER_SCALE });
            const pageContainer = createBrowserPrintPageContainer(targetDocument);
            pageContainer.className = 'browser-print-page';

            const canvas = createBrowserPrintCanvas(targetDocument);
            canvas.width = Math.max(1, Math.ceil(renderViewport.width));
            canvas.height = Math.max(1, Math.ceil(renderViewport.height));
            canvas.style.width = formatPdfPointSizeAsCssInches(displayViewport.width);
            canvas.style.height = formatPdfPointSizeAsCssInches(displayViewport.height);

            const context = canvas.getContext('2d', { alpha: false });
            if (!context) {
                throw new Error('Failed to create browser print canvas');
            }

            const renderTask = page.render({
                canvas: context.canvas,
                canvasContext: context,
                viewport: renderViewport,
            });
            const abortRender = () => renderTask.cancel();
            options.signal?.addEventListener('abort', abortRender, { once: true });
            try {
                throwIfBrowserPrintAborted(options.signal);
                await renderTask.promise;
                throwIfBrowserPrintAborted(options.signal);
            } catch (error) {
                throwIfBrowserPrintAborted(options.signal);
                throw error;
            } finally {
                options.signal?.removeEventListener('abort', abortRender);
            }

            pageContainer.append(canvas);
            root.append(pageContainer);
        } finally {
            if (typeof page.cleanup === 'function') {
                page.cleanup();
            }
        }
    }
}

function normalizeTotalPages(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

function buildAllPageNumbers(totalPages: number) {
    return range(1, totalPages + 1);
}

export function parsePrintPageRangeInput(input: string, totalPages: number): number[] | null {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    if (normalizedTotalPages <= 0) {
        return null;
    }

    const normalizedInput = input
        .trim()
        .replace(/[–—]/g, '-')
        .replace(/\.\./g, '-');

    if (!normalizedInput) {
        return null;
    }

    const pages = new Set<number>();
    const parts = compact(normalizedInput
        .split(',')
        .map(part => part.trim()));

    if (parts.length === 0) {
        return null;
    }

    for (const part of parts) {
        const compactPart = part.replace(/\s+/g, '');
        const match = /^(\d+)(?:-(\d+))?$/.exec(compactPart);
        if (!match) {
            return null;
        }

        const first = Number.parseInt(match[1] ?? '', 10);
        if (!Number.isFinite(first) || first < 1 || first > normalizedTotalPages) {
            return null;
        }

        const secondToken = match[2];
        if (!secondToken) {
            pages.add(first);
            continue;
        }

        const second = Number.parseInt(secondToken, 10);
        if (!Number.isFinite(second) || second < 1 || second > normalizedTotalPages) {
            return null;
        }

        const start = Math.min(first, second);
        const end = Math.max(first, second);
        for (let page = start; page <= end; page += 1) {
            pages.add(page);
        }
    }

    return uniq([...pages]).sort((left, right) => left - right);
}

export function normalizePrintPageNumbers(
    pageNumbers: number[] | undefined,
    totalPages: number,
) {
    const normalizedTotalPages = normalizeTotalPages(totalPages);
    if (normalizedTotalPages <= 0) {
        return [];
    }

    if (!pageNumbers || pageNumbers.length === 0) {
        return buildAllPageNumbers(normalizedTotalPages);
    }

    return uniq(pageNumbers)
        .filter(page => Number.isInteger(page) && page >= 1 && page <= normalizedTotalPages)
        .sort((left, right) => left - right);
}

export function buildPrintSpreadGroups(
    pageNumbers: number[],
    viewMode: TPdfViewMode,
) {
    const normalizedPages = uniq(pageNumbers)
        .filter(page => Number.isInteger(page) && page >= 1)
        .sort((left, right) => left - right);

    if (normalizedPages.length === 0) {
        return [];
    }

    if (viewMode === 'single') {
        return normalizedPages.map(pageNumber => [pageNumber]);
    }

    const groups: number[][] = [];
    let index = 0;

    if (viewMode === 'facing-first-single') {
        groups.push([normalizedPages[0]!]);
        index = 1;
    }

    while (index < normalizedPages.length) {
        const currentPage = normalizedPages[index]!;
        const nextPage = normalizedPages[index + 1];

        if (typeof nextPage === 'number') {
            groups.push([
                currentPage,
                nextPage,
            ]);
            index += 2;
            continue;
        }

        groups.push([currentPage]);
        index += 1;
    }

    return groups;
}

export function canPrintSourcePdfDirectly(
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
    return options.viewMode === 'single'
        && options.orientation === 'auto'
        && (!options.pageNumbers || options.pageNumbers.length === 0);
}

function buildSpreadPages(
    groups: number[][],
    embeddedPagesByNumber: Map<number, IPrintEmbeddedPage>,
) {
    return groups.map(group => group
        .map((pageNumber) => {
            const embeddedPage = embeddedPagesByNumber.get(pageNumber);
            if (!embeddedPage) {
                throw new Error(`Missing printable page ${pageNumber}`);
            }
            return embeddedPage;
        }));
}

function resolvePreferredSinglePagePrintSheet(
    naturalWidth: number,
    naturalHeight: number,
    orientation: TPrintOrientation = 'auto',
): IPreferredSinglePagePrintSheet {
    const isLandscape = orientation === 'landscape'
        ? true
        : orientation === 'portrait'
            ? false
            : naturalWidth > naturalHeight;
    const pageAspect = Math.max(naturalWidth, naturalHeight) / Math.max(1, Math.min(naturalWidth, naturalHeight));

    let bestSheet: IPreferredSinglePagePrintSheet | null = null;

    for (const candidate of STANDARD_SINGLE_PAGE_PRINT_SHEETS) {
        const candidateWidth = isLandscape ? candidate.height : candidate.width;
        const candidateHeight = isLandscape ? candidate.width : candidate.height;
        const fitScale = Math.min(
            candidateWidth / Math.max(1, naturalWidth),
            candidateHeight / Math.max(1, naturalHeight),
        );
        const candidateAspect = Math.max(candidateWidth, candidateHeight) / Math.max(1, Math.min(candidateWidth, candidateHeight));
        const aspectDelta = Math.abs(candidateAspect - pageAspect);

        if (!bestSheet) {
            bestSheet = {
                key: candidate.key,
                width: candidateWidth,
                height: candidateHeight,
                fitScale,
                aspectDelta,
            };
            continue;
        }

        if (
            fitScale > bestSheet.fitScale + 0.0001
            || (
                Math.abs(fitScale - bestSheet.fitScale) <= 0.0001
                && aspectDelta < bestSheet.aspectDelta
            )
        ) {
            bestSheet = {
                key: candidate.key,
                width: candidateWidth,
                height: candidateHeight,
                fitScale,
                aspectDelta,
            };
        }
    }

    if (!bestSheet) {
        throw new Error('Missing standard print sheet');
    }

    return bestSheet;
}

function shouldNormalizeSinglePageForPrint(sheet: IPreferredSinglePagePrintSheet) {
    return sheet.fitScale < SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD
        || sheet.aspectDelta > SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD;
}

function resolveDefaultA4PrintSheet(
    naturalWidth: number,
    naturalHeight: number,
    orientation: TPrintOrientation = 'auto',
) {
    const a4Sheet = STANDARD_SINGLE_PAGE_PRINT_SHEETS[0];
    const isLandscape = orientation === 'landscape'
        ? true
        : orientation === 'portrait'
            ? false
            : naturalWidth > naturalHeight;

    return {
        width: isLandscape ? a4Sheet.height : a4Sheet.width,
        height: isLandscape ? a4Sheet.width : a4Sheet.height,
    };
}

async function embedPrintablePages(
    targetPdf: PDFDocument,
    sourcePdf: PDFDocument,
    pageNumbers: number[],
) {
    const sourcePages = pageNumbers.map(pageNumber => sourcePdf.getPage(pageNumber - 1));
    const visibleBoxes = sourcePages.map(resolvePdfJsPageViewBox);
    const embeddedPages = await targetPdf.embedPages(
        sourcePages,
        visibleBoxes.map(toPageBoundingBox),
    );

    return embeddedPages.map((embeddedPage, index) => {
        const pageNumber = pageNumbers[index];
        if (!pageNumber) {
            throw new Error('Unable to prepare printable page');
        }

        return {
            pageNumber,
            width: visibleBoxes[index]!.width,
            height: visibleBoxes[index]!.height,
            embeddedPage,
        };
    });
}

async function buildPaperFittedSinglePagePdf(
    targetPdf: PDFDocument,
    sourcePdf: PDFDocument,
    pageNumbers: number[],
    orientation: TPrintOrientation,
) {
    const embeddedPages = await embedPrintablePages(targetPdf, sourcePdf, pageNumbers);

    for (let index = 0; index < pageNumbers.length; index += 1) {
        const embeddedPage = embeddedPages[index];
        const pageNumber = pageNumbers[index];
        if (!embeddedPage || typeof pageNumber !== 'number') {
            throw new Error('Unable to prepare printable page');
        }

        const preferredSheet = resolveDefaultA4PrintSheet(
            embeddedPage.width,
            embeddedPage.height,
            orientation,
        );
        const availableWidth = Math.max(
            1,
            preferredSheet.width - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const availableHeight = Math.max(
            1,
            preferredSheet.height - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const drawScale = Math.min(
            availableWidth / Math.max(1, embeddedPage.width),
            availableHeight / Math.max(1, embeddedPage.height),
        );
        const targetPage = targetPdf.addPage([
            preferredSheet.width,
            preferredSheet.height,
        ]);
        const drawWidth = embeddedPage.width * drawScale;
        const drawHeight = embeddedPage.height * drawScale;
        targetPage.drawPage(embeddedPage.embeddedPage, {
            x: (preferredSheet.width - drawWidth) / 2,
            y: (preferredSheet.height - drawHeight) / 2,
            width: drawWidth,
            height: drawHeight,
        });
    }
}

function shouldNormalizeSinglePagePdfForPrint(
    sourcePdf: PDFDocument,
    normalizedPageNumbers: number[],
) {
    return normalizedPageNumbers.some((pageNumber) => {
        const sourcePage = sourcePdf.getPage(pageNumber - 1);
        const {
            width,
            height,
        } = resolvePdfJsPageViewBox(sourcePage);
        return shouldNormalizeSinglePageForPrint(
            resolvePreferredSinglePagePrintSheet(width, height),
        );
    });
}

export async function shouldPrintSourcePdfDirectly(
    sourcePdfData: Uint8Array,
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
    if (!canPrintSourcePdfDirectly(options)) {
        return false;
    }

    const sourcePdf = await PDFDocument.load(sourcePdfData, { updateMetadata: false });
    const normalizedPageNumbers = normalizePrintPageNumbers(options.pageNumbers, sourcePdf.getPageCount());
    if (normalizedPageNumbers.length === 0) {
        return false;
    }

    return !shouldNormalizeSinglePagePdfForPrint(sourcePdf, normalizedPageNumbers);
}

export function shouldPrintPageMetricsDirectly(
    pageMetrics: IPdfPageMetric[],
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
): boolean | null {
    if (!canPrintSourcePdfDirectly(options)) {
        return false;
    }

    if (pageMetrics.length === 0) {
        return null;
    }

    return !pageMetrics.some(metric => shouldNormalizeSinglePageForPrint(
        resolvePreferredSinglePagePrintSheet(metric.width, metric.height),
    ));
}

export async function buildPrintablePdfData(
    sourcePdfData: Uint8Array,
    options: IBuildPrintablePdfDataOptions,
) {
    const sourcePdf = await PDFDocument.load(sourcePdfData, { updateMetadata: false });
    const totalPages = sourcePdf.getPageCount();
    const normalizedPageNumbers = normalizePrintPageNumbers(options.pageNumbers, totalPages);

    if (normalizedPageNumbers.length === 0) {
        return null;
    }

    if (options.viewMode === 'single') {
        const targetPdf = await PDFDocument.create();
        await buildPaperFittedSinglePagePdf(
            targetPdf,
            sourcePdf,
            normalizedPageNumbers,
            options.orientation,
        );
        return targetPdf.save();
    }

    const targetPdf = await PDFDocument.create();
    const embeddedPages = await embedPrintablePages(targetPdf, sourcePdf, normalizedPageNumbers);
    const embeddedPagesByNumber = new Map<number, IPrintEmbeddedPage>();

    for (let index = 0; index < normalizedPageNumbers.length; index += 1) {
        const pageNumber = normalizedPageNumbers[index]!;
        const embeddedPage = embeddedPages[index];
        if (!embeddedPage) {
            throw new Error(`Unable to embed page ${pageNumber} for printing`);
        }

        embeddedPagesByNumber.set(pageNumber, {
            pageNumber,
            width: embeddedPage.width,
            height: embeddedPage.height,
            embeddedPage: embeddedPage.embeddedPage,
        });
    }

    const spreadGroups = buildPrintSpreadGroups(normalizedPageNumbers, options.viewMode);
    const spreads = buildSpreadPages(spreadGroups, embeddedPagesByNumber);

    for (const spread of spreads) {
        const naturalWidth = sumBy(spread, page => page.width);
        const naturalHeight = Math.max(...spread.map(page => page.height));
        const preferredSheet = resolveDefaultA4PrintSheet(
            naturalWidth,
            naturalHeight,
            options.orientation,
        );
        const {
            width: pageWidth,
            height: pageHeight,
        } = preferredSheet;
        const targetPage = targetPdf.addPage([
            pageWidth,
            pageHeight,
        ]);
        const availableWidth = Math.max(1, pageWidth - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2);
        const availableHeight = Math.max(1, pageHeight - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2);
        const scale = Math.min(availableWidth / naturalWidth, availableHeight / naturalHeight);
        const leftInset = (pageWidth - naturalWidth * scale) / 2;
        const topInset = (pageHeight - naturalHeight * scale) / 2;
        let cursorX = leftInset;

        for (const page of spread) {
            const drawWidth = page.width * scale;
            const drawHeight = page.height * scale;
            targetPage.drawPage(page.embeddedPage, {
                x: cursorX,
                y: pageHeight - topInset - drawHeight,
                width: drawWidth,
                height: drawHeight,
            });
            cursorX += drawWidth;
        }
    }

    return targetPdf.save();
}

export function waitForPrintPaint(targetWindow: Window) {
    return new Promise<void>((resolve) => {
        const raf = typeof targetWindow.requestAnimationFrame === 'function'
            ? targetWindow.requestAnimationFrame.bind(targetWindow)
            : null;

        if (!raf) {
            resolve();
            return;
        }

        raf(() => raf(() => resolve()));
    });
}
