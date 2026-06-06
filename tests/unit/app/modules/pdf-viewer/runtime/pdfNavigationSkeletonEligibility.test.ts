import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { shouldShowPdfNavigationSkeleton } from '@app/modules/pdf-viewer/runtime/rendering/pdf-navigation-skeleton-eligibility/shouldShowPdfNavigationSkeleton';

describe('shouldShowPdfNavigationSkeleton', () => {
    it('keeps the ordinary visible-range skeleton decision authoritative', () => {
        expect(shouldShowPdfNavigationSkeleton({
            pageNumber: 20,
            navigationAnchorPage: null,
            totalPages: 100,
            viewMode: 'single',
            isPageRendered: vi.fn(() => false),
            shouldShowSkeleton: vi.fn(() => true),
        })).toBe(true);
    });

    it('allows the active continuous navigation target while visibleRange catches up', () => {
        expect(shouldShowPdfNavigationSkeleton({
            pageNumber: 13,
            navigationAnchorPage: 13,
            totalPages: 100,
            viewMode: 'single',
            isPageRendered: vi.fn(() => false),
            shouldShowSkeleton: vi.fn(() => false),
        })).toBe(true);
    });

    it('does not show a navigation skeleton once the target page has rendered', () => {
        expect(shouldShowPdfNavigationSkeleton({
            pageNumber: 13,
            navigationAnchorPage: 13,
            totalPages: 100,
            viewMode: 'single',
            isPageRendered: vi.fn(() => true),
            shouldShowSkeleton: vi.fn(() => false),
        })).toBe(false);
    });

    it('includes the full active row in facing modes', () => {
        expect(shouldShowPdfNavigationSkeleton({
            pageNumber: 10,
            navigationAnchorPage: 9,
            totalPages: 100,
            viewMode: 'facing',
            isPageRendered: vi.fn(() => false),
            shouldShowSkeleton: vi.fn(() => false),
        })).toBe(true);
    });
});
