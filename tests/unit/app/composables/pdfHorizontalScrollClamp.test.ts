import {
    describe,
    expect,
    it,
} from 'vitest';
import { resolvePageBoundedHorizontalScroll } from '@app/modules/pdf-viewer/engine/pdf-horizontal-scroll-clamp/resolvePageBoundedHorizontalScroll';

describe('resolvePageBoundedHorizontalScroll', () => {
    it('locks horizontal scroll to the active page when the page fits the viewport', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 1200,
            viewportWidth: 1982,
            pageLeft: 20,
            pageWidth: 1942,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 0,
            scrollLeft: 0,
            shouldLock: true,
        });
    });

    it('bounds horizontal scroll to the small overflow of a slightly wider active page', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 1200,
            viewportWidth: 1982,
            pageLeft: 20,
            pageWidth: 1955,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 13,
            scrollLeft: 13,
            shouldLock: false,
        });
    });

    it('keeps panning inside a genuinely wide active page bounded by that page, not the document', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 5000,
            viewportWidth: 1000,
            pageLeft: 20,
            pageWidth: 1400,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 440,
            scrollLeft: 440,
            shouldLock: false,
        });
    });

    it('centers a narrower active page instead of preserving unrelated document scroll', () => {
        const result = resolvePageBoundedHorizontalScroll({
            scrollLeft: 900,
            viewportWidth: 1000,
            pageLeft: 250,
            pageWidth: 500,
            margin: 20,
        });

        expect(result).toEqual({
            minScrollLeft: 0,
            maxScrollLeft: 0,
            scrollLeft: 0,
            shouldLock: true,
        });
    });
});
