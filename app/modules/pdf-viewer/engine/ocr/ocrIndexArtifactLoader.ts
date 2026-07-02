import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IOcrIndexV2Manifest,
    IOcrIndexV2Page,
} from '@contracts/ocrIndex';
import { isRecord } from '@contracts/runtimeGuards';
import { isOcrWord } from '@contracts/shared';
import { sharedOcrTextContentCache } from '@app/modules/pdf-viewer/engine/ocr-text-content-cache/sharedOcrTextContentCache';
import { readOptionalOcrArtifactJson } from '@app/utils/platformOcrArtifacts';
import { BrowserLogger } from '@app/utils/browserLogger';

const OCR_INDEX_ROTATIONS: ReadonlySet<unknown> = new Set([
    0,
    90,
    180,
    270,
]);

function isOcrIndexV2Manifest(value: unknown): value is IOcrIndexV2Manifest {
    return isRecord(value)
        && value.version === 2
        && typeof value.createdAt === 'number'
        && isRecord(value.source)
        && typeof value.source.pdfPath === 'string'
        && typeof value.pageCount === 'number'
        && value.pageBox === 'crop'
        && isRecord(value.ocr)
        && value.ocr.engine === 'tesseract'
        && Array.isArray(value.ocr.languages)
        && value.ocr.languages.every(language => typeof language === 'string')
        && typeof value.ocr.renderDpi === 'number'
        && isRecord(value.pages)
        && Object.values(value.pages).every(page => isRecord(page) && typeof page.path === 'string');
}

function isOcrIndexV2Page(value: unknown): value is IOcrIndexV2Page {
    return isRecord(value)
        && typeof value.pageNumber === 'number'
        && OCR_INDEX_ROTATIONS.has(value.rotation)
        && isRecord(value.render)
        && typeof value.render.dpi === 'number'
        && isRecord(value.render.imagePx)
        && typeof value.render.imagePx.w === 'number'
        && typeof value.render.imagePx.h === 'number'
        && typeof value.text === 'string'
        && Array.isArray(value.words)
        && value.words.every(isOcrWord);
}

export async function loadCachedOcrManifest(
    workingCopyPath: TDocumentRef,
    logScope = 'ocr',
): Promise<IOcrIndexV2Manifest | null> {
    const cachedManifest = sharedOcrTextContentCache.getManifest(workingCopyPath);
    if (cachedManifest !== undefined) {
        return cachedManifest;
    }

    try {
        const manifest = await readOptionalOcrArtifactJson(workingCopyPath, 'manifest.json', isOcrIndexV2Manifest);
        if (!manifest) {
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
        const pageData = await readOptionalOcrArtifactJson(workingCopyPath, pageMapping.path, isOcrIndexV2Page);
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
