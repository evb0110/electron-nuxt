import {
    afterEach,
    describe,
    expect,
    it,
} from 'vitest';
import {
    findConnectedDocumentPageImage,
    hasHigherDocumentRenderPriority,
    isOwnedConnectedDocumentPageImage,
    prepareDocumentPageSurface,
    resolveDocumentPageSourceVisual,
    waitForDocumentPageImagePaint,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';

describe('documentPageSourcePresentation', () => {
    afterEach(() => {
        document.body.replaceChildren();
    });

    it('preserves renderer priority promotion order', () => {
        expect(hasHigherDocumentRenderPriority('visible', 'nearby')).toBe(true);
        expect(hasHigherDocumentRenderPriority('nearby', 'visible')).toBe(false);
        expect(hasHigherDocumentRenderPriority('navigation', 'visible')).toBe(true);
    });

    it('uses the shared skeleton for every pending mounted page once a source is active', () => {
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
        })).toBe('skeleton');
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: false,
        })).toBe('none');
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
            state: {
                error: null,
                ready: true,
            },
        })).toBe('fresh');
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
            state: {
                error: 'render failed',
                ready: false,
            },
        })).toBe('error');
    });

    it('honors the shared opening viewport visual before ordinary page state', () => {
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
            state: {
                error: null,
                ready: true,
            },
            viewportVisual: {
                kind: 'page',
                pageNumber: 4,
                presentation: 'skeleton',
            },
        })).toBe('skeleton');
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
            viewportVisual: {
                kind: 'page',
                pageNumber: 4,
                presentation: 'canvas',
            },
        })).toBe('skeleton');
        expect(resolveDocumentPageSourceVisual({
            pageNumber: 4,
            presentPendingAsSkeleton: true,
            viewportVisual: {
                kind: 'page',
                pageNumber: 4,
                presentation: 'prepared-shell',
            },
        })).toBe('none');
    });

    it('finds only the connected image owned by the requested page generation', () => {
        const page = document.createElement('section');
        page.dataset.testid = 'document-page-source-page';
        page.dataset.pageNumber = '4';
        const image = document.createElement('img');
        image.dataset.testid = 'document-page-source-image';
        image.dataset.pageRenderGeneration = '8';
        image.dataset.documentLoadGeneration = '3';
        Object.defineProperties(image, {
            complete: {value: true},
            naturalWidth: {value: 1200},
        });
        page.append(image);
        document.body.append(page);

        expect(isOwnedConnectedDocumentPageImage(image, 4, null)).toBe(true);
        expect(findConnectedDocumentPageImage({
            loadGeneration: 3,
            openingTarget: null,
            pageNumber: 4,
            renderGeneration: 8,
            viewerContainer: document.body,
        })).toBe(image);
        expect(findConnectedDocumentPageImage({
            loadGeneration: 4,
            openingTarget: null,
            pageNumber: 4,
            renderGeneration: 8,
            viewerContainer: document.body,
        })).toBeNull();
    });

    it('aborts paint waits synchronously', async () => {
        const controller = new AbortController();
        controller.abort();
        expect(await waitForDocumentPageImagePaint(document.createElement('img'), controller.signal)).toBe(false);
    });

    it('accepts an existing canvas surface and rejects an aborted preparation', async () => {
        const canvas = document.createElement('canvas');
        await expect(prepareDocumentPageSurface(canvas, new AbortController().signal))
            .resolves.toBeUndefined();
        const controller = new AbortController();
        controller.abort();
        await expect(prepareDocumentPageSurface(canvas, controller.signal))
            .rejects.toMatchObject({name: 'AbortError'});
    });
});
// @vitest-environment happy-dom
