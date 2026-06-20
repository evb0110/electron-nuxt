import type { PDFPageProxy } from 'pdfjs-dist';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { collapseRepeatedPdfSearchPageText } from '@contracts/search';
import { buildOcrTextLayerIndexText } from '@contracts/ocrText';
import type { IOcrWord } from '@contracts/shared';
import {
    extractPdfjsWordBoxesFromOperatorList,
    getPdfjsPageViewBox,
} from '@pdf-core';
import type { TPdfjsTextOps } from '@pdf-core';

interface IBrowserSearchTextPageLike {
    getTextContent: PDFPageProxy['getTextContent'];
    cleanup?: PDFPageProxy['cleanup'];
}

interface IBrowserSearchGeometryPageLike extends IBrowserSearchTextPageLike {
    getOperatorList?: PDFPageProxy['getOperatorList'];
    view?: unknown;
}

export interface IBrowserSearchPageData {
    text: string;
    words?: IOcrWord[];
    pageWidth?: number;
    pageHeight?: number;
}

async function extractTextContentPageText(page: IBrowserSearchTextPageLike) {
    const content = await page.getTextContent({
        includeMarkedContent: true,
        disableNormalization: true,
    });
    const textChunks: string[] = [];

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        for (const item of chunk) {
            if ('str' in item) {
                textChunks.push(String(item.str ?? ''));
                if (item.hasEOL) {
                    textChunks.push('\n');
                }
            }
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
        }
    }

    return collapseRepeatedPdfSearchPageText(textChunks.join(''));
}

async function cleanupBrowserSearchPage(page: IBrowserSearchTextPageLike) {
    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }
}

export async function extractBrowserSearchPageText(page: IBrowserSearchTextPageLike) {
    const text = await extractTextContentPageText(page);
    await cleanupBrowserSearchPage(page);
    return text;
}

function hasUsableGeometry(page: IBrowserSearchPageData) {
    return Array.isArray(page.words)
        && page.words.length > 0
        && typeof page.pageWidth === 'number'
        && Number.isFinite(page.pageWidth)
        && page.pageWidth > 0
        && typeof page.pageHeight === 'number'
        && Number.isFinite(page.pageHeight)
        && page.pageHeight > 0;
}

export async function extractBrowserSearchPageData(
    page: IBrowserSearchGeometryPageLike,
    pdfjsOps: TPdfjsTextOps,
): Promise<IBrowserSearchPageData> {
    try {
        if (typeof page.getOperatorList === 'function') {
            const pageBox = getPdfjsPageViewBox(page);
            const operatorList = await page.getOperatorList();
            const words = extractPdfjsWordBoxesFromOperatorList(operatorList, pageBox, pdfjsOps);
            const pageData: IBrowserSearchPageData = {
                text: buildOcrTextLayerIndexText(words),
                words,
                pageWidth: pageBox.pageWidth,
                pageHeight: pageBox.pageHeight,
            };
            if (hasUsableGeometry(pageData)) {
                return pageData;
            }
        }

        return {text: await extractTextContentPageText(page)};
    } finally {
        await cleanupBrowserSearchPage(page);
    }
}
