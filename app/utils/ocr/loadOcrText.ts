import type { TDocumentRef } from '@contracts/documentRef';
import { BrowserLogger } from '@app/utils/browserLogger';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import {
    readOptionalAdjacentJsonArtifact,
    readOptionalOcrArtifactJson,
} from '@app/utils/platformOcrArtifacts';

interface IOcrManifestIndex { pages: Record<number, { path: string }>; }

interface IOcrPageTextEntry { text?: string; }

interface ILegacyOcrIndex { pages?: IOcrPageTextEntry[]; }

export async function loadOcrText(workingCopyPath: TDocumentRef) {
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
