import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    findPageByPageLabelInput,
    formatPageIndicator,
    getMaxPageIndicatorLength,
} from '@app/utils/pdf-page-labels';

describe('pdf-page-labels', () => {
    it('uses the last numeric page for default labels', () => {
        expect(getMaxPageIndicatorLength(348, null)).toBe(3);
    });

    it('reserves enough width for the longest formatted logical label', () => {
        const pageLabels = [
            'ix',
            'x',
            'A-12',
            'Appendix',
        ];

        const expected = Math.max(...pageLabels.map((_, index) => formatPageIndicator(index + 1, pageLabels).length));

        expect(getMaxPageIndicatorLength(pageLabels.length, pageLabels)).toBe(expected);
    });

    it('falls back to numeric width when labels do not match page count', () => {
        expect(getMaxPageIndicatorLength(120, [
            'i',
            'ii',
        ])).toBe(3);
    });

    it('prefers numeric page labels over physical page numbers when labels exist', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 25) {
                return String(index + 1);
            }

            return String(index - 24);
        });

        expect(findPageByPageLabelInput('132', totalPages, pageLabels)).toBe(157);
    });
});
