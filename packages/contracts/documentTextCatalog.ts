import type { IOcrWord } from '@contracts/shared';
import { isOcrWord } from '@contracts/shared';
import {
    parseDocumentRevisionToken,
    type TDocumentRevisionToken,
} from '@contracts/documentRevision';
import {
    isOneOf,
    isRecord,
    isStringArray,
} from '@contracts/runtimeGuards';

export type TDocumentTextSource = 'pdf-native' | 'foreign-ocr' | 'evb-ocr';

export interface IDocumentTextCatalogPage {
    pageNumber: number;
    text: string;
    source: TDocumentTextSource;
    words?: IOcrWord[];
    generation?: string;
    render?: {
        dpi: number;
        imagePx: {
            w: number;
            h: number
        };
    };
    languages?: string[];
    contentDigest: string;
}

export interface IDocumentTextSnapshot {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pages: IDocumentTextCatalogPage[];
    contentDigest: string;
}

export interface IDocumentOcrAvailability {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    pageNumbers: number[];
}

export interface IDocumentOcrPageSnapshot {
    documentRevision: TDocumentRevisionToken;
    pageCount: number;
    page: IDocumentTextCatalogPage | null;
}

export const MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS = 100_000;
export const MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH = 16 * 1024 * 1024;

const DOCUMENT_TEXT_SOURCES = [
    'pdf-native',
    'foreign-ocr',
    'evb-ocr',
] as const satisfies readonly TDocumentTextSource[];

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function decodeDocumentTextCatalogPage(
    candidate: unknown,
    pageCount: number,
    pageNumbers?: Set<number>,
): IDocumentTextCatalogPage | null {
    if (
        !isRecord(candidate)
        || typeof candidate.pageNumber !== 'number'
        || !Number.isSafeInteger(candidate.pageNumber)
        || candidate.pageNumber < 1
        || candidate.pageNumber > pageCount
        || pageNumbers?.has(candidate.pageNumber) === true
        || typeof candidate.text !== 'string'
        || candidate.text.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_TEXT_LENGTH
        || !isOneOf(DOCUMENT_TEXT_SOURCES, candidate.source)
        || typeof candidate.contentDigest !== 'string'
        || (candidate.generation !== undefined && typeof candidate.generation !== 'string')
        || (candidate.words !== undefined && (
            !Array.isArray(candidate.words)
            || candidate.words.length > MAX_DOCUMENT_TEXT_CATALOG_PAGE_WORDS
            || !candidate.words.every(isOcrWord)
        ))
        || (candidate.languages !== undefined && (
            !isStringArray(candidate.languages)
            || candidate.languages.some(language => language.length === 0)
        ))
    ) {
        return null;
    }
    let render: IDocumentTextCatalogPage['render'];
    if (candidate.render !== undefined) {
        if (
            !isRecord(candidate.render)
            || !isPositiveFinite(candidate.render.dpi)
            || !isRecord(candidate.render.imagePx)
            || !isPositiveFinite(candidate.render.imagePx.w)
            || !isPositiveFinite(candidate.render.imagePx.h)
        ) {
            return null;
        }
        render = {
            dpi: candidate.render.dpi,
            imagePx: {
                w: candidate.render.imagePx.w,
                h: candidate.render.imagePx.h,
            },
        };
    }
    pageNumbers?.add(candidate.pageNumber);
    return {
        pageNumber: candidate.pageNumber,
        text: candidate.text,
        source: candidate.source,
        contentDigest: candidate.contentDigest,
        ...(candidate.words === undefined ? {} : {words: candidate.words}),
        ...(candidate.generation === undefined ? {} : {generation: candidate.generation}),
        ...(candidate.languages === undefined ? {} : {languages: [...candidate.languages]}),
        ...(render === undefined ? {} : {render}),
    };
}

export function decodeDocumentTextSnapshot(value: unknown): IDocumentTextSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || !Number.isSafeInteger(value.pageCount)
        || typeof value.pageCount !== 'number'
        || value.pageCount < 0
        || !Array.isArray(value.pages)
        || typeof value.contentDigest !== 'string'
    ) {
        return null;
    }

    const pages: IDocumentTextCatalogPage[] = [];
    const pageNumbers = new Set<number>();
    for (const candidate of value.pages) {
        const page = decodeDocumentTextCatalogPage(candidate, value.pageCount, pageNumbers);
        if (!page) {
            return null;
        }
        pages.push(page);
    }

    return {
        documentRevision,
        pageCount: value.pageCount,
        pages,
        contentDigest: value.contentDigest,
    };
}

export function decodeDocumentOcrAvailability(value: unknown): IDocumentOcrAvailability | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || !Array.isArray(value.pageNumbers)
        || value.pageNumbers.length > value.pageCount
    ) {
        return null;
    }
    const pageNumbers = new Set<number>();
    for (const pageNumber of value.pageNumbers) {
        if (
            typeof pageNumber !== 'number'
            || !Number.isSafeInteger(pageNumber)
            || pageNumber < 1
            || pageNumber > value.pageCount
            || pageNumbers.has(pageNumber)
        ) {
            return null;
        }
        pageNumbers.add(pageNumber);
    }
    return {
        documentRevision,
        pageCount: value.pageCount,
        pageNumbers: Array.from(pageNumbers),
    };
}

export function decodeDocumentOcrPageSnapshot(value: unknown): IDocumentOcrPageSnapshot | null {
    if (!isRecord(value)) {
        return null;
    }
    const documentRevision = parseDocumentRevisionToken(value.documentRevision);
    if (
        documentRevision === null
        || typeof value.pageCount !== 'number'
        || !Number.isSafeInteger(value.pageCount)
        || value.pageCount < 0
        || (value.page !== null && value.page === undefined)
    ) {
        return null;
    }
    const page = value.page === null
        ? null
        : decodeDocumentTextCatalogPage(value.page, value.pageCount);
    if (value.page !== null && (page === null || page.source !== 'evb-ocr')) {
        return null;
    }
    return {
        documentRevision,
        pageCount: value.pageCount,
        page,
    };
}
