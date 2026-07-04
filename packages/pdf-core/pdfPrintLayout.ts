import { PDFDocument } from 'pdf-lib';
import type {
    PDFEmbeddedPage,
    PDFPage,
    PageBoundingBox,
} from 'pdf-lib';
import { uniq } from 'es-toolkit/array';
import { range } from 'es-toolkit/math';
import type {
    TPdfViewMode,
    TPrintOrientation,
} from '@contracts/shared';
import type { IPdfPageBox } from '@pdf-core/pdfPageBoxes';
import {
    resolvePdfLibCropBox,
    resolvePdfLibMediaBox,
} from '@pdf-core/pdfPageBoxes';

export interface IBuildPrintablePdfDataOptions {
    pageNumbers?: number[];
    viewMode: TPdfViewMode;
    orientation: TPrintOrientation;
}

export interface IPrintablePageMetric {
    width: number;
    height: number;
}

interface IPrintEmbeddedPage {
    pageNumber: number;
    width: number;
    height: number;
    embeddedPage: PDFEmbeddedPage;
}

interface IPreferredSinglePagePrintSheet {
    key: 'a4' | 'letter';
    width: number;
    height: number;
    fitScale: number;
    aspectDelta: number;
}

const SAFE_DIRECT_PRINT_FIT_SCALE_THRESHOLD = 0.97;
const SAFE_DIRECT_PRINT_ASPECT_DELTA_THRESHOLD = 0.1;
const SINGLE_PAGE_PRINT_SAFE_MARGIN_PT = 0;
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

function normalizeTotalPages(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
        return 0;
    }

    return Math.max(0, Math.floor(value));
}

function buildAllPageNumbers(totalPages: number) {
    return range(1, totalPages + 1);
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

function resolvePdfLibPageViewBox(page: PDFPage): IPdfPageBox {
    const mediaBox = resolvePdfLibMediaBox(page);
    return resolvePdfLibCropBox(page, mediaBox) ?? mediaBox;
}

function toPageBoundingBox(box: IPdfPageBox): PageBoundingBox {
    return {
        left: box.x,
        bottom: box.y,
        right: box.x + box.width,
        top: box.y + box.height,
    };
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
    const visibleBoxes = sourcePages.map(resolvePdfLibPageViewBox);
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
        } = resolvePdfLibPageViewBox(sourcePage);
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
    pageMetrics: readonly IPrintablePageMetric[],
    options: Pick<IBuildPrintablePdfDataOptions, 'pageNumbers' | 'viewMode' | 'orientation'>,
) {
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
        const naturalWidth = spread.reduce((total, page) => total + page.width, 0);
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
