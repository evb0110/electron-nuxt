import { PDFDocument } from 'pdf-lib';
import type { TPdfViewMode } from '@contracts/shared';
import type { IPdfPageMetric } from '@app/types/pdf';

export type TPrintOrientation = 'auto' | 'portrait' | 'landscape';

interface IPrintEmbeddedPage {
    pageNumber: number;
    width: number;
    height: number;
    embeddedPage: Awaited<ReturnType<PDFDocument['embedPdf']>>[number];
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

interface IConservativeSinglePagePrintArea {
    width: number;
    height: number;
}

const SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD = 0.97;
const SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD = 0.1;
const SINGLE_PAGE_PRINT_SAFE_MARGIN_PT = 18;
const BROWSER_PRINT_RENDER_SCALE = 2;
const PDFJS_PRINT_WORKER_SRC = '/pdf/pdf.worker.min.mjs';
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
    createElement(tag: 'section' | 'canvas'): IBrowserPrintPageContainer | IBrowserPrintCanvas;
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
            min-height: 100%;
            background: #ffffff;
        }

        body {
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        ${BROWSER_PRINT_ROOT_SELECTOR} {
            width: 100%;
        }

        .browser-print-page {
            break-after: page;
            page-break-after: always;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            width: 100%;
            background: #ffffff;
        }

        .browser-print-page:last-child {
            break-after: auto;
            page-break-after: auto;
        }

        .browser-print-page canvas {
            display: block;
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

    if (globalWorkerOptions.workerSrc !== PDFJS_PRINT_WORKER_SRC) {
        globalWorkerOptions.workerSrc = PDFJS_PRINT_WORKER_SRC;
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
    return targetDocument.createElement('canvas') as IBrowserPrintCanvas;
}

export async function renderPdfPagesForBrowserPrint(
    targetDocument: IBrowserPrintDocument,
    printablePdf: Blob | Uint8Array,
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
    });
    const pdfDocument = await loadingTask.promise;

    try {
        for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
            const page = await pdfDocument.getPage(pageNumber);

            try {
                const displayViewport = page.getViewport({ scale: 1 });
                const renderViewport = page.getViewport({ scale: BROWSER_PRINT_RENDER_SCALE });
                const pageContainer = createBrowserPrintPageContainer(targetDocument);
                pageContainer.className = 'browser-print-page';
                pageContainer.style.width = `${displayViewport.width}px`;
                pageContainer.style.minHeight = `${displayViewport.height}px`;

                const canvas = createBrowserPrintCanvas(targetDocument);
                canvas.width = Math.max(1, Math.ceil(renderViewport.width));
                canvas.height = Math.max(1, Math.ceil(renderViewport.height));
                canvas.style.width = `${displayViewport.width}px`;
                canvas.style.height = `${displayViewport.height}px`;

                const context = canvas.getContext('2d', { alpha: false });
                if (!context) {
                    throw new Error('Failed to create browser print canvas');
                }

                await page.render({
                    canvas: context.canvas,
                    canvasContext: context,
                    viewport: renderViewport,
                }).promise;

                pageContainer.append(canvas);
                root.append(pageContainer);
            } finally {
                if (typeof page.cleanup === 'function') {
                    page.cleanup();
                }
            }
        }
    } finally {
        await pdfDocument.destroy();
        await loadingTask.destroy();
    }
}

function normalizeTotalPages(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

function buildAllPageNumbers(totalPages: number) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
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
    const parts = normalizedInput
        .split(',')
        .map(part => part.trim())
        .filter(Boolean);

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

    return Array.from(pages).sort((left, right) => left - right);
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

    return Array.from(new Set(pageNumbers))
        .filter(page => Number.isInteger(page) && page >= 1 && page <= normalizedTotalPages)
        .sort((left, right) => left - right);
}

export function buildPrintSpreadGroups(
    pageNumbers: number[],
    viewMode: TPdfViewMode,
) {
    const normalizedPages = Array.from(new Set(pageNumbers))
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

function isFullDocumentSelection(pageNumbers: number[], totalPages: number) {
    if (pageNumbers.length !== totalPages) {
        return false;
    }

    return pageNumbers.every((pageNumber, index) => pageNumber === index + 1);
}

function resolveOutputPageSize(
    naturalWidth: number,
    naturalHeight: number,
    orientation: TPrintOrientation,
) {
    let pageWidth = Math.max(1, naturalWidth);
    let pageHeight = Math.max(1, naturalHeight);

    if (orientation === 'portrait' && pageWidth > pageHeight) {
        [
            pageWidth,
            pageHeight,
        ] = [
            pageHeight,
            pageWidth,
        ];
    } else if (orientation === 'landscape' && pageHeight > pageWidth) {
        [
            pageWidth,
            pageHeight,
        ] = [
            pageHeight,
            pageWidth,
        ];
    }

    return {
        pageWidth,
        pageHeight,
    };
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

function resolveConservativeSinglePagePrintArea(
    isLandscape: boolean,
): IConservativeSinglePagePrintArea {
    return STANDARD_SINGLE_PAGE_PRINT_SHEETS.reduce<IConservativeSinglePagePrintArea>((smallestArea, candidate) => {
        const candidateWidth = isLandscape ? candidate.height : candidate.width;
        const candidateHeight = isLandscape ? candidate.width : candidate.height;

        return {
            width: Math.min(smallestArea.width, candidateWidth),
            height: Math.min(smallestArea.height, candidateHeight),
        };
    }, {
        width: Number.POSITIVE_INFINITY,
        height: Number.POSITIVE_INFINITY,
    });
}

async function buildPaperFittedSinglePagePdf(
    targetPdf: PDFDocument,
    sourcePdfData: Uint8Array,
    pageNumbers: number[],
) {
    const embeddedPages = await targetPdf.embedPdf(
        sourcePdfData,
        pageNumbers.map(pageNumber => pageNumber - 1),
    );

    for (let index = 0; index < pageNumbers.length; index += 1) {
        const embeddedPage = embeddedPages[index];
        const pageNumber = pageNumbers[index];
        if (!embeddedPage || typeof pageNumber !== 'number') {
            throw new Error('Unable to prepare printable page');
        }

        const conservativeArea = resolveConservativeSinglePagePrintArea(
            embeddedPage.width > embeddedPage.height,
        );
        const availableWidth = Math.max(
            1,
            conservativeArea.width - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const availableHeight = Math.max(
            1,
            conservativeArea.height - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2,
        );
        const drawScale = Math.min(
            availableWidth / Math.max(1, embeddedPage.width),
            availableHeight / Math.max(1, embeddedPage.height),
        );
        const targetPage = targetPdf.addPage([
            conservativeArea.width,
            conservativeArea.height,
        ]);
        const drawWidth = embeddedPage.width * drawScale;
        const drawHeight = embeddedPage.height * drawScale;
        targetPage.drawPage(embeddedPage, {
            x: (conservativeArea.width - drawWidth) / 2,
            y: (conservativeArea.height - drawHeight) / 2,
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
        } = sourcePage.getSize();
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

    if (options.viewMode === 'single' && options.orientation === 'auto') {
        const shouldNormalizePages = shouldNormalizeSinglePagePdfForPrint(
            sourcePdf,
            normalizedPageNumbers,
        );

        if (!shouldNormalizePages && isFullDocumentSelection(normalizedPageNumbers, totalPages)) {
            return sourcePdfData;
        }

        if (!shouldNormalizePages) {
            const targetPdf = await PDFDocument.create();
            const copiedPages = await targetPdf.copyPages(
                sourcePdf,
                normalizedPageNumbers.map(pageNumber => pageNumber - 1),
            );
            for (const copiedPage of copiedPages) {
                targetPdf.addPage(copiedPage);
            }
            return targetPdf.save();
        }

        const targetPdf = await PDFDocument.create();
        await buildPaperFittedSinglePagePdf(targetPdf, sourcePdfData, normalizedPageNumbers);
        return targetPdf.save();
    }

    const targetPdf = await PDFDocument.create();
    const embeddedPages = await targetPdf.embedPdf(
        sourcePdfData,
        normalizedPageNumbers.map(pageNumber => pageNumber - 1),
    );
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
            embeddedPage,
        });
    }

    const spreadGroups = buildPrintSpreadGroups(normalizedPageNumbers, options.viewMode);
    const spreads = buildSpreadPages(spreadGroups, embeddedPagesByNumber);

    for (const spread of spreads) {
        const naturalWidth = spread.reduce((sum, page) => sum + page.width, 0);
        const naturalHeight = spread.reduce((maxHeight, page) => Math.max(maxHeight, page.height), 0);
        const shouldNormalizeSpreadToPaper = options.viewMode !== 'single';
        const preferredSheet = shouldNormalizeSpreadToPaper
            ? resolvePreferredSinglePagePrintSheet(
                naturalWidth,
                naturalHeight,
                options.orientation,
            )
            : null;
        const normalizedPageSize = shouldNormalizeSpreadToPaper
            ? resolveConservativeSinglePagePrintArea(preferredSheet!.width > preferredSheet!.height)
            : null;
        const outputPageSize = normalizedPageSize
            ? {
                pageWidth: normalizedPageSize.width,
                pageHeight: normalizedPageSize.height,
            }
            : resolveOutputPageSize(
                naturalWidth,
                naturalHeight,
                options.orientation,
            );
        const {
            pageWidth,
            pageHeight,
        } = outputPageSize;
        const targetPage = targetPdf.addPage([
            pageWidth,
            pageHeight,
        ]);
        const availableWidth = shouldNormalizeSpreadToPaper
            ? Math.max(1, pageWidth - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2)
            : pageWidth;
        const availableHeight = shouldNormalizeSpreadToPaper
            ? Math.max(1, pageHeight - SINGLE_PAGE_PRINT_SAFE_MARGIN_PT * 2)
            : pageHeight;
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
