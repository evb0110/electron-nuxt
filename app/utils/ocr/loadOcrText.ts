import type { TDocumentRef } from '@contracts/documentRef';
import { isRecord } from '@contracts/runtimeGuards';
import { BrowserLogger } from '@app/utils/browserLogger';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import {
    readOptionalAdjacentJsonArtifact,
    readOptionalOcrArtifactJson,
} from '@app/utils/platformOcrArtifacts';

interface IOcrManifestIndex {
    version: 3;
    documentRevision: { token: string };
    pages?: Record<string, { path: string }>;
}

interface IOcrPageTextEntry {
    documentRevision?: { token: string };
    text?: string;
}

interface ISearchTextIndex {
    schemaVersion: 7;
    documentRevision: { token: string };
    pages?: IOcrPageTextEntry[];
}

function isOcrPageTextEntry(value: unknown): value is IOcrPageTextEntry {
    return isRecord(value) && (value.text === undefined || typeof value.text === 'string');
}

function isOcrManifestIndex(value: unknown): value is IOcrManifestIndex {
    return isRecord(value)
        && value.version === 3
        && isRecord(value.documentRevision)
        && typeof value.documentRevision.token === 'string'
        && value.documentRevision.token.length > 0
        && (
            value.pages === undefined
            || (
                isRecord(value.pages)
                && Object.values(value.pages).every(entry => isRecord(entry) && typeof entry.path === 'string')
            )
        );
}

function isSearchTextIndex(value: unknown): value is ISearchTextIndex {
    return isRecord(value)
        && value.schemaVersion === 7
        && isRecord(value.documentRevision)
        && typeof value.documentRevision.token === 'string'
        && value.documentRevision.token.length > 0
        && (
            value.pages === undefined
            || (Array.isArray(value.pages) && value.pages.every(isOcrPageTextEntry))
        );
}

export async function loadOcrText(
    workingCopyPath: TDocumentRef,
    documentRevisionToken: string,
) {
    try {
        const manifest = await readOptionalOcrArtifactJson(workingCopyPath, 'manifest.json', isOcrManifestIndex);
        if (manifest && manifest.documentRevision.token === documentRevisionToken) {

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
                const pageData = await readOptionalOcrArtifactJson(workingCopyPath, entry.path, isOcrPageTextEntry);
                if (pageData?.documentRevision?.token === documentRevisionToken && pageData.text) {
                    texts.push(pageData.text.trim());
                }

                if (index > 0 && index % 8 === 0) {
                    await yieldToBrowser();
                }
            }

            const merged = texts.filter(Boolean).join('\n\n');
            return merged.length > 0 ? merged : null;
        }

        const index = await readOptionalAdjacentJsonArtifact(workingCopyPath, '.index.json', isSearchTextIndex);
        if (!index || index.documentRevision.token !== documentRevisionToken) {
            return null;
        }

        const legacyTexts: string[] = [];
        const legacyPages = index.pages ?? [];
        for (let pageIndex = 0; pageIndex < legacyPages.length; pageIndex += 1) {
            const page = legacyPages[pageIndex];
            const text = page?.text?.trim();
            if (text) {
                legacyTexts.push(text);
            }

            if (pageIndex > 0 && pageIndex % 8 === 0) {
                await yieldToBrowser();
            }
        }

        const merged = legacyTexts.join('\n\n');
        return merged.length > 0 ? merged : null;
    } catch (e) {
        BrowserLogger.warn('ocr', 'Failed to load OCR text for DOCX export', e);
        return null;
    }
}
