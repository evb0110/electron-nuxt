// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { ref } from 'vue';
import { createPdfInitialVisualCommit } from '@app/modules/pdf-viewer/runtime/lifecycle/createPdfInitialVisualCommit';
import type { TPdfViewportSession } from '@app/modules/pdf-viewer/runtime/sessions/createPdfViewportSession';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import type { IDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import { cast } from '@tests/helpers/cast';

function createResidentCanvasFixture(
    connectCanvas = true,
    canvasRect: Partial<DOMRect> = {},
) {
    const surface = createDocumentOpenSurfaceSession();
    surface.begin({
        documentId: 'saved-result.pdf',
        documentRevision: 'open-intent:1',
    }, null, 2);
    surface.metadataReady(315);

    const viewerContainer = document.createElement('div');
    viewerContainer.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
        top: 0,
        right: 1200,
        bottom: 900,
        left: 0,
        width: 1200,
        height: 900,
    }));
    const pageContainer = document.createElement('div');
    pageContainer.className = 'page_container';
    pageContainer.dataset.page = '2';
    pageContainer.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
        width: 511.459,
        height: 755,
    }));
    const canvasHost = document.createElement('div');
    canvasHost.className = 'page_canvas';
    const canvas = document.createElement('canvas');
    canvas.width = 1023;
    canvas.height = 1510;
    canvas.getBoundingClientRect = vi.fn(() => cast<DOMRect>({
        top: 0,
        right: connectCanvas ? 511.459 : 0,
        bottom: connectCanvas ? 755 : 0,
        left: 0,
        width: connectCanvas ? 511.459 : 0,
        height: connectCanvas ? 755 : 0,
        ...canvasRect,
    }));
    if (connectCanvas) {
        canvasHost.append(canvas);
    }
    pageContainer.append(canvasHost);
    viewerContainer.append(pageContainer);
    document.body.append(viewerContainer);

    const currentPage = ref(2);
    const commitCurrentViewportIfSettled = vi.fn((pageNumber: number) => {
        const snapshot = surface.snapshot.value;
        const viewportIntentId = surface.viewportSession.value.viewportIntent!.id;
        return surface.commitViewport({
            generation: snapshot.generation,
            documentRevision: snapshot.identity!.documentRevision,
            viewportIntentId,
            documentGeometryRevision: 8,
            interactionEpoch: 98,
            pageNumber,
            left: 0,
            top: 0,
        });
    });
    const viewport = cast<TPdfViewportSession>({
        currentPage,
        scale: {scaledMargin: ref(20)},
        openVirtualSurfaceGeometry: {openingVirtualExtentMinimumScrollHeight: ref<number | null>(null)},
        singlePageScroll: {commitCurrentViewportIfSettled},
    });
    const chassisAuthority = cast<IDocumentViewerChassisAuthority>({openSurface: surface});
    const renderOwner = surface.claimRenderOwner();
    const emitInitialVisualReady = vi.fn();
    const initialVisual = createPdfInitialVisualCommit({
        chassisAuthority,
        openSurfaceRenderOwner: renderOwner,
        viewport,
        viewerContainer: ref(viewerContainer),
        renderedPageStateVersion: ref(0),
        isCommittedVisual: pageNumber => pageNumber === 2,
        queueFrame: vi.fn(),
        emitInitialVisualReady,
    });

    return {
        initialVisual,
        commitCurrentViewportIfSettled,
        emitInitialVisualReady,
        surface,
        viewerContainer,
    };
}

describe('createPdfInitialVisualCommit', () => {
    it('adopts a ready resident canvas into a newly opened surface with no committed geometry', () => {
        const fixture = createResidentCanvasFixture();

        fixture.initialVisual.adoptResidentCanvas(2);

        expect(fixture.surface.snapshot.value).toMatchObject({
            generation: 1,
            phase: 'ready',
            presentation: 'committed',
            geometry: {
                width: 511.459,
                height: 755,
                margin: 20,
            },
            committedRender: {
                documentRevision: 'open-intent:1',
                pageNumber: 2,
            },
            committedViewport: {
                documentRevision: 'open-intent:1',
                pageNumber: 2,
            },
        });
        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            requestedPage: 2,
            committedPage: 2,
        });
        expect(fixture.commitCurrentViewportIfSettled).toHaveBeenCalledExactlyOnceWith(2);
        expect(fixture.emitInitialVisualReady).toHaveBeenCalledExactlyOnceWith({pageNumber: 2});

        fixture.initialVisual.adoptResidentCanvas(2);
        expect(fixture.emitInitialVisualReady).toHaveBeenCalledOnce();

        fixture.viewerContainer.remove();
    });

    it('does not start a render fence until resident canvas geometry is measurable', () => {
        const fixture = createResidentCanvasFixture(false);

        fixture.initialVisual.adoptResidentCanvas(2);

        expect(fixture.surface.snapshot.value).toMatchObject({
            phase: 'pending',
            geometry: null,
            committedRender: null,
        });
        expect(fixture.surface.viewportSession.value.renderFence).toBeNull();
        expect(fixture.commitCurrentViewportIfSettled).not.toHaveBeenCalled();
        expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

        fixture.viewerContainer.remove();
    });

    it('does not publish ready when the committed page canvas is painted but physically offscreen', () => {
        const fixture = createResidentCanvasFixture(true, {
            top: 1_440_000,
            bottom: 1_440_755,
        });

        fixture.initialVisual.adoptResidentCanvas(2);

        expect(fixture.surface.snapshot.value.phase).toBe('viewport-committed');
        expect(fixture.surface.viewportSession.value).toMatchObject({
            lifecycle: 'opening',
            committedPage: 2,
        });
        expect(fixture.emitInitialVisualReady).not.toHaveBeenCalled();

        fixture.viewerContainer.remove();
    });
});
