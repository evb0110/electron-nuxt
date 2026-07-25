// @vitest-environment happy-dom

import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
} from 'vue';
import { createDocumentViewerChassisAuthority } from '@app/utils/document-viewer/chassis/documentViewerChassisAuthority';
import type { IDocumentOpenSurfaceRenderFence } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';
import { usePdfInitialCanvasCommitCoordinator } from '@app/modules/pdf-viewer/runtime/lifecycle/usePdfInitialCanvasCommitCoordinator';

function createHarness() {
    const authority = createDocumentViewerChassisAuthority(ref('pdf'));
    const currentPage = ref(1);
    const scope = effectScope();
    const coordinator = scope.run(() => usePdfInitialCanvasCommitCoordinator({
        chassisAuthority: authority,
        currentPage,
    }))!;
    return {
        authority,
        coordinator,
        currentPage,
        scope,
    };
}

function commitGeometryAndCreateFence(harness: ReturnType<typeof createHarness>, generation: number) {
    harness.authority.openSurface.commitGeometry(generation, {
        width: 612,
        height: 792,
        margin: 20,
    });
    return harness.authority.openSurface.createRenderFence({
        generation,
        documentRevision: 'revision-1',
        renderVersion: 1,
        requestId: 1,
        pageNumber: 1,
    })!;
}

function createViewportCommit(fence: IDocumentOpenSurfaceRenderFence) {
    return {
        generation: fence.generation,
        documentRevision: fence.documentRevision,
        viewportIntentId: fence.viewportIntentId,
        documentGeometryRevision: 1,
        interactionEpoch: 0,
        pageNumber: 1,
        left: 0,
        top: 0,
    };
}

describe('usePdfInitialCanvasCommitCoordinator', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('keeps a delayed canvas commit eligible without a wall-clock failure', async () => {
        vi.useFakeTimers();
        const harness = createHarness();
        const generation = harness.authority.openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(generation);
        const committed = harness.coordinator.waitForCanvas(1);

        await vi.advanceTimersByTimeAsync(60_000);

        expect(harness.authority.openSurface.snapshot.value.phase).toBe('pending');
        expect(harness.authority.openSurface.snapshot.value.failure).toBeNull();
        harness.coordinator.resolveCanvas(generation, 1);
        await expect(committed).resolves.toBeUndefined();
        harness.scope.stop();
    });

    it('rejects a stale generation without resolving its successor', async () => {
        const harness = createHarness();
        const firstGeneration = harness.authority.openSurface.begin({
            documentId: 'first.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(firstGeneration);
        const firstCommit = harness.coordinator.waitForCanvas(1);
        const secondGeneration = harness.authority.openSurface.begin({
            documentId: 'second.pdf',
            documentRevision: 'revision-2',
        });
        harness.coordinator.begin(secondGeneration);
        const secondCommit = harness.coordinator.waitForCanvas(1);
        let successorSettled = false;
        void secondCommit.then(() => { successorSettled = true; });

        await expect(firstCommit).rejects.toThrow('superseded');
        harness.coordinator.resolveCanvas(firstGeneration, 1);
        await Promise.resolve();
        expect(successorSettled).toBe(false);

        harness.coordinator.resolveCanvas(secondGeneration, 1);
        await expect(secondCommit).resolves.toBeUndefined();
        harness.scope.stop();
    });

    it('observes a canvas that committed before the load lifecycle claimed the generation', async () => {
        const harness = createHarness();
        const generation = harness.authority.openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'open-intent:1',
        });
        harness.authority.openSurface.commitGeometry(generation, {
            width: 612,
            height: 792,
            margin: 20,
        });
        const fence = harness.authority.openSurface.createRenderFence({
            generation,
            documentRevision: 'open-intent:1',
            renderVersion: 1,
            requestId: 1,
            pageNumber: 1,
        })!;
        harness.authority.openSurface.commitCanvas(fence);

        harness.coordinator.begin(generation);
        await expect(harness.coordinator.waitForCanvas(1)).resolves.toBeUndefined();
        harness.scope.stop();
    });

    it('settles an initial wait on the latest same-generation navigation page', async () => {
        const harness = createHarness();
        const generation = harness.authority.openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(generation);
        const committed = harness.coordinator.waitForCanvas(1);
        let settled = false;
        void committed.then(() => { settled = true; });

        harness.currentPage.value = 6;
        harness.coordinator.resolveCanvas(generation, 1);
        await Promise.resolve();
        expect(settled).toBe(false);

        harness.coordinator.resolveCanvas(generation, 6);
        await expect(committed).resolves.toBeUndefined();
        harness.scope.stop();
    });

    it.each([
        'canvas-first',
        'viewport-first',
    ] as const)('converges matching initial fences when %s commits', (order) => {
        const harness = createHarness();
        const generation = harness.authority.openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(generation);
        const fence = commitGeometryAndCreateFence(harness, generation);
        const emitted = vi.fn(() => {
            expect(harness.authority.openSurface.snapshot.value.phase).toBe('ready');
            return true;
        });
        const commitCanvas = () => {
            expect(harness.authority.openSurface.commitCanvas(fence)).toBe(true);
            harness.coordinator.resolveCanvas(generation, 1);
            harness.coordinator.tryComplete(1, emitted);
        };
        const commitViewport = () => {
            expect(harness.authority.openSurface.commitViewport(createViewportCommit(fence))).toBe(true);
            harness.coordinator.tryComplete(1, emitted);
        };

        if (order === 'canvas-first') {
            commitCanvas();
            commitViewport();
        } else {
            commitViewport();
            commitCanvas();
        }

        expect(harness.authority.openSurface.snapshot.value.phase).toBe('ready');
        expect(emitted).toHaveBeenCalledOnce();
        harness.scope.stop();
    });

    it('does not let a rejected legacy notification veto an authoritative ready surface', () => {
        const harness = createHarness();
        const generation = harness.authority.openSurface.begin({
            documentId: 'scan.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(generation);
        const fence = commitGeometryAndCreateFence(harness, generation);
        harness.authority.openSurface.commitCanvas(fence);
        harness.coordinator.resolveCanvas(generation, 1);
        harness.authority.openSurface.commitViewport(createViewportCommit(fence));
        const emitted = vi.fn(() => false);

        expect(harness.coordinator.tryComplete(1, emitted)).toBe(true);
        expect(harness.authority.openSurface.snapshot.value.phase).toBe('ready');
        expect(emitted).toHaveBeenCalledOnce();
        harness.scope.stop();
    });

    it('does not let a stale completion terminalize a successor generation', () => {
        const harness = createHarness();
        const firstGeneration = harness.authority.openSurface.begin({
            documentId: 'first.pdf',
            documentRevision: 'revision-1',
        });
        harness.coordinator.begin(firstGeneration);
        const firstFence = commitGeometryAndCreateFence(harness, firstGeneration);
        harness.authority.openSurface.commitCanvas(firstFence);
        harness.coordinator.resolveCanvas(firstGeneration, 1);
        harness.authority.openSurface.commitViewport(createViewportCommit(firstFence));
        const emitted = vi.fn(() => true);

        const secondGeneration = harness.authority.openSurface.begin({
            documentId: 'second.pdf',
            documentRevision: 'revision-2',
        });
        harness.coordinator.begin(secondGeneration);
        expect(harness.coordinator.tryComplete(1, emitted)).toBe(false);

        expect(harness.authority.openSurface.snapshot.value.generation).toBe(secondGeneration);
        expect(harness.authority.openSurface.snapshot.value.phase).toBe('pending');
        expect(emitted).not.toHaveBeenCalled();
        harness.scope.stop();
    });
});
