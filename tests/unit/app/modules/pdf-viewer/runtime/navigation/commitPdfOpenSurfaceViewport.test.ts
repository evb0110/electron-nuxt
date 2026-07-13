import {
    describe,
    expect,
    it,
} from 'vitest';
import { commitPdfOpenSurfaceViewport } from '@app/modules/pdf-viewer/runtime/navigation/commitPdfOpenSurfaceViewport';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

describe('commitPdfOpenSurfaceViewport', () => {
    it('settles the exact live surface intent instead of copying a PDF-local intent id', () => {
        const surface = createDocumentOpenSurfaceSession();
        const generation = surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        expect(surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const renderFence = surface.createRenderFence({
            generation,
            documentRevision: 'load:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        });
        expect(renderFence).not.toBeNull();
        expect(surface.commitCanvas(renderFence!)).toBe(true);

        expect(commitPdfOpenSurfaceViewport(surface, {
            intentId: 'viewport-observed-1',
            documentRevision: 1,
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(true);

        expect(surface.snapshot.value.committedViewport).toMatchObject({
            pageNumber: 1,
            viewportIntentId: renderFence!.viewportIntentId,
            documentGeometryRevision: 7,
        });
        expect(surface.snapshot.value.phase).toBe('viewport-committed');
        expect(surface.markReady(renderFence!)).toBe(true);
        expect(surface.snapshot.value.phase).toBe('ready');
    });

    it('does not relabel a stale page position with a newer surface intent', () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:1',
        });
        surface.requestNavigation(2, 0);

        expect(commitPdfOpenSurfaceViewport(surface, {
            intentId: 'stale-pdf-intent',
            documentRevision: 1,
            geometryRevision: 7,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(false);
        expect(surface.snapshot.value.committedViewport).toBeNull();
    });

    it('commits after close and reopen under the shared generation', () => {
        const surface = createDocumentOpenSurfaceSession();
        surface.begin({
            documentId: 'first.pdf',
            documentRevision: 'load:1',
        });
        surface.reset();
        const generation = surface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'load:2',
        });
        expect(surface.viewportSession.value.generation).toBe(generation);
        expect(surface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        })).toBe(true);
        const renderFence = surface.createRenderFence({
            generation,
            documentRevision: 'load:2',
            renderVersion: 2,
            requestId: 2,
            pageNumber: 1,
        });
        expect(renderFence).not.toBeNull();
        expect(surface.commitCanvas(renderFence!)).toBe(true);

        expect(commitPdfOpenSurfaceViewport(surface, {
            intentId: 'viewport-observed-2',
            documentRevision: 2,
            geometryRevision: 8,
            interactionEpoch: 0,
            page: 1,
            left: 0,
            top: 0,
        })).toBe(true);
        expect(surface.snapshot.value.committedViewport?.pageNumber).toBe(1);
    });
});
