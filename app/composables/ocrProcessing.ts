import type { PDFDocumentProxy } from 'pdfjs-dist';
import { getElectronAPI } from '@app/utils/electron';
import { BrowserLogger } from '@app/utils/browser-logger';

type TJsonRecord = Record<string, unknown>;

interface IOcrManifestPageEntry {path: string;}

interface IOcrManifestIndex {pages: Record<string, IOcrManifestPageEntry>;}

interface IOcrPageTextEntry {text?: string;}

interface ILegacyOcrIndex {pages?: IOcrPageTextEntry[];}

function isRecord(value: unknown): value is TJsonRecord {
    return typeof value === 'object' && value !== null;
}

function isOcrManifestIndex(value: unknown): value is IOcrManifestIndex {
    if (!isRecord(value) || !isRecord(value.pages)) {
        return false;
    }
    return Object.values(value.pages).every((page) => isRecord(page) && typeof page.path === 'string');
}

function isOcrPageTextEntry(value: unknown): value is IOcrPageTextEntry {
    return isRecord(value) && (typeof value.text === 'string' || typeof value.text === 'undefined');
}

function isLegacyOcrIndex(value: unknown): value is ILegacyOcrIndex {
    if (!isRecord(value)) {
        return false;
    }
    if (typeof value.pages === 'undefined') {
        return true;
    }
    return Array.isArray(value.pages) && value.pages.every(isOcrPageTextEntry);
}

function parseJsonWithGuard<T>(json: string, guard: (value: unknown) => value is T): T | null {
    try {
        const parsed = JSON.parse(json);
        return guard(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getTextContentItemString(item: unknown): string {
    if (!isRecord(item) || typeof item.str !== 'string') {
        return '';
    }
    return item.str;
}

export async function loadOcrText(workingCopyPath: string): Promise<string | null> {
    try {
        const api = getElectronAPI();
        const manifestPath = `${workingCopyPath}.ocr/manifest.json`;
        const exists = await api.fileExists(manifestPath);
        if (exists) {
            const manifestJson = await api.readTextFile(manifestPath);
            const manifest = parseJsonWithGuard(manifestJson, isOcrManifestIndex);
            if (!manifest) {
                return null;
            }

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
                const pageData = parseJsonWithGuard(pageJson, isOcrPageTextEntry);
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
        const index = parseJsonWithGuard(indexJson, isLegacyOcrIndex);
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
                .map(getTextContentItemString)
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
