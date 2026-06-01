import { isRecord } from '@contracts/runtimeGuards';
import {
    isOcrWord,
    type IOcrWord,
} from '@contracts/shared';
import {
    OCR_TEXT_LAYER_INDEX_SOURCE,
    OCR_TEXT_LAYER_INDEX_VERSION,
    buildOcrTextLayerIndexText,
} from '@contracts/ocrText';
import { readBrowserOcrArtifactJson } from '@app/platform/browser-api/browserOcrArtifactStore';

export interface IBrowserOcrSearchDocumentText {
    pageCount: number;
    pageTexts: string[];
    textSource: {
        kind: typeof OCR_TEXT_LAYER_INDEX_SOURCE;
        version: typeof OCR_TEXT_LAYER_INDEX_VERSION;
    };
}

interface IBrowserOcrManifest {
    version: number;
    pageCount: number;
    source?: {
        pdfPath?: string;
        contentSignature?: string;
        fileSize?: number;
    };
    pages: Record<number, {path: string}>;
}

interface IBrowserOcrPageData {
    pageNumber: number;
    text: string;
    words?: IOcrWord[];
}

export interface IReadBrowserOcrSearchDocumentTextOptions {
    expectedPageCount?: number;
    contentSignature?: string;
    fileSize?: number;
    shouldContinue?: () => boolean;
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function finiteNumberOrUndefined(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
        ? value
        : undefined;
}

function parseManifest(payload: unknown): IBrowserOcrManifest | null {
    if (!isRecord(payload) || !isRecord(payload.pages)) {
        return null;
    }
    if (
        typeof payload.version !== 'number'
        || payload.version < 2
        || !isPositiveInteger(payload.pageCount)
    ) {
        return null;
    }

    const pages: IBrowserOcrManifest['pages'] = {};
    for (const [
        rawPageNumber,
        rawMapping,
    ] of Object.entries(payload.pages)) {
        const pageNumber = Number.parseInt(rawPageNumber, 10);
        if (
            isPositiveInteger(pageNumber)
            && isRecord(rawMapping)
            && typeof rawMapping.path === 'string'
            && rawMapping.path.length > 0
        ) {
            pages[pageNumber] = { path: rawMapping.path };
        }
    }

    let source: IBrowserOcrManifest['source'];
    if (isRecord(payload.source)) {
        const fileSize = finiteNumberOrUndefined(payload.source.fileSize);
        source = {
            ...(typeof payload.source.pdfPath === 'string' ? { pdfPath: payload.source.pdfPath } : {}),
            ...(typeof payload.source.contentSignature === 'string' ? { contentSignature: payload.source.contentSignature } : {}),
            ...(fileSize !== undefined ? { fileSize } : {}),
        };
    }

    return {
        version: payload.version,
        pageCount: payload.pageCount,
        ...(source !== undefined ? { source } : {}),
        pages,
    };
}

function parsePageData(payload: unknown): IBrowserOcrPageData | null {
    if (!isRecord(payload)) {
        return null;
    }
    if (payload.pageNumber !== undefined && !isPositiveInteger(payload.pageNumber)) {
        return null;
    }
    if (payload.text !== undefined && typeof payload.text !== 'string') {
        return null;
    }

    const words = Array.isArray(payload.words) && payload.words.every(isOcrWord)
        ? payload.words
        : undefined;

    return {
        pageNumber: isPositiveInteger(payload.pageNumber) ? payload.pageNumber : 0,
        text: typeof payload.text === 'string' ? payload.text : '',
        ...(words !== undefined ? { words } : {}),
    };
}

function isManifestForDocument(
    manifest: IBrowserOcrManifest,
    pdfPath: string,
    options: IReadBrowserOcrSearchDocumentTextOptions,
) {
    if (
        typeof options.expectedPageCount === 'number'
        && options.expectedPageCount > 0
        && manifest.pageCount !== options.expectedPageCount
    ) {
        return false;
    }

    if (manifest.source?.pdfPath !== undefined && manifest.source.pdfPath !== pdfPath) {
        return false;
    }
    if (
        manifest.source?.contentSignature !== undefined
        && options.contentSignature !== undefined
        && manifest.source.contentSignature !== options.contentSignature
    ) {
        return false;
    }
    if (
        manifest.source?.fileSize !== undefined
        && options.fileSize !== undefined
        && manifest.source.fileSize !== options.fileSize
    ) {
        return false;
    }

    return true;
}

function throwIfStopped(options: IReadBrowserOcrSearchDocumentTextOptions) {
    if (options.shouldContinue?.() === false) {
        throw new Error('ERR_BROWSER_SEARCH_CANCELED');
    }
}

async function readArtifactJson(pdfPath: string, relativePath: string) {
    try {
        return await readBrowserOcrArtifactJson(pdfPath, relativePath);
    } catch {
        return null;
    }
}

export async function readBrowserOcrSearchDocumentText(
    pdfPath: string,
    options: IReadBrowserOcrSearchDocumentTextOptions = {},
): Promise<IBrowserOcrSearchDocumentText | null> {
    throwIfStopped(options);
    const manifest = parseManifest(await readArtifactJson(pdfPath, 'manifest.json'));
    if (!manifest || !isManifestForDocument(manifest, pdfPath, options)) {
        return null;
    }

    const pageTexts = Array.from({ length: manifest.pageCount }, () => '');
    for (let pageNumber = 1; pageNumber <= manifest.pageCount; pageNumber += 1) {
        throwIfStopped(options);
        const pageMapping = manifest.pages[pageNumber];
        if (!pageMapping) {
            return null;
        }

        const pageData = parsePageData(await readArtifactJson(pdfPath, pageMapping.path));
        if (!pageData) {
            return null;
        }
        if (pageData.pageNumber !== 0 && pageData.pageNumber !== pageNumber) {
            return null;
        }

        pageTexts[pageNumber - 1] = pageData.words && pageData.words.length > 0
            ? buildOcrTextLayerIndexText(pageData.words)
            : pageData.text;
    }

    return {
        pageCount: manifest.pageCount,
        pageTexts,
        textSource: {
            kind: OCR_TEXT_LAYER_INDEX_SOURCE,
            version: OCR_TEXT_LAYER_INDEX_VERSION,
        },
    };
}
