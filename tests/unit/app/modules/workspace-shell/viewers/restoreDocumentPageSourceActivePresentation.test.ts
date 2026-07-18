// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { restoreDocumentPageSourceActivePresentation } from '@app/modules/workspace-shell/viewers/restoreDocumentPageSourceActivePresentation';

describe('restoreDocumentPageSourceActivePresentation', () => {
    it('retains decoded surfaces and rebuilds stale logical leases', async () => {
        const element = document.createElement('div');
        Object.defineProperties(element, {
            clientHeight: {value: 600},
            clientWidth: {value: 800},
        });
        const connectedImage = document.createElement('img');
        Object.defineProperties(connectedImage, {
            complete: {value: true},
            naturalWidth: {value: 100},
        });
        const metric = {
            heightPoints: 200,
            rotation: 0 as const,
            widthPoints: 100,
        };
        const release = vi.fn();
        const readyState = {
            lease: {release: vi.fn()},
            unsubscribeInvalidation: vi.fn(),
            widthPx: 100,
        };
        const staleState = {
            lease: {release},
            unsubscribeInvalidation: vi.fn(),
            widthPx: 50,
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
        const measureViewport = vi.fn();
        const renderPage = vi.fn().mockResolvedValue(undefined);
        const renderMountedPages = vi.fn().mockResolvedValue(undefined);

        await restoreDocumentPageSourceActivePresentation({
            beginPending,
            getConnectedImage: pageNumber => pageNumber === 1 ? connectedImage : null,
            getCurrentPage: () => 1,
            getPageScale: () => 1,
            getMetric: () => metric,
            getPixelRatio: () => 1,
            getState: pageNumber => states.get(pageNumber),
            isCurrent: () => true,
            markReady,
            measureViewport,
            readElement: () => element,
            readResidentPages: () => [
                1,
                2,
            ],
            renderMountedPages,
            renderPage,
        });

        expect(measureViewport).toHaveBeenCalledOnce();
        expect(markReady).toHaveBeenCalledWith(1, readyState);
        expect(staleState.unsubscribeInvalidation).toBeNull();
        expect(staleState.lease).toBeNull();
        expect(release).toHaveBeenCalledOnce();
        expect(beginPending).toHaveBeenCalledWith(2, staleState);
        expect(renderPage).toHaveBeenCalledWith(1);
        expect(renderMountedPages).toHaveBeenCalledOnce();
    });

    it('keeps an evicted required page as durable render work', async () => {
        const element = document.createElement('div');
        Object.defineProperties(element, {
            clientHeight: {value: 600},
            clientWidth: {value: 800},
        });
        const renderPage = vi.fn().mockResolvedValue(undefined);
        const renderMountedPages = vi.fn().mockResolvedValue(undefined);

        await restoreDocumentPageSourceActivePresentation({
            beginPending: vi.fn(),
            getConnectedImage: () => null,
            getCurrentPage: () => 1057,
            getPageScale: () => 6.47,
            getMetric: () => undefined,
            getPixelRatio: () => 2,
            getState: () => undefined,
            isCurrent: () => true,
            markReady: vi.fn(),
            measureViewport: vi.fn(),
            readElement: () => element,
            readResidentPages: () => [],
            renderMountedPages,
            renderPage,
        });

        expect(renderPage).toHaveBeenCalledWith(1057);
        expect(renderMountedPages).toHaveBeenCalledOnce();
    });
});
