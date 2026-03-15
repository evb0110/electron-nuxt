import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    findPageByPageLabelInput,
    formatPageIndicator,
    formatPageIndicatorWithOptions,
    getPageIndicatorLayoutMetrics,
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

    it('supports compact page-indicator length calculations for the toolbar', () => {
        const pageLabels = [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ];

        const expected = Math.max(...pageLabels.map((_, index) => formatPageIndicatorWithOptions(
            index + 1,
            pageLabels,
            { compactPhysicalPage: true },
        ).length));

        expect(getMaxPageIndicatorLength(16, pageLabels, { compactPhysicalPage: true })).toBe(expected);
    });

    it('keeps the default page indicator spacing for general UI', () => {
        expect(formatPageIndicator(16, [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ])).toBe('xvi (16)');
    });

    it('supports a compact toolbar indicator without the extra space', () => {
        expect(formatPageIndicatorWithOptions(16, [
            'i',
            'ii',
            'iii',
            'iv',
            'v',
            'vi',
            'vii',
            'viii',
            'ix',
            'x',
            'xi',
            'xii',
            'xiii',
            'xiv',
            'xv',
            'xvi',
        ], { compactPhysicalPage: true })).toBe('xvi(16)');
    });

    it('sizes page indicator display without mirroring the total width', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 17) {
                return [
                    'i',
                    'ii',
                    'iii',
                    'iv',
                    'v',
                    'vi',
                    'vii',
                    'viii',
                    'ix',
                    'x',
                    'xi',
                    'xii',
                    'xiii',
                    'xiv',
                    'xv',
                    'xvi',
                    'xvii',
                ][index] ?? String(index + 1);
            }

            return String(index - 16);
        });

        expect(getPageIndicatorLayoutMetrics(totalPages, pageLabels, true)).toEqual({
            currentWidthCh: 9,
            totalWidthCh: 3,
            separatorWidthCh: 1,
            displayWidthCh: 15,
        });
    });

    it('uses the compact page-indicator width for toolbar layout metrics', () => {
        const totalPages = 348;
        const pageLabels = Array.from({ length: totalPages }, (_, index) => {
            if (index < 17) {
                return [
                    'i',
                    'ii',
                    'iii',
                    'iv',
                    'v',
                    'vi',
                    'vii',
                    'viii',
                    'ix',
                    'x',
                    'xi',
                    'xii',
                    'xiii',
                    'xiv',
                    'xv',
                    'xvi',
                    'xvii',
                ][index] ?? String(index + 1);
            }

            return String(index - 16);
        });

        expect(getPageIndicatorLayoutMetrics(totalPages, pageLabels, true, { compactPhysicalPage: true })).toEqual({
            currentWidthCh: 8,
            totalWidthCh: 3,
            separatorWidthCh: 1,
            displayWidthCh: 14,
        });
    });

    it('keeps a smaller compact width when the total is hidden', () => {
        expect(getPageIndicatorLayoutMetrics(348, null, false)).toEqual({
            currentWidthCh: 3,
            totalWidthCh: 0,
            separatorWidthCh: 0,
            displayWidthCh: 5,
        });
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
