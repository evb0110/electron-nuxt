import {
    createPdfViewportGeometryFromLayout,
    computePdfViewportGeometry,
    resolveAnchorFromScroll,
    resolveScrollForAnchor,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    describe,
    expect,
    it,
} from 'vitest';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';

describe('pdfViewportGeometry', () => {
    const pages = [
        {
            width: 600,
            height: 800,
        },
        {
            width: 800,
            height: 600,
        },
        {
            width: 600,
            height: 1_200,
        },
    ];

    it('is pure and preserves a semantic anchor across corrected geometry', () => {
        const before = computePdfViewportGeometry({
            revision: 1,
            pages,
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 10,
            padding: 20,
        });
        const anchor = resolveAnchorFromScroll(before, {
            left: 0,
            top: 840,
        });
        const corrected = computePdfViewportGeometry({
            revision: 2,
            pages: [
                {
                    width: 600,
                    height: 840,
                },
                ...pages.slice(1),
            ],
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 10,
            padding: 20,
        });

        expect(anchor.page).toBe(2);
        expect(resolveScrollForAnchor(corrected, anchor).top).toBeGreaterThan(840);
        expect(anchor).toEqual(resolveAnchorFromScroll(before, {
            left: 0,
            top: 840,
        }));
    });

    it('builds facing rows atomically and keeps DPR outside CSS geometry', () => {
        const geometry = computePdfViewportGeometry({
            revision: 3,
            pages,
            viewportWidth: 1_400,
            viewportHeight: 800,
            zoom: 1,
            viewMode: 'facing-first-single',
            gap: 12,
            padding: 16,
        });
        expect(geometry.rows.map(row => [
            row.startPage,
            row.endPage,
        ])).toEqual([
            [
                1,
                1,
            ],
            [
                2,
                3,
            ],
        ]);
        expect(geometry.pageRects).toHaveLength(3);
        const rightPage = geometry.pageRects[2]!;
        const rightPageAnchor = resolveAnchorFromScroll(geometry, {
            left: Math.max(0, rightPage.left + rightPage.width / 2 - geometry.viewportWidth / 2),
            top: rightPage.top,
        });
        expect(rightPageAnchor.page).toBe(3);
    });

    it('keeps fit-height spread geometry identical to the physical page-track padding and gap', () => {
        const viewport = {
            width: 1_200,
            height: 900,
        };
        const margin = 20;
        const pageHeight = 800;
        const scale = (viewport.height - margin * 2) / pageHeight;
        const layout = buildPageLayoutMetrics({
            pageMetrics: [
                {
                    width: 400,
                    height: pageHeight,
                },
                {
                    width: 400,
                    height: pageHeight,
                },
            ],
            totalPages: 2,
            viewMode: 'facing',
            scale,
            gap: margin,
            paddingTop: margin,
            paddingBottom: margin,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected fit-height page layout');
        }

        const geometry = createPdfViewportGeometryFromLayout(layout, viewport, 1);
        const [
            leftPage,
            rightPage,
        ] = geometry.pageRects;
        expect(layout.contentHeight).toBe(viewport.height);
        expect(leftPage?.top).toBe(margin);
        expect(leftPage?.height).toBe(viewport.height - margin * 2);
        expect((rightPage?.left ?? 0) - ((leftPage?.left ?? 0) + (leftPage?.width ?? 0))).toBe(margin);
        expect(geometry.rows[0]?.rect.width).toBe(
            (leftPage?.width ?? 0) + margin + (rightPage?.width ?? 0),
        );
    });

    it('keeps a page-top anchor above the declared content inset', () => {
        const geometry = computePdfViewportGeometry({
            revision: 1,
            pages,
            viewportWidth: 900,
            viewportHeight: 700,
            zoom: 1,
            viewMode: 'single',
            gap: 20,
            padding: 20,
        });

        expect(resolveScrollForAnchor(geometry, {
            page: 1,
            pageXFraction: 0.5,
            pageYFraction: 0,
            viewportXFraction: 0.5,
            viewportYFraction: 0,
            affinity: 'start',
        }).top).toBe(0);
        expect(resolveScrollForAnchor(geometry, {
            page: 2,
            pageXFraction: 0.5,
            pageYFraction: 0,
            viewportXFraction: 0.5,
            viewportYFraction: 0,
            affinity: 'start',
        }).top).toBe(820);
    });
});
