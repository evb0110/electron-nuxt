import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPdfSearchExcerpt,
    collapseRepeatedPdfSearchPageText,
    findPdfSearchMatches,
    iteratePdfSearchMatches,
} from '@contracts/search';

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
