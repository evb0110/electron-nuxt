import {
    describe,
    expect,
    it,
} from 'vitest';
import { readFileSync } from 'fs';
import * as contractsSearch from '@contracts/search';
import * as pdfSearchCore from '@pdf-core';

const {
    buildPdfSearchExcerpt,
    collapseRepeatedPdfSearchPageText,
    collectSearchMatchWords,
    findPdfSearchMatches,
    iteratePdfSearchMatches,
} = pdfSearchCore;

describe('contracts search compatibility exports', () => {
    it('keeps compatibility helpers behaviorally aligned with pdf-core', () => {
        const options = {
            matchCase: false,
            wholeWord: true,
            useRegex: false,
        };

        expect(contractsSearch.escapeSearchRegex('a.b')).toBe(pdfSearchCore.escapeSearchRegex('a.b'));
        expect(contractsSearch.buildPdfSearchRegex('foo', options).source)
            .toBe(pdfSearchCore.buildPdfSearchRegex('foo', options).source);
        expect(() => contractsSearch.assertSafePdfSearchRegex('(a+)+$', options))
            .toThrow('pattern is too complex');
        expect(() => pdfSearchCore.assertSafePdfSearchRegex('(a+)+$', options))
            .toThrow('pattern is too complex');
        expect(() => contractsSearch.validateSearchQuery('x'.repeat(513), {
            matchCase: false,
            wholeWord: false,
            useRegex: true,
        })).toThrow('maximum length is 512');
        expect(() => pdfSearchCore.validateSearchQuery('x'.repeat(513), {
            matchCase: false,
            wholeWord: false,
            useRegex: true,
        })).toThrow('maximum length is 512');
        expect(contractsSearch.collapseRepeatedPdfSearchPageText('alpha '.repeat(32)))
            .toBe(pdfSearchCore.collapseRepeatedPdfSearchPageText('alpha '.repeat(32)));
        expect(contractsSearch.findPdfSearchMatches('Foo foo', 'foo'))
            .toEqual(pdfSearchCore.findPdfSearchMatches('Foo foo', 'foo'));
        expect(Array.from(contractsSearch.iteratePdfSearchMatches('foo foo', 'foo')))
            .toEqual(Array.from(pdfSearchCore.iteratePdfSearchMatches('foo foo', 'foo')));
        expect(contractsSearch.buildPdfSearchExcerpt('alpha beta gamma', 6, 10, 3))
            .toEqual(pdfSearchCore.buildPdfSearchExcerpt('alpha beta gamma', 6, 10, 3));
    });
});

describe('collapseRepeatedPdfSearchPageText', () => {
    it('collapses large exact repeated PDF page text streams', () => {
        const pageText = 'СЛОВАРЬ\nАРАБСКОЙ ХРЕСТОМАТИИ И КОРАНУ. СОСТАВИЛЪ ПРОФ. В. ГИРГАСЪ.\n';

        expect(collapseRepeatedPdfSearchPageText(pageText.repeat(3))).toBe(pageText);
    });

    it('collapses OCR overlay stacks with more than four copies', () => {
        const pageText = 'В. 0. Гиргас АРАВСКО-РУССКИЙ СЛОВАРЬ К ВОТАНО и ХАДИСАМ\n';

        expect(collapseRepeatedPdfSearchPageText(pageText.repeat(6))).toBe(pageText);
    });

    it('keeps short repeated phrases because they can be real page content', () => {
        expect(collapseRepeatedPdfSearchPageText('ha '.repeat(4))).toBe('ha '.repeat(4));
    });

    it('keeps non-repeated text unchanged', () => {
        const pageText = 'alpha beta gamma\nalpha beta delta\n';

        expect(collapseRepeatedPdfSearchPageText(pageText)).toBe(pageText);
    });
});

describe('findPdfSearchMatches', () => {
    it('ignores zero-width regex matches without looping forever', () => {
        expect(findPdfSearchMatches('aaa', /(?=a)/gu)).toEqual([]);
    });

    it('iterates matches incrementally', () => {
        const iterator = iteratePdfSearchMatches('foo bar foo', 'foo');

        expect(iterator.next().value).toEqual({
            startOffset: 0,
            endOffset: 3,
        });
        expect(iterator.next().value).toEqual({
            startOffset: 8,
            endOffset: 11,
        });
        expect(iterator.next().done).toBe(true);
    });

    it('honors case sensitivity and literal escaping', () => {
        expect(findPdfSearchMatches('Foo foo f.o', 'foo')).toEqual([
            {
                startOffset: 0,
                endOffset: 3,
            },
            {
                startOffset: 4,
                endOffset: 7,
            },
        ]);
        expect(findPdfSearchMatches('Foo foo f.o', 'foo', { matchCase: true })).toEqual([{
            startOffset: 4,
            endOffset: 7,
        }]);
        expect(findPdfSearchMatches('fao f.o foo', 'f.o')).toEqual([{
            startOffset: 4,
            endOffset: 7,
        }]);
    });

    it('supports regex and non-global regex inputs', () => {
        expect(findPdfSearchMatches('a1 b22 c333', '\\p{L}\\d+', { useRegex: true })).toEqual([
            {
                startOffset: 0,
                endOffset: 2,
            },
            {
                startOffset: 3,
                endOffset: 6,
            },
            {
                startOffset: 7,
                endOffset: 11,
            },
        ]);
        expect(findPdfSearchMatches('foo foo', /foo/u)).toEqual([
            {
                startOffset: 0,
                endOffset: 3,
            },
            {
                startOffset: 4,
                endOffset: 7,
            },
        ]);
    });

    it('rejects regex patterns that are unsafe for document search', () => {
        expect(() => findPdfSearchMatches('aaaaaaaaaaaaaaaa!', '(a+)+$', { useRegex: true }))
            .toThrow('pattern is too complex for document search');
        expect(() => findPdfSearchMatches('aaaaaaaaaaaaaaaa!', '(?:a|aa)+$', { useRegex: true }))
            .toThrow('pattern is too complex for document search');
        expect(() => findPdfSearchMatches('alpha alpha', '(alpha) \\1', { useRegex: true }))
            .toThrow('pattern is too complex for document search');
    });

    it('uses Unicode-aware whole-word boundaries', () => {
        expect(findPdfSearchMatches('cat bobcat кот cat_1 кот!', 'кот', { wholeWord: true })).toEqual([
            {
                startOffset: 11,
                endOffset: 14,
            },
            {
                startOffset: 21,
                endOffset: 24,
            },
        ]);
        expect(findPdfSearchMatches('cat bobcat cat!', 'cat', { wholeWord: true })).toEqual([
            {
                startOffset: 0,
                endOffset: 3,
            },
            {
                startOffset: 11,
                endOffset: 14,
            },
        ]);
    });
});

describe('buildPdfSearchExcerpt', () => {
    it('normalizes surrounding whitespace and reports prefix/suffix truncation', () => {
        expect(buildPdfSearchExcerpt('alpha \n beta target gamma \t delta', 13, 19, 7)).toEqual({
            prefix: true,
            suffix: true,
            before: 'beta ',
            match: 'target',
            after: ' gamma',
        });
    });
});

interface ISearchConformanceExpectedMatch {
    startOffset: number;
    endOffset: number;
    excerpt: ReturnType<typeof buildPdfSearchExcerpt>;
}

interface ISearchConformanceCase {
    id: string;
    text: string;
    query: string;
    options?: {
        matchCase?: boolean;
        wholeWord?: boolean;
        useRegex?: boolean;
    };
    contextChars: number;
    expectedMatches: ISearchConformanceExpectedMatch[];
}

interface ISearchConformanceGeometryCase {
    pageWidth: number;
    pageHeight: number;
    words: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
    range: {
        startOffset: number;
        endOffset: number;
    };
    expectedWords: Array<{
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }>;
}

interface ISearchConformanceCorpus {
    spec: {offsetEncoding: string;};
    cases: ISearchConformanceCase[];
    geometryCase: ISearchConformanceGeometryCase;
}

const searchConformanceCorpus = JSON.parse(readFileSync(
    new URL('../../../packages/contracts/searchConformanceCorpus.json', import.meta.url),
    'utf8',
)) as ISearchConformanceCorpus;

describe('search conformance corpus', () => {
    it('documents UTF-16 as the normative search offset encoding', () => {
        expect(searchConformanceCorpus.spec.offsetEncoding).toBe('utf-16');
    });

    it.each(searchConformanceCorpus.cases)('matches corpus case $id', (fixture) => {
        const matches = findPdfSearchMatches(fixture.text, fixture.query, fixture.options);

        expect(matches).toEqual(fixture.expectedMatches.map((match) => ({
            startOffset: match.startOffset,
            endOffset: match.endOffset,
        })));
        expect(matches.map(match => buildPdfSearchExcerpt(
            fixture.text,
            match.startOffset,
            match.endOffset,
            fixture.contextChars,
        ))).toEqual(fixture.expectedMatches.map(match => match.excerpt));
    });

    it('attaches OCR geometry from the same UTF-16 match range', () => {
        const fixture = searchConformanceCorpus.geometryCase;

        expect(collectSearchMatchWords({
            words: fixture.words,
            pageWidth: fixture.pageWidth,
            pageHeight: fixture.pageHeight,
        }, fixture.range.startOffset, fixture.range.endOffset)).toEqual(fixture.expectedWords);
    });
});
