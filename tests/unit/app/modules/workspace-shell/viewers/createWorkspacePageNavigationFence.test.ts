import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { createWorkspacePageNavigationFence } from '@app/modules/workspace-shell/viewers/createWorkspacePageNavigationFence';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

describe('createWorkspacePageNavigationFence', () => {
    it('does not arm a fence for an already-authoritative ready page', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const fence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        });
        expect(fence).not.toBeNull();
        expect(openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        })).toBe(true);
        expect(openSurface.commitCanvas(fence!)).toBe(true);
        expect(openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation: openSurface.snapshot.value.generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: fence!.viewportIntentId,
        })).toBe(true);
        expect(openSurface.markReady(fence!)).toBe(true);

        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(1),
            openSurface,
        });
        navigationFence.begin(1);

        expect(navigationFence.targetPage.value).toBeNull();
        expect(navigationFence.shouldAcceptPage(2)).toBe(true);
    });

    it('releases a genuine target after the surface records physical-input supersession', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const fence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(fence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: fence.viewportIntentId,
        });
        openSurface.markReady(fence);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(1),
            openSurface,
        });

        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        expect(openSurface.observeViewportPage(2, {supersedeNavigation: true})).toBe(2);

        expect(navigationFence.shouldAcceptPage(2)).toBe(true);
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('releases a replay target when a ready surface later moves away from it', () => {
        const openSurface = createDocumentOpenSurfaceSession();
        const generation = openSurface.begin({
            documentId: 'document',
            documentRevision: 'revision',
        });
        openSurface.metadataReady(10);
        const openingFence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 1,
            renderVersion: 1,
            requestId: 1,
        })!;
        openSurface.commitGeometry(generation, {
            height: 100,
            margin: 0,
            width: 100,
        });
        openSurface.commitCanvas(openingFence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 1,
            top: 0,
            viewportIntentId: openingFence.viewportIntentId,
        });
        openSurface.markReady(openingFence);
        const navigationFence = createWorkspacePageNavigationFence({
            currentPage: ref(5),
            openSurface,
        });

        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        navigationFence.begin(5);
        openSurface.requestNavigation(5);
        const settledFence = openSurface.createRenderFence({
            documentRevision: 'revision',
            generation,
            pageNumber: 5,
            renderVersion: 1,
            requestId: 2,
        })!;
        openSurface.commitCanvas(settledFence);
        openSurface.commitViewport({
            documentGeometryRevision: 1,
            documentRevision: 'revision',
            generation,
            interactionEpoch: 0,
            left: 0,
            pageNumber: 5,
            top: 0,
            viewportIntentId: settledFence.viewportIntentId,
        });
        openSurface.markReady(settledFence);
        expect(openSurface.observeViewportPage(6)).toBe(6);
        expect(openSurface.viewportSession.value).toMatchObject({
            lifecycle: 'ready',
            observedPage: 6,
            requestedPage: 5,
        });

        expect(navigationFence.shouldAcceptPage(6)).toBe(true);
        expect(navigationFence.targetPage.value).toBeNull();
    });

    it('retains strict stale-page rejection for a genuine target', () => {
        const navigationFence = createWorkspacePageNavigationFence({currentPage: ref(1)});
        navigationFence.begin(5);

        expect(navigationFence.shouldAcceptPage(4)).toBe(false);
        expect(navigationFence.targetPage.value).toBe(5);
        expect(navigationFence.shouldAcceptPage(5)).toBe(true);
        expect(navigationFence.targetPage.value).toBeNull();
    });
});
