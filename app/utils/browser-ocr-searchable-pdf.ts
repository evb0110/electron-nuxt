import fontkit from '@pdf-lib/fontkit';
import {
    PDFDocument,
    rgb,
} from 'pdf-lib';
import { getViewerAssetResolver } from '@app/utils/viewer-assets';

const DEFAULT_BROWSER_OCR_FONT_FILE = 'LiberationSans-Regular.ttf';
const MIN_BROWSER_OCR_FONT_SIZE = 1;
const DEFAULT_FONT_HEIGHT_RATIO = 0.85;
const WORD_WIDTH_PADDING_RATIO = 0.98;

export interface IBrowserOcrSearchablePdfWord {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface IBrowserOcrSearchablePdfPageData {
    text: string;
    words: IBrowserOcrSearchablePdfWord[];
    imageWidth: number;
    imageHeight: number;
}

let cachedBrowserOcrFontPromise: Promise<Uint8Array> | null = null;

function normalizeWordText(text: string) {
    return text.replace(/\s+/g, ' ').trim();
}

async function loadDefaultBrowserOcrFontData() {
    if (!cachedBrowserOcrFontPromise) {
        cachedBrowserOcrFontPromise = (async () => {
            const fontUrl = getViewerAssetResolver().standardFontUrl(DEFAULT_BROWSER_OCR_FONT_FILE);
            const response = await fetch(fontUrl);
            if (!response.ok) {
                throw new Error(`Failed to load browser OCR font (${response.status})`);
            }

            return new Uint8Array(await response.arrayBuffer());
        })();
    }

    return cachedBrowserOcrFontPromise;
}

function resolveWordFontSize(
    font: Awaited<ReturnType<PDFDocument['embedFont']>>,
    text: string,
    boxWidth: number,
    boxHeight: number,
) {
    const normalizedText = normalizeWordText(text);
    if (!normalizedText || boxWidth <= 0 || boxHeight <= 0) {
        return null;
    }

    const estimatedSize = Math.max(MIN_BROWSER_OCR_FONT_SIZE, boxHeight * DEFAULT_FONT_HEIGHT_RATIO);
    const renderedWidth = font.widthOfTextAtSize(normalizedText, estimatedSize);
    if (!Number.isFinite(renderedWidth) || renderedWidth <= 0) {
        return estimatedSize;
    }

    const fittedSize = estimatedSize * Math.min(1, (boxWidth * WORD_WIDTH_PADDING_RATIO) / renderedWidth);
    return Math.max(MIN_BROWSER_OCR_FONT_SIZE, fittedSize);
}

export async function createBrowserSearchablePdf(options: {
    sourcePdfData: Uint8Array;
    pageData: Record<number, IBrowserOcrSearchablePdfPageData>;
    fontData?: Uint8Array;
}) {
    const pdfDocument = await PDFDocument.load(options.sourcePdfData, { updateMetadata: false });
    pdfDocument.registerFontkit(fontkit);

    const font = await pdfDocument.embedFont(
        options.fontData ?? await loadDefaultBrowserOcrFontData(),
        { subset: true },
    );

    const pageEntries = Object.entries(options.pageData)
        .map(([
            pageKey,
            value,
        ]) => [
            Number(pageKey),
            value,
        ] as const)
        .filter(([
            pageNumber,
            value,
        ]) =>
            Number.isFinite(pageNumber)
            && pageNumber > 0
            && value.imageWidth > 0
            && value.imageHeight > 0,
        );

    for (const [
        pageNumber,
        pageOcrData,
    ] of pageEntries) {
        const page = pdfDocument.getPage(pageNumber - 1);
        if (!page) {
            continue;
        }

        const {
            width: pageWidth,
            height: pageHeight,
        } = page.getSize();
        const scaleX = pageWidth / pageOcrData.imageWidth;
        const scaleY = pageHeight / pageOcrData.imageHeight;

        for (const word of pageOcrData.words) {
            const normalizedText = normalizeWordText(word.text);
            if (!normalizedText || word.width <= 0 || word.height <= 0) {
                continue;
            }

            const x = Math.max(0, word.x * scaleX);
            const y = Math.max(0, pageHeight - ((word.y + word.height) * scaleY));
            const width = Math.max(0, word.width * scaleX);
            const height = Math.max(0, word.height * scaleY);
            const size = resolveWordFontSize(font, normalizedText, width, height);
            if (!size) {
                continue;
            }

            try {
                page.drawText(normalizedText, {
                    x,
                    y,
                    size,
                    font,
                    color: rgb(0, 0, 0),
                    opacity: 0,
                });
            } catch {
                // Skip words the embedded font cannot represent.
            }
        }
    }

    return pdfDocument.save();
}
