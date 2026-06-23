import type { TDocumentRef } from '@contracts/documentRef';
import type { IOcrIndexV2Manifest } from '@contracts/ocrIndex';
import { BrowserLogger } from '@app/utils/browserLogger';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import {
    readOptionalAdjacentJsonArtifact,
    readOptionalOcrArtifactJson,
} from '@app/utils/platformOcrArtifacts';

type TOcrManifestIndex = Pick<IOcrIndexV2Manifest, 'pages'>;

interface IOcrPageTextEntry { text?: string; }

interface ILegacyOcrIndex { pages?: IOcrPageTextEntry[]; }

export async function loadOcrText(workingCopyPath: TDocumentRef) {
    try {
        const manifest = await readOptionalOcrArtifactJson<TOcrManifestIndex>(workingCopyPath, 'manifest.json');
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
