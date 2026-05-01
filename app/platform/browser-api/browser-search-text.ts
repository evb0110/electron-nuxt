import type { PDFPageProxy } from 'pdfjs-dist';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';

export async function extractBrowserSearchPageText(page: {
    getTextContent: PDFPageProxy['getTextContent'];
    cleanup?: PDFPageProxy['cleanup'];
}) {
    const content = await page.getTextContent();
    const textChunks: string[] = [];

    for (let index = 0; index < content.items.length; index += 128) {
        const chunk = content.items.slice(index, index + 128);
        const normalizedChunk = chunk
            .map(item => ('str' in item ? String(item.str ?? '') : ''))
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (normalizedChunk) {
            textChunks.push(normalizedChunk);
        }

        if (index + 128 < content.items.length) {
            await yieldToBrowser();
        }
    }

    const text = textChunks.join(' ').trim();

    try {
        await Promise.resolve(page.cleanup?.());
    } catch {
        // Page cleanup is a best-effort memory hint.
    }

    return text;
}
