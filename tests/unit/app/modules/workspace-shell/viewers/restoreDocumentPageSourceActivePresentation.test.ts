import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { restoreDocumentPageSourceActivePresentation } from '@app/modules/workspace-shell/viewers/restoreDocumentPageSourceActivePresentation';

describe('restoreDocumentPageSourceActivePresentation', () => {
    it('retains decoded surfaces and rebuilds stale logical leases', async () => {
        const release = vi.fn();
        const readyState = {
            lease: {release: vi.fn()},
            unsubscribeInvalidation: vi.fn(),
        };
        const staleState = {
            lease: {release},
            unsubscribeInvalidation: vi.fn(),
        };
        const states = new Map([
            [
                1,
                readyState,
            ],
            [
                2,
                staleState,
            ],
        ]);
        const markReady = vi.fn();
        const beginPending = vi.fn();
        const renderMountedPages = vi.fn().mockResolvedValue(undefined);

        await restoreDocumentPageSourceActivePresentation({
            beginPending,
            getState: pageNumber => states.get(pageNumber),
            hasDecodedConnectedSurface: pageNumber => pageNumber === 1,
            isCurrent: () => true,
            markReady,
            measureViewport: vi.fn(),
            nextRenderTick: () => Promise.resolve(),
            renderMountedPages,
            residentPages: [
                1,
                2,
            ],
        });

        expect(markReady).toHaveBeenCalledWith(1, readyState);
        expect(staleState.unsubscribeInvalidation).toBeNull();
        expect(staleState.lease).toBeNull();
        expect(release).toHaveBeenCalledOnce();
        expect(beginPending).toHaveBeenCalledWith(2, staleState);
        expect(renderMountedPages).toHaveBeenCalledOnce();
    });
});
