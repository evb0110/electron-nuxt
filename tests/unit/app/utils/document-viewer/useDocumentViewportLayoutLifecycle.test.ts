import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';

function createViewport(scrollTop: number) {
    return {
        clientHeight: 100,
        clientWidth: 100,
        scrollHeight: 2_000,
        scrollLeft: 0,
        scrollTop,
        scrollWidth: 100,
    } as HTMLElement;
}

describe('useDocumentViewportLayoutLifecycle', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('preserves one semantic page anchor across progressive geometry mutations', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(120);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
            {
                top: 240,
                width: 100,
                height: 100,
            },
        ]);
        const writes: number[] = [];
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: epoch => epoch === 1,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.beginLayoutTransaction();
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 800,
                },
                {
                    top: 820,
                    width: 100,
                    height: 100,
                },
                {
                    top: 940,
                    width: 100,
                    height: 100,
                },
            ];
        });
        expect(viewport.scrollTop).toBe(820);

        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 200,
                },
                {
                    top: 220,
                    width: 100,
                    height: 100,
                },
                {
                    top: 340,
                    width: 100,
                    height: 100,
                },
            ];
        });
        await lifecycle.endLayoutTransaction();
        await nextTick();

        expect(viewport.scrollTop).toBe(220);
        expect(writes.at(-1)).toBe(220);
        scope.stop();
    });

    it('retargets an active geometry transaction after viewport navigation', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        const viewport = createViewport(0);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
            {
                top: 240,
                width: 100,
                height: 100,
            },
        ]);
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            captureRestoreEpoch: () => 1,
            canRestore: () => true,
            applyRestoredScroll: restored => {
                viewport.scrollLeft = restored.left;
                viewport.scrollTop = restored.top;
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        lifecycle.beginLayoutTransaction();
        viewport.scrollTop = 240;
        lifecycle.refreshLayoutTransactionAnchor();
        lifecycle.preserveLayoutMutation(() => {
            pageLayouts.value = [
                {
                    top: 0,
                    width: 100,
                    height: 500,
                },
                {
                    top: 520,
                    width: 100,
                    height: 100,
                },
                {
                    top: 640,
                    width: 100,
                    height: 100,
                },
            ];
        });
        await lifecycle.endLayoutTransaction();

        expect(viewport.scrollTop).toBe(640);
        scope.stop();
    });

    it('does not let a stale transaction restore geometry after its successor begins', async () => {
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            frames.push(callback);
            return frames.length;
        });
        const scope = effectScope();
        const viewport = createViewport(120);
        const viewerContainer = ref<HTMLElement | null>(viewport);
        const pageLayouts = ref([
            {
                top: 0,
                width: 100,
                height: 100,
            },
            {
                top: 120,
                width: 100,
                height: 100,
            },
        ]);
        const writes: number[] = [];
        const lifecycle = scope.run(() => useDocumentViewportLayoutLifecycle({
            viewerContainer,
            pageLayouts,
            captureRestoreEpoch: () => 2,
            canRestore: epoch => epoch === 2,
            applyRestoredScroll: restored => {
                viewport.scrollTop = restored.top;
                writes.push(restored.top);
            },
        }));
        if (!lifecycle) throw new Error('Failed to create viewport layout lifecycle');

        const predecessor = lifecycle.beginLayoutTransaction();
        viewport.scrollTop = 0;
        const successor = lifecycle.beginLayoutTransaction();
        await lifecycle.endLayoutTransaction(predecessor, false);
        expect(writes).toEqual([]);

        const endSuccessor = lifecycle.endLayoutTransaction(successor, true);
        await vi.waitFor(() => expect(frames).toHaveLength(1));
        frames.splice(0).forEach(callback => callback(0));
        await endSuccessor;
        expect(writes).not.toContain(120);
        scope.stop();
    });
});
