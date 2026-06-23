import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
} from '@contracts/ocrIndex';
import { sharedOcrTextContentCache } from '@app/modules/pdf-viewer/engine/ocr-text-content-cache/sharedOcrTextContentCache';
import { readOptionalOcrArtifactJson } from '@app/utils/platformOcrArtifacts';
import { BrowserLogger } from '@app/utils/browserLogger';

export async function loadCachedOcrManifest(
    workingCopyPath: TDocumentRef,
    logScope = 'ocr',
): Promise<IOcrIndexV2Manifest | null> {
    const cachedManifest = sharedOcrTextContentCache.getManifest(workingCopyPath);
    if (cachedManifest !== undefined) {
        return cachedManifest;
    }

    try {
        const manifest = await readOptionalOcrArtifactJson<IOcrIndexV2Manifest>(workingCopyPath, 'manifest.json');
        if (!manifest || manifest.version !== 2) {
            sharedOcrTextContentCache.setManifest(workingCopyPath, null);
            return null;
        }
        sharedOcrTextContentCache.setManifest(workingCopyPath, manifest);
        return manifest;
    } catch (err) {
        BrowserLogger.warn(logScope, 'Failed to load OCR manifest', err);
        sharedOcrTextContentCache.setManifest(workingCopyPath, null);
        return null;
    }
}

export async function loadCachedOcrPageData(
    workingCopyPath: TDocumentRef,
    pageNumber: number,
    manifest: IOcrIndexV2Manifest,
    logScope = 'ocr',
): Promise<IOcrIndexV2Page | null> {
    const cachedPageData = sharedOcrTextContentCache.getPageData(workingCopyPath, pageNumber);
    if (cachedPageData !== undefined) {
        return cachedPageData;
    }

    const pageMapping = manifest.pages[pageNumber];
    if (!pageMapping) {
        return null;
    }

    try {
        const pageData = await readOptionalOcrArtifactJson<IOcrIndexV2Page>(workingCopyPath, pageMapping.path);
        if (!pageData) {
            throw new Error(`Invalid OCR page payload for page ${pageNumber}`);
        }
        sharedOcrTextContentCache.setPageData(workingCopyPath, pageNumber, pageData);
        return pageData;
    } catch (err) {
        BrowserLogger.warn(logScope, `Failed to load OCR page ${pageNumber}`, err);
        return null;
    }
}
