import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolveDocumentPageDisplayLayoutsBounded,
    resolveDocumentPageHeightsBounded,
    resolveDocumentPageLayoutsBounded,
    resolveDocumentPageSourceReadyEdgeSemanticPage,
    resolveDocumentPageTopsBounded,
    resolveDocumentPageZoomAnchorLayoutsBounded,
} from '@app/modules/workspace-shell/viewers/useDocumentPageSourceRuntime';
import {
    createProvisionalDocumentPageMetrics,
    isSparseDocumentPageMetrics,
} from '@app/modules/workspace-shell/viewers/loadPrioritizedDocumentPageMetrics';
import {DOCUMENT_PAGE_GUTTER_PX} from '@app/utils/document-viewer/layout/documentPageGutterPx';
import {isLazyIndexedCollection} from '@app/utils/document-viewer/virtualization/pageVirtualization';

describe('document page-source ready-edge reconciliation', () => {
    it('preserves the committed navigation target until a trusted page is observed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBe(11);
    });

    it('falls back to the requested page when no page is committed', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: null,
            observedPage: null,
        })).toBe(11);
    });

    it('does not reconcile before the viewport session is ready', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'opening',
            requestedPage: 11,
            committedPage: 11,
            observedPage: null,
        })).toBeNull();
    });

    it('leaves a physically observed page for viewport reconciliation', () => {
        expect(resolveDocumentPageSourceReadyEdgeSemanticPage({
            lifecycle: 'ready',
            requestedPage: 11,
            committedPage: 11,
            observedPage: 18,
        })).toBeNull();
    });
});

describe('document page-source layout memory bounds', () => {
    it('keeps sparse million-page display layouts lazy and on-demand', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        expect(isSparseDocumentPageMetrics(metrics)).toBe(true);

        const layouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );

        expect(isLazyIndexedCollection(layouts)).toBe(true);
        expect(Object.keys(layouts).filter(key => /^\d+$/u.test(key))).toEqual([]);
        expect(layouts).toHaveLength(1_000_000);
        expect(layouts[999_999]).toMatchObject({
            width: 600,
            height: 800,
        });
    });

    it('keeps every sparse continuous layout collection lazy without mapping the document', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        Object.defineProperty(displayLayouts, 'map', {
            configurable: true,
            value: () => {
                throw new Error('sparse page layouts must not be mapped');
            },
        });

        const pageHeights = resolveDocumentPageHeightsBounded(displayLayouts);
        const pageTops = resolveDocumentPageTopsBounded(pageHeights, true);
        const pageLayouts = resolveDocumentPageLayoutsBounded(
            displayLayouts,
            pageTops,
            true,
        );

        for (const collection of [
            pageHeights,
            pageTops,
            pageLayouts,
        ]) {
            expect(isLazyIndexedCollection(collection)).toBe(true);
            expect(Object.keys(collection).filter(key => /^\d+$/u.test(key))).toEqual([]);
            expect(collection).toHaveLength(1_000_000);
        }
        expect(pageHeights[0]).toBe(800);
        expect(pageTops[0]).toBe(20);
        expect(pageLayouts[0]).toMatchObject({
            top: 20,
            width: 600,
            height: 800,
        });
    });

    it('keeps sparse zoom-anchor layouts lazy without mapping the document', () => {
        const metrics = createProvisionalDocumentPageMetrics(1_000_000, {
            widthPoints: 600,
            heightPoints: 800,
            rotation: 0,
        });
        const displayLayouts = resolveDocumentPageDisplayLayoutsBounded(
            metrics,
            600,
            800,
            1,
            'custom',
        );
        const pageLayouts = resolveDocumentPageLayoutsBounded(
            displayLayouts,
            resolveDocumentPageTopsBounded(
                resolveDocumentPageHeightsBounded(displayLayouts),
                true,
            ),
            true,
        );
        Object.defineProperty(pageLayouts, 'map', {
            configurable: true,
            value: () => {
                throw new Error('sparse page layouts must not be mapped');
            },
        });

        const zoomAnchorLayouts = resolveDocumentPageZoomAnchorLayoutsBounded(
            pageLayouts,
            pageWidth => Math.max(DOCUMENT_PAGE_GUTTER_PX, (800 - pageWidth) / 2),
        );

        expect(isLazyIndexedCollection(zoomAnchorLayouts)).toBe(true);
        expect(Object.keys(zoomAnchorLayouts).filter(key => /^\d+$/u.test(key))).toEqual([]);
        expect(zoomAnchorLayouts).toHaveLength(1_000_000);
        expect(zoomAnchorLayouts[0]).toMatchObject({
            left: 100,
            top: 20,
            width: 600,
            height: 800,
        });
    });
});
