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

const DOCUMENT_TEXT_SOURCES = [
    'pdf-native',
    'foreign-ocr',
    'evb-ocr',
] as const satisfies readonly TDocumentTextSource[];

function isPositiveFinite(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
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
        if (
            !isRecord(candidate)
            || typeof candidate.pageNumber !== 'number'
            || !Number.isSafeInteger(candidate.pageNumber)
            || candidate.pageNumber < 1
            || candidate.pageNumber > value.pageCount
            || pageNumbers.has(candidate.pageNumber)
            || typeof candidate.text !== 'string'
            || !isOneOf(DOCUMENT_TEXT_SOURCES, candidate.source)
            || typeof candidate.contentDigest !== 'string'
            || (candidate.generation !== undefined && typeof candidate.generation !== 'string')
            || (candidate.words !== undefined && (
                !Array.isArray(candidate.words)
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
        pageNumbers.add(candidate.pageNumber);
        pages.push({
            pageNumber: candidate.pageNumber,
            text: candidate.text,
            source: candidate.source,
            contentDigest: candidate.contentDigest,
            ...(candidate.words === undefined ? {} : {words: candidate.words}),
            ...(candidate.generation === undefined ? {} : {generation: candidate.generation}),
            ...(candidate.languages === undefined ? {} : {languages: [...candidate.languages]}),
            ...(render === undefined ? {} : {render}),
        });
    }

    return {
        documentRevision,
        pageCount: value.pageCount,
        pages,
        contentDigest: value.contentDigest,
    };
}
