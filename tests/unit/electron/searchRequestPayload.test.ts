import {
    describe,
    expect,
    it,
} from 'vitest';
import * as contractsSearch from '@contracts/search';
import * as searchRequestPayload from '@electron/features/search/searchRequestPayload';

describe('search request payload normalization', () => {
    it('normalizes renderer search payloads at the Electron search boundary', () => {
        expect(searchRequestPayload.normalizePdfSearchRequestPayload({
            pdfPath: '  /tmp/work.pdf  ',
            query: 'needle',
            requestId: '  search-1  ',
            pageCount: 12,
            documentRevision: 'drt1:test',
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        })).toEqual({
            pdfPath: '/tmp/work.pdf',
            query: 'needle',
            requestId: 'search-1',
            pageCount: 12,
            documentRevision: 'drt1:test',
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        });
    });

    it('keeps contract compatibility fallback behavior aligned with the feature owner', () => {
        const payload = {
            pdfPath: '  /tmp/work.pdf  ',
            query: 'needle',
            requestId: '  search-1  ',
            pageCount: 12,
            documentRevision: 'drt1:test',
            matchCase: true,
            wholeWord: false,
            useRegex: false,
        };
        const warmIndexPayload = {
            pdfPath: '  /tmp/work.pdf  ',
            requestId: '  warm-1  ',
            pageCount: 12,
        };

        expect(searchRequestPayload.SEARCH_REQUEST_ID_MAX_LENGTH)
            .toBe(contractsSearch.SEARCH_REQUEST_ID_MAX_LENGTH);
        expect(searchRequestPayload.SEARCH_PDF_PATH_MAX_LENGTH)
            .toBe(contractsSearch.SEARCH_PDF_PATH_MAX_LENGTH);
        expect(searchRequestPayload.normalizeOptionalSearchRequestId('  search-1  '))
            .toBe(contractsSearch.normalizeOptionalSearchRequestId('  search-1  '));
        expect(searchRequestPayload.normalizeOptionalSearchPageCount(12))
            .toBe(contractsSearch.normalizeOptionalSearchPageCount(12));
        expect(searchRequestPayload.normalizePdfSearchRequestPayload(payload))
            .toEqual(contractsSearch.normalizePdfSearchRequestPayload(payload));
        expect(searchRequestPayload.normalizePdfSearchWarmIndexPayload(warmIndexPayload))
            .toEqual(contractsSearch.normalizePdfSearchWarmIndexPayload(warmIndexPayload));
    });

    it('accepts large page counts without materializing a page list', () => {
        const pageCount = 1_000_001;
        const request = searchRequestPayload.normalizePdfSearchRequestPayload({
            pdfPath: '/tmp/work.pdf',
            query: 'needle',
            pageCount,
        });
        const warmIndexRequest = searchRequestPayload.normalizePdfSearchWarmIndexPayload({
            pdfPath: '/tmp/work.pdf',
            pageCount,
        });

        expect(request).toMatchObject({pageCount});
        expect(warmIndexRequest).toMatchObject({pageCount});
        expect(request).not.toHaveProperty('pages');
        expect(warmIndexRequest).not.toHaveProperty('pages');
        expect(contractsSearch.normalizeOptionalSearchPageCount(pageCount)).toBe(pageCount);

        for (const invalidPageCount of [
            0,
            -1,
            1.5,
            Number.MAX_SAFE_INTEGER + 1,
            Number.POSITIVE_INFINITY,
        ]) {
            expect(() => searchRequestPayload.normalizeOptionalSearchPageCount(invalidPageCount))
                .toThrow('Invalid pageCount: must be a positive safe integer');
        }
    });

    it('matches compatibility fallback failures for invalid inputs', () => {
        const invalidPayload = {
            pdfPath: '/tmp/work.pdf',
            query: 'needle',
            requestId: 'x'.repeat(129),
        };

        expect(() => searchRequestPayload.normalizePdfSearchRequestPayload(invalidPayload))
            .toThrow('requestId exceeds maximum length (128)');
        expect(() => contractsSearch.normalizePdfSearchRequestPayload(invalidPayload))
            .toThrow('requestId exceeds maximum length (128)');
    });
});
