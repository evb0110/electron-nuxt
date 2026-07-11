import {
    computePdfViewportGeometry,
    resolveAnchorFromScroll,
    resolveScrollForAnchor,
} from '@app/modules/pdf-viewer/runtime/viewport/pdfViewportGeometry';
import {
    describe,
    expect,
    it,
} from 'vitest';

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
});
