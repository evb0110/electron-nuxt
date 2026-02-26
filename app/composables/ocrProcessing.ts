import type { PDFDocumentProxy } from 'pdfjs-dist';
import { safeDestr } from 'destr';
import { getElectronAPI } from '@app/utils/electron';
import { BrowserLogger } from '@app/utils/browser-logger';

interface IOcrManifestIndex {pages: Record<number, { path: string }>;}

interface IOcrPageTextEntry {text?: string;}

interface ILegacyOcrIndex {pages?: IOcrPageTextEntry[];}

export async function loadOcrText(workingCopyPath: string): Promise<string | null> {
    try {
        const api = getElectronAPI();
        const manifestPath = `${workingCopyPath}.ocr/manifest.json`;
        const exists = await api.fileExists(manifestPath);
        if (exists) {
            const manifestJson = await api.readTextFile(manifestPath);
            const manifest = safeDestr<IOcrManifestIndex>(manifestJson);

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

            for (const entry of pageEntries) {
                const pagePath = `${workingCopyPath}.ocr/${entry.path}`;
                const pageJson = await api.readTextFile(pagePath);
                const pageData = safeDestr<IOcrPageTextEntry>(pageJson);
                if (pageData?.text) {
                    texts.push(pageData.text.trim());
                }
            }

            const merged = texts.filter(Boolean).join('\n\n');
            return merged.length > 0 ? merged : null;
        }

        const legacyIndexPath = `${workingCopyPath}.index.json`;
        const legacyExists = await api.fileExists(legacyIndexPath);
        if (!legacyExists) {
            return null;
        }

        const indexJson = await api.readTextFile(legacyIndexPath);
        const index = safeDestr<ILegacyOcrIndex>(indexJson);

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

export async function extractPdfText(pdfDocument: PDFDocumentProxy): Promise<string | null> {
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
                .map((item) => (item as { str?: string }).str ?? '')
                .join(' ')
                .replace(/\s+/g, ' ')
                .trim();
            if (text) {
                pages.push(text);
            }
        }

        const merged = pages.join('\n\n');
        return merged.length > 0 ? merged : null;
    } catch (e) {
        BrowserLogger.warn('ocr', 'Failed to extract PDF text for DOCX export', e);
        return null;
    }
}
