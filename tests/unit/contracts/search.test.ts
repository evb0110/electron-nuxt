import {
    describe,
    expect,
    it,
} from 'vitest';
import {
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
});
