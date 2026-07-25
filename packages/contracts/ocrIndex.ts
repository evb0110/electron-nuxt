import type { IOcrWord } from '@contracts/shared';
import { isOcrWord } from '@contracts/shared';
import type { IDocumentRevisionStamp } from '@contracts/documentRevision';
import { parseDocumentRevisionToken } from '@contracts/documentRevision';
import { isRecord } from '@contracts/runtimeGuards';

export type TOcrIndexRotation = 0 | 90 | 180 | 270;

/**
 * The manifest is the sole owner of the catalog's revision and page ordering.
 * Page artifacts are position- and revision-independent so a revision bump or a
 * page reorder costs one manifest write instead of one rewrite per page.
 */
export interface IOcrIndexV3Manifest {
    version: 3;
    documentRevision: IDocumentRevisionStamp;
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

export interface IOcrIndexV3Page {
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

/**
 * Decodes a page artifact. Identity and freshness belong to the manifest that
 * points at the artifact, so `pageNumber` and `documentRevision` written by
 * older catalogs are ignored rather than validated.
 */
export function decodeOcrPage(
    value: unknown,
    mode: TOcrIndexDecodeMode = 'strict',
): IOcrIndexV3Page | null {
    if (!isRecord(value)) {
        return null;
    }
    const strict = mode === 'strict';
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
