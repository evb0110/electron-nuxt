import type { PDFPageProxy } from 'pdfjs-dist';
import { yieldToBrowser } from '@app/platform/browser-api/browserYield';
import { collapseRepeatedPdfSearchPageText } from '@contracts/search';

export async function extractBrowserSearchPageText(page: {
    getTextContent: PDFPageProxy['getTextContent'];
    cleanup?: PDFPageProxy['cleanup'];
}) {
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

    const text = collapseRepeatedPdfSearchPageText(textChunks.join(''));

    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }

    return text;
}
