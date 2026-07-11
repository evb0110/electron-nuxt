import type { IOcrWord } from '@contracts/shared';
import { isOcrWord } from '@contracts/shared';
import type {
    IDocumentRevisionStamp,
    TDocumentRevisionToken,
} from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';

export type TOcrIndexRotation = 0 | 90 | 180 | 270;

interface IOcrIndexManifestBase {
    createdAt: number;
    source: { pdfPath: string };
    pageCount: number;
    pageBox: 'crop';
    ocr: {
        engine: 'tesseract';
        languages: string[];
        renderDpi: number;
    };
    pages: Record<number, { path: string }>;
}

interface IOcrIndexPageBase {
    pageNumber: number;
    rotation: TOcrIndexRotation;
    render: {
        dpi: number;
        imagePx: {
            w: number;
            h: number;
        };
    };
    text: string;
    words: IOcrWord[];
    canonicalText?: {
        source: 'evb-ocr';
        generation: string;
        contentDigest: string;
    };
}

export interface IOcrIndexV2Manifest extends IOcrIndexManifestBase { version: 2; }

export interface IOcrIndexV2Page extends IOcrIndexPageBase {}

export interface IOcrIndexV3Manifest extends IOcrIndexManifestBase {
    version: 3;
    documentRevision: IDocumentRevisionStamp;
}

export interface IOcrIndexV3Page extends IOcrIndexPageBase { documentRevision: IDocumentRevisionStamp; }

export type TOcrIndexDecodeMode = 'strict' | 'repair-legacy';

function isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isFinitePositiveNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function parseDocumentRevisionStamp(value: unknown) {
    if (!isRecord(value)) {
        return null;
    }
    const token = parseDocumentRevisionToken(value.token);
    return token === null ? null : {token};
}

function parseOcrRotation(value: unknown): TOcrIndexRotation | null {
    return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

export function parseOcrIndexV3Manifest(
    value: unknown,
    mode: TOcrIndexDecodeMode = 'strict',
): IOcrIndexV3Manifest | null {
    if (!isRecord(value) || value.version !== 3 || !isRecord(value.source) || !isRecord(value.pages)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionStamp(value.documentRevision);
    if (!documentRevision || typeof value.source.pdfPath !== 'string' || !isPositiveSafeInteger(value.pageCount)) {
        return null;
    }
    const strict = mode === 'strict';
    const ocr = isRecord(value.ocr) ? value.ocr : null;
    const languages = Array.isArray(ocr?.languages) && ocr.languages.every(language => typeof language === 'string')
        ? ocr.languages
        : null;
    const createdAt = isFiniteNonNegativeNumber(value.createdAt) ? value.createdAt : null;
    const renderDpi = isFinitePositiveNumber(ocr?.renderDpi) ? ocr.renderDpi : null;
    if (
        strict
        && (
            createdAt === null
            || value.pageBox !== 'crop'
            || ocr?.engine !== 'tesseract'
            || languages === null
            || renderDpi === null
        )
    ) {
        return null;
    }
    const pages: Record<number, {path: string}> = {};
    for (const [
        rawPageNumber,
        rawMapping,
    ] of Object.entries(value.pages)) {
        const pageNumber = Number(rawPageNumber);
        const path = isRecord(rawMapping) && typeof rawMapping.path === 'string' && rawMapping.path.length > 0
            ? rawMapping.path
            : null;
        if (
            !isPositiveSafeInteger(pageNumber)
            || String(pageNumber) !== rawPageNumber
            || pageNumber > value.pageCount
            || path === null
        ) {
            if (strict) {
                return null;
            }
            continue;
        }
        pages[pageNumber] = {path};
    }
    return {
        version: 3,
        documentRevision,
        createdAt: createdAt ?? Date.now(),
        source: {pdfPath: value.source.pdfPath},
        pageCount: value.pageCount,
        pageBox: 'crop',
        ocr: {
            engine: 'tesseract',
            languages: languages ?? [],
            renderDpi: renderDpi ?? 0,
        },
        pages,
    };
}

export function decodeOcrPage(
    value: unknown,
    expectedPageNumber: number,
    expectedRevision: TDocumentRevisionToken,
    mode: TOcrIndexDecodeMode = 'strict',
): IOcrIndexV3Page | null {
    if (!isRecord(value) || !isPositiveSafeInteger(expectedPageNumber)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionStamp(value.documentRevision);
    if (!documentRevision || documentRevision.token !== expectedRevision) {
        return null;
    }
    const strict = mode === 'strict';
    const pageNumber = value.pageNumber === undefined && !strict
        ? expectedPageNumber
        : value.pageNumber;
    if (!isPositiveSafeInteger(pageNumber) || pageNumber !== expectedPageNumber) {
        return null;
    }
    const rotation = parseOcrRotation(value.rotation);
    const render = isRecord(value.render) ? value.render : null;
    const imagePx = isRecord(render?.imagePx) ? render.imagePx : null;
    const dpi = isFinitePositiveNumber(render?.dpi) ? render.dpi : null;
    const width = isFinitePositiveNumber(imagePx?.w) ? imagePx.w : null;
    const height = isFinitePositiveNumber(imagePx?.h) ? imagePx.h : null;
    const text = typeof value.text === 'string' ? value.text : null;
    const words = Array.isArray(value.words) && value.words.every(isOcrWord) ? value.words : null;
    const canonicalText = isRecord(value.canonicalText)
        && value.canonicalText.source === 'evb-ocr'
        && typeof value.canonicalText.generation === 'string'
        && value.canonicalText.generation.length > 0
        && typeof value.canonicalText.contentDigest === 'string'
        && /^[a-f0-9]{64}$/u.test(value.canonicalText.contentDigest)
        ? {
            source: 'evb-ocr' as const,
            generation: value.canonicalText.generation,
            contentDigest: value.canonicalText.contentDigest,
        }
        : undefined;
    if (strict && (rotation === null || dpi === null || width === null || height === null || text === null || words === null)) {
        return null;
    }
    return {
        pageNumber,
        documentRevision,
        rotation: rotation ?? 0,
        render: {
            dpi: dpi ?? 0,
            imagePx: {
                w: width ?? 0,
                h: height ?? 0,
            },
        },
        text: text ?? '',
        words: words ?? [],
        ...(canonicalText ? {canonicalText} : {}),
    };
}
