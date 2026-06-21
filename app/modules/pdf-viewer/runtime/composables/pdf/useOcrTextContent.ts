import type { PageViewport } from 'pdfjs-dist';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPdfRawDims } from '@app/types/pdf';
import type { IOcrWord } from '@contracts/shared';
import {
    buildOcrTextLayerItemText,
    isLastOcrWordInLine,
} from '@contracts/ocrText';
import { BrowserLogger } from '@app/utils/browserLogger';
import type {
    IOcrManifest,
    IOcrPageData,
} from '@app/modules/pdf-viewer/engine/ocr-text-content-cache/ocrTextContentCacheTypes';
import { sharedOcrTextContentCache } from '@app/modules/pdf-viewer/engine/ocr-text-content-cache/sharedOcrTextContentCache';
import { readOptionalOcrArtifactJson } from '@app/utils/platformOcrArtifacts';

const RTL_OCR_LANGUAGES: ReadonlySet<string> = new Set([
    'ara',
    'heb',
    'syr',
] as const);
type TOcrTextDirection = 'ltr' | 'rtl';
const SERVER_ASCENT_RATIO_FALLBACK = 0.8;

function normalizeWordsToLineHeights(words: IOcrWord[]): IOcrWord[] {
    const normalizedWords = words.map(word => ({ ...word }));
    if (normalizedWords.length <= 1) {
        return normalizedWords;
    }

    let lineStartIndex = 0;

    function areWordsOnSameVisualLine(currentWord: IOcrWord, nextWord: IOcrWord) {
        const currentCenter = currentWord.y + currentWord.height / 2;
        const nextCenter = nextWord.y + nextWord.height / 2;
        const maxHeight = Math.max(currentWord.height, nextWord.height);

        return Math.abs(nextCenter - currentCenter) <= maxHeight * 0.5;
    }

    function applyLineBox(lineEndIndex: number) {
        if (lineEndIndex <= lineStartIndex) {
            return;
        }

        const lineWords = normalizedWords.slice(lineStartIndex, lineEndIndex + 1);
        const lineTop = Math.min(...lineWords.map(word => word.y));
        const lineBottom = Math.max(...lineWords.map(word => word.y + word.height));
        const lineHeight = lineBottom - lineTop;

        if (!Number.isFinite(lineTop) || !Number.isFinite(lineHeight) || lineHeight <= 0) {
            return;
        }

        for (let index = lineStartIndex; index <= lineEndIndex; index += 1) {
            normalizedWords[index]!.y = lineTop;
            normalizedWords[index]!.height = lineHeight;
        }
    }

    for (let index = 0; index < normalizedWords.length - 1; index += 1) {
        if (!areWordsOnSameVisualLine(normalizedWords[index]!, normalizedWords[index + 1]!)) {
            applyLineBox(index);
            lineStartIndex = index + 1;
        }
    }
    applyLineBox(normalizedWords.length - 1);

    return normalizedWords;
}

/**
 * Composable for loading OCR index data and converting it to PDF.js TextContent format.
 *
 * This enables the PDF viewer to use OCR-derived text positioning for text selection
 * and search highlighting, ensuring accurate alignment between visual content and
 * selectable/searchable text.
 */
export const useOcrTextContent = () => {
    let cachedAscentRatio: number | null = null;

    /**
     * Computes the font ascent ratio for baseline alignment.
     * Uses canvas text metrics to determine what percentage of the font
     * height is above the baseline (the ascent).
     */
    function getAscentRatio() {
        if (cachedAscentRatio !== null) {
            return cachedAscentRatio;
        }

        if (typeof document === 'undefined') {
            return SERVER_ASCENT_RATIO_FALLBACK;
        }

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return SERVER_ASCENT_RATIO_FALLBACK;
        }

        ctx.font = '100px sans-serif';
        const metrics = ctx.measureText('x');
        const ascent = metrics.actualBoundingBoxAscent ?? 80;
        const descent = metrics.actualBoundingBoxDescent ?? 20;
        cachedAscentRatio = ascent / (ascent + descent);
        return cachedAscentRatio;
    }

    /**
     * Loads and caches the OCR manifest for a working copy path.
     */
    async function loadManifest(workingCopyPath: TDocumentRef): Promise<IOcrManifest | null> {
        const cachedManifest = sharedOcrTextContentCache.getManifest(workingCopyPath);
        if (cachedManifest !== undefined) {
            return cachedManifest;
        }

        try {
            const manifest = await readOptionalOcrArtifactJson<IOcrManifest>(workingCopyPath, 'manifest.json');
            if (!manifest) {
                sharedOcrTextContentCache.setManifest(workingCopyPath, null);
                return null;
            }
            sharedOcrTextContentCache.setManifest(workingCopyPath, manifest);
            return manifest;
        } catch (err) {
            BrowserLogger.warn('ocr', 'Failed to load manifest', err);
            sharedOcrTextContentCache.setManifest(workingCopyPath, null);
            return null;
        }
    }

    /**
     * Loads and caches per-page OCR data.
     */
    async function loadPageData(
        workingCopyPath: TDocumentRef,
        pageNumber: number,
        manifest: IOcrManifest,
    ): Promise<IOcrPageData | null> {
        const cachedPageData = sharedOcrTextContentCache.getPageData(workingCopyPath, pageNumber);
        if (cachedPageData !== undefined) {
            return cachedPageData;
        }

        const pageMapping = manifest.pages[pageNumber];
        if (!pageMapping) {
            return null;
        }

        try {
            const pageData = await readOptionalOcrArtifactJson<IOcrPageData>(workingCopyPath, pageMapping.path);
            if (!pageData) {
                throw new Error(`Invalid OCR page payload for page ${pageNumber}`);
            }
            sharedOcrTextContentCache.setPageData(workingCopyPath, pageNumber, pageData);
            return pageData;
        } catch (err) {
            BrowserLogger.warn('ocr', `Failed to load page ${pageNumber}`, err);
            return null;
        }
    }

    /**
     * Transforms an OCR word (in pixel coordinates) to a PDF.js TextItem
     * for use in the TextLayer.
     *
     * Coordinate conversion:
     * - OCR words are in raster pixel coordinates (origin at top-left, y increases downward)
     * - PDF user space has origin at bottom-left, y increases upward
     * - We scale from pixel coords to PDF user space using the image dimensions and viewport
     *
     * Baseline alignment:
     * - PDF.js TextLayer positions text spans using baseline coordinates
     * - We compute the baseline Y position using the font ascent ratio
     */
    function transformWordToTextItem(
        word: IOcrWord,
        ocrPage: IOcrPageData,
        viewport: PageViewport,
        isLastInLine: boolean,
        textDir: TOcrTextDirection,
        ascentRatio: number,
    ) {
        const { render } = ocrPage;

        // Get raw page dimensions from viewport
        // PDF.js viewport includes a rawDims property with the original page size
        const rawDims = (viewport.rawDims as IPdfRawDims | undefined) ?? {
            pageWidth: viewport.width / viewport.scale,
            pageHeight: viewport.height / viewport.scale,
        };

        // Scale from OCR pixels to PDF user space
        const sx = rawDims.pageWidth / render.imagePx.w;
        const sy = rawDims.pageHeight / render.imagePx.h;

        // Transform coordinates
        // OCR word: x, y are top-left corner in pixel coords (y down)
        // PDF user space: origin at bottom-left, y up
        const pdfX = word.x * sx;
        const pdfW = word.width * sx;
        const pdfH = word.height * sy;

        // Flip Y: pageHeight - (top + height) gives us the bottom Y in PDF coords
        // Then we add height to get the top Y in PDF coords
        const pdfBottomY = rawDims.pageHeight - (word.y + word.height) * sy;

        // Compute baseline Y for PDF.js TextLayer alignment
        // baselineY should place the text so that the top of the glyph box aligns
        // with the OCR word's top position
        // boxTopY = pdfBottomY + pdfH
        // baseline = boxTopY - fontAscent = pdfBottomY + pdfH - (pdfH * ascentRatio)
        //          = pdfBottomY + pdfH * (1 - ascentRatio)
        const baselineY = pdfBottomY + pdfH * (1 - ascentRatio);

        // Transform matrix: [scaleX, skewX, skewY, scaleY, translateX, translateY]
        // For horizontal text, scaleX and scaleY are the font size
        // PDF.js uses transform[0] and transform[3] to compute font height
        return {
            str: buildOcrTextLayerItemText(word),
            dir: textDir,
            transform: [
                pdfH,
                0,
                0,
                pdfH,
                pdfX,
                baselineY,
            ],
            width: pdfW,
            height: pdfH,
            fontName: 'ocr-sans',
            hasEOL: isLastInLine,
        };
    }

    /**
     * Gets OCR-derived TextContent for a page, suitable for PDF.js TextLayer.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @param pageNumber - 1-based page number
     * @param viewport - PDF.js viewport for coordinate transformation
     * @returns TextContent object or null if no OCR data available
     */
    async function getOcrTextContent(
        workingCopyPath: TDocumentRef,
        pageNumber: number,
        viewport: PageViewport,
    ) {
        const manifest = await loadManifest(workingCopyPath);
        if (!manifest || manifest.version < 2) {
            return null;
        }

        const isRtl = manifest.ocr.languages.some(lang => RTL_OCR_LANGUAGES.has(lang));
        const textDir: TOcrTextDirection = isRtl ? 'rtl' : 'ltr';

        const pageData = await loadPageData(workingCopyPath, pageNumber, manifest);
        if (!pageData || !pageData.words || pageData.words.length === 0) {
            return null;
        }

        const ascentRatio = getAscentRatio();

        const words = normalizeWordsToLineHeights(pageData.words);

        // Convert OCR words to TextItems
        const items = words.map((word, idx) =>
            transformWordToTextItem(
                word,
                pageData,
                viewport,
                isLastOcrWordInLine(words, idx),
                textDir,
                ascentRatio,
            ),
        );

        return {
            items,
            styles: {'ocr-sans': {
                fontFamily: 'sans-serif',
                ascent: ascentRatio,
                descent: 1 - ascentRatio,
                vertical: false,
            }},
            lang: manifest.ocr.languages[0] ?? null,
        };
    }

    /**
     * Checks if OCR data is available for a document.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @returns True if OCR manifest exists and is version 2+
     */
    async function hasOcrData(workingCopyPath: TDocumentRef) {
        const manifest = await loadManifest(workingCopyPath);
        return manifest !== null && manifest.version >= 2;
    }

    /**
     * Checks if a specific page has OCR data.
     *
     * @param workingCopyPath - Path to the PDF working copy
     * @param pageNumber - 1-based page number
     * @returns True if the page is in the OCR manifest
     */
    async function hasPageOcrData(
        workingCopyPath: TDocumentRef,
        pageNumber: number,
    ) {
        const manifest = await loadManifest(workingCopyPath);
        if (!manifest || manifest.version < 2) {
            return false;
        }
        return pageNumber in manifest.pages;
    }

    /**
     * Clears cached OCR data for a working copy path or all cached data.
     *
     * @param workingCopyPath - Optional path to clear; clears all if omitted
     */
    function clearCache(workingCopyPath?: TDocumentRef) {
        sharedOcrTextContentCache.clearCache(workingCopyPath);
    }

    return {
        getOcrTextContent,
        loadManifest,
        hasOcrData,
        hasPageOcrData,
        clearCache,
    };
};
