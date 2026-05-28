import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    hasRenderedPageInRange,
    isAnchoredCurrentPageSyncSource,
    isResizeRerenderSource,
    shouldPreserveExistingRerenderContent,
} from '@app/modules/pdf-viewer/runtime/rerenderStrategy';

describe('rerenderStrategy', () => {
    it('detects resize-driven rerender sources', () => {
        expect(isResizeRerenderSource('resize-observer')).toBe(true);
        expect(isResizeRerenderSource('resize-settle')).toBe(true);
        expect(isResizeRerenderSource('zoom-change')).toBe(false);
    });

    it('uses fixed current-page sync for resize and zoom anchors', () => {
        expect(isAnchoredCurrentPageSyncSource('resize-observer')).toBe(true);
        expect(isAnchoredCurrentPageSyncSource('resize-settle')).toBe(true);
        expect(isAnchoredCurrentPageSyncSource('zoom-change')).toBe(true);
        expect(isAnchoredCurrentPageSyncSource('zoom-settle')).toBe(true);
        expect(isAnchoredCurrentPageSyncSource('fit-width-current-page')).toBe(true);
        expect(isAnchoredCurrentPageSyncSource('re-render')).toBe(false);
    });

    it('checks whether the visible range already has rendered content', () => {
        expect(hasRenderedPageInRange(
            {
                start: 2,
                end: 4,
            },
            (page) => page === 3,
        )).toBe(true);

        expect(hasRenderedPageInRange(
            {
                start: 2,
                end: 4,
            },
            () => false,
        )).toBe(false);
    });

    it('always preserves existing content for zoom and fit rerenders', () => {
        expect(shouldPreserveExistingRerenderContent({
            source: 'zoom-change',
            visibleRange: {
                start: 4,
                end: 6,
            },
            isPageRendered: () => false,
        })).toBe(true);

        expect(shouldPreserveExistingRerenderContent({
            source: 'fit-mode',
            visibleRange: {
                start: 4,
                end: 6,
            },
            isPageRendered: () => false,
        })).toBe(true);

        expect(shouldPreserveExistingRerenderContent({
            source: 'fit-width-current-page',
            visibleRange: {
                start: 4,
                end: 6,
            },
            isPageRendered: () => false,
        })).toBe(true);
    });

    it('always preserves resize rerenders', () => {
        expect(shouldPreserveExistingRerenderContent({
            source: 'resize-observer',
            visibleRange: {
                start: 5,
                end: 7,
            },
            isPageRendered: (page) => page === 6,
        })).toBe(true);

        expect(shouldPreserveExistingRerenderContent({
            source: 'resize-settle',
            visibleRange: {
                start: 5,
                end: 7,
            },
            isPageRendered: () => false,
        })).toBe(true);
    });

    it('does not preserve unrelated rerender sources by default', () => {
        expect(shouldPreserveExistingRerenderContent({
            source: 're-render',
            visibleRange: {
                start: 1,
                end: 1,
            },
            isPageRendered: () => true,
        })).toBe(false);
    });
});
