import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    captureDocumentZoomAnchor,
    resolveDocumentZoomAnchorScroll,
    resolveRetainedDocumentZoomAnchor,
} from '@app/utils/document-viewer/zoomAnchor';

describe('document zoom anchor', () => {
    it('preserves the page-relative viewport center across reflow', () => {
        const viewport = {
            clientHeight: 400,
            clientWidth: 500,
            scrollLeft: 0,
            scrollTop: 600,
        };
        const anchor = captureDocumentZoomAnchor(viewport, [
            {
                top: 16,
                width: 400,
                height: 1_000,
            },
            {
                top: 1_032,
                width: 400,
                height: 1_000,
            },
        ]);
        expect(anchor).toMatchObject({
            pageIndex: 0,
            yRatio: 0.784,
        });

        const restored = resolveDocumentZoomAnchorScroll(viewport, [
            {
                top: 16,
                width: 800,
                height: 2_000,
            },
            {
                top: 2_032,
                width: 800,
                height: 2_000,
            },
        ], anchor);
        expect(restored).toEqual({
            left: 150,
            top: 1_384,
        });
        expect(viewport.scrollTop).toBe(600);
        expect(viewport.scrollLeft).toBe(0);
    });

    it('retains a latent anchor when a narrow viewport clamps its scroll', () => {
        const layouts = [{
            top: 20,
            width: 300,
            height: 400,
        }];
        const retained = {
            pageIndex: 0,
            xRatio: 0.5,
            yRatio: 0.8,
        };
        const viewport = {
            clientHeight: 600,
            clientWidth: 360,
            scrollHeight: 440,
            scrollLeft: 0,
            scrollTop: 0,
            scrollWidth: 360,
        };

        expect(resolveRetainedDocumentZoomAnchor(viewport, layouts, retained)).toBe(retained);
        viewport.scrollTop = 20;
        viewport.scrollHeight = 800;
        expect(resolveRetainedDocumentZoomAnchor(viewport, layouts, retained)).not.toBe(retained);
    });
});
