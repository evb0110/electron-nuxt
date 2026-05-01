import type { TDocumentRef } from '@contracts/platform-api';
import { BrowserLogger } from '@app/utils/browser-logger';
import { yieldToBrowser } from '@app/platform/browser-api/browser-yield';
import {
    readOptionalAdjacentJsonArtifact,
    readOptionalOcrArtifactJson,
} from '@app/utils/platform-ocr-artifacts';

interface IOcrManifestIndex {pages: Record<number, { path: string }>;}

interface IOcrPageTextEntry {text?: string;}

interface ILegacyOcrIndex {pages?: IOcrPageTextEntry[];}

interface IPdfTextPageLike {
    getTextContent: () => Promise<IPdfTextContentLike>;
    cleanup?: (resetStats?: boolean) => unknown;
}

interface IPdfTextContentLike { items: unknown[]; }

interface IPdfTextDocumentLike {
    numPages: number;
    getPage: (pageNumber: number) => Promise<IPdfTextPageLike>;
}

export async function loadOcrText(workingCopyPath: TDocumentRef): Promise<string | null> {
    try {
        const manifest = await readOptionalOcrArtifactJson<IOcrManifestIndex>(workingCopyPath, 'manifest.json');
        if (manifest) {

            const pageEntries = Object.entries(manifest.pages ?? {})
                .map(([
                    page,
                    value,
                ]) => ({
                    page: Number(page),
                    path: value.path,
                }))
                .filter((entry) => Number.isFinite(entry.page) && entry.page > 0)
                .sort((a, b) => a.page - b.page);

            const texts: string[] = [];

            for (let index = 0; index < pageEntries.length; index += 1) {
                const entry = pageEntries[index]!;
                const pageData = await readOptionalOcrArtifactJson<IOcrPageTextEntry>(workingCopyPath, entry.path);
                if (pageData?.text) {
                    texts.push(pageData.text.trim());
                }

                if (index > 0 && index % 8 === 0) {
                    await yieldToBrowser();
                }
            }

            const merged = texts.filter(Boolean).join('\n\n');
            return merged.length > 0 ? merged : null;
        }

        const index = await readOptionalAdjacentJsonArtifact<ILegacyOcrIndex>(workingCopyPath, '.index.json');
        if (!index) {
            return null;
        }

        const legacyTexts = (index.pages ?? [])
            .map((page) => page?.text?.trim())
            .filter((text): text is string => Boolean(text));

        const merged = legacyTexts.join('\n\n');
        return merged.length > 0 ? merged : null;
    } catch (e) {
        BrowserLogger.warn('ocr', 'Failed to load OCR text for DOCX export', e);
        return null;
    }
}

export async function extractPdfText(pdfDocument: IPdfTextDocumentLike): Promise<string | null> {
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
