// @vitest-environment happy-dom
import {
    effectScope,
    nextTick,
    ref,
} from 'vue';
import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { IDocumentViewerExpose } from '@app/modules/pdf-viewer/public';
import { useWorkspaceStartupReadiness } from '@app/modules/workspace-shell/composables/useWorkspaceStartupReadiness';

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((nextResolve) => {
        resolve = nextResolve;
    });

    return {
        promise,
        resolve,
    };
}

describe('useWorkspaceStartupReadiness', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('waits for the shared viewer load-settle contract before dispatching startup visual readiness', async () => {
        const readiness = createDeferred();
        const waitForViewerLoadSettled = vi.fn(() => readiness.promise);
        const viewer: IDocumentViewerExpose = {
            getViewerContainer: () => null,
            scrollToPage: vi.fn(),
            waitForViewerLoadSettled,
        };
        const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
        const startupReadiness = useWorkspaceStartupReadiness({documentViewerRef: ref(viewer)});

        startupReadiness.scheduleStartupOpenVisualReady('test-open');

        await nextTick();
        await Promise.resolve();

        expect(waitForViewerLoadSettled).toHaveBeenCalledOnce();
        expect(dispatchEvent).not.toHaveBeenCalled();

        readiness.resolve();

        await vi.waitFor(() => expect(dispatchEvent).toHaveBeenCalledOnce());
        const event = dispatchEvent.mock.calls[0]?.[0] as CustomEvent | undefined;
        expect(event?.type).toBe('evb:startup-open-visual-ready');
        expect(event?.detail).toEqual({
            reason: 'test-open',
            timedOut: false,
        });
    });

    it('suppresses readiness dispatch after its owning scope is disposed', async () => {
        const readiness = createDeferred();
        const viewer = {
            getViewerContainer: () => null,
            scrollToPage: vi.fn(),
            waitForViewerLoadSettled: vi.fn(() => readiness.promise),
        } satisfies IDocumentViewerExpose;
        const dispatchEvent = vi.spyOn(window, 'dispatchEvent');
        const scope = effectScope();
        const startupReadiness = scope.run(() => useWorkspaceStartupReadiness({documentViewerRef: ref(viewer)}));
        if (!startupReadiness) {
            throw new Error('Expected startup readiness scope');
        }
        startupReadiness.scheduleStartupOpenVisualReady('disposed-open');
        await nextTick();
        scope.stop();
        readiness.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(dispatchEvent).not.toHaveBeenCalled();
    });
});
