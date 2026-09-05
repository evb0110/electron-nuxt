import { BrowserLogger } from '@app/utils/browserLogger';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';

interface IPdfTextPageLike {
    getTextContent: () => Promise<IPdfTextContentLike>;
    cleanup?: (resetStats?: boolean) => unknown;
}

interface IPdfTextContentLike { items: unknown[]; }

interface IPdfTextDocumentLike {
    numPages: number;
    getPage: (pageNumber: number) => Promise<IPdfTextPageLike>;
}

export async function extractPdfText(pdfDocument: IPdfTextDocumentLike) {
    try {
        const pageCount = pdfDocument.numPages ?? 0;
        if (pageCount === 0) {
            return null;
        }

        const pages: string[] = [];
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
            const page = await pdfDocument.getPage(pageNumber);
            const content = await page.getTextContent();
            const text = content.items
                .map((item) => {
                    const textItem = item as { str?: unknown };
                    return typeof textItem.str === 'string' ? textItem.str : '';
                })
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (text) {
                pages.push(text);
            }

            try {
                await Promise.resolve(page.cleanup?.());
            } catch {
                // Page cleanup is a best-effort memory hint.
            }

            if (pageNumber % 2 === 0) {
                await yieldToBrowser();
            }
        }

        const merged = pages.join('\n\n');
        return merged.length > 0 ? merged : null;
    } catch (e) {
        BrowserLogger.warn('ocr', 'Failed to extract PDF text for DOCX export', e);
        return null;
    }
}
