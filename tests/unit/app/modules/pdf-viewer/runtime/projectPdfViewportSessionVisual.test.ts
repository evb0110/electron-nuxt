import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldShowPdfViewportPageSkeleton } from '@app/modules/pdf-viewer/runtime/navigation/shouldShowPdfViewportPageSkeleton';

describe('PDF viewport-session visual projection', () => {
    it('keeps the chassis as the sole skeleton owner during an exact opening frame', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: true,
            isEmptyToDocumentTransition: true,
            isViewportTransitionActive: true,
            pageNumber: 1,
            totalPages: 10,
            viewMode: 'single',
            visual: {
                error: null,
                frameKey: 'opening-page-1',
                generation: 1,
                kind: 'page',
                pageNumber: 1,
                presentation: 'skeleton',
            },
        })).toBe(false);
    });

    it('keeps the provisional chassis frame as the sole opening skeleton owner', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: true,
            isEmptyToDocumentTransition: true,
            isViewportTransitionActive: true,
            pageNumber: 6,
            totalPages: 10,
            viewMode: 'single',
            visual: {
                error: null,
                frameKey: 'opening-page-6',
                generation: 1,
                kind: 'page',
                pageNumber: 6,
                presentation: 'skeleton',
            },
        })).toBe(false);
    });

    it('shows the page-track skeleton for post-open navigation', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: false,
            isEmptyToDocumentTransition: false,
            isViewportTransitionActive: true,
            pageNumber: 2,
            totalPages: 10,
            viewMode: 'single',
            visual: {
                error: null,
                frameKey: 'navigation-page-2',
                generation: 1,
                kind: 'page',
                pageNumber: 2,
                presentation: 'skeleton',
            },
        })).toBe(true);
    });

    it('retires a stale neighbouring skeleton when another row owns the viewport', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: true,
            isEmptyToDocumentTransition: false,
            isViewportTransitionActive: true,
            pageNumber: 6,
            totalPages: 10,
            viewMode: 'single',
            visual: {
                error: null,
                frameKey: 'navigation-page-7',
                generation: 2,
                kind: 'page',
                pageNumber: 7,
                presentation: 'canvas',
            },
        })).toBe(false);
    });

    it('keeps both pages in an authoritative facing row eligible', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: true,
            isEmptyToDocumentTransition: false,
            isViewportTransitionActive: true,
            pageNumber: 10,
            totalPages: 10,
            viewMode: 'facing',
            visual: {
                error: null,
                frameKey: 'navigation-page-9',
                generation: 2,
                kind: 'page',
                pageNumber: 9,
                presentation: 'skeleton',
            },
        })).toBe(true);
    });

    it('returns skeleton ownership to freely scrolled rows after the viewport settles', () => {
        expect(shouldShowPdfViewportPageSkeleton({
            fallbackVisible: true,
            isEmptyToDocumentTransition: false,
            isViewportTransitionActive: false,
            pageNumber: 42,
            totalPages: 100,
            viewMode: 'single',
            visual: {
                error: null,
                frameKey: null,
                generation: 2,
                kind: 'page',
                pageNumber: 1,
                presentation: 'canvas',
            },
        })).toBe(true);
    });
});
