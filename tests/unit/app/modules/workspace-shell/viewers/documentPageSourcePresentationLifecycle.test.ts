// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { TDocumentRef } from '@contracts/documentRef';
import {
    createDocumentPageSourcePresentation,
    type IDocumentPageSourceVisualState,
} from '@app/modules/workspace-shell/viewers/documentPageSourcePresentation';
import type {
    IDocumentPageSource,
    IDocumentSurfaceLease,
} from '@app/utils/document-viewer/source/documentPageSource';
import type { IDocumentViewerRenderSession } from '@app/utils/document-viewer/chassis/createDocumentViewerRenderCoordinator';
import { cast } from '@tests/helpers/cast';

function createPresentationHarness() {
    const documentRef = '/documents/scan.djvu' as TDocumentRef;
    const viewport = document.createElement('div');
    Object.defineProperties(viewport, {
        clientHeight: {value: 600},
        clientWidth: {value: 800},
    });
    const page = document.createElement('section');
    page.dataset.testid = 'document-page-source-page';
    page.dataset.pageNumber = '1';
    const image = document.createElement('img');
    image.dataset.testid = 'document-page-source-image';
    image.dataset.documentLoadGeneration = '1';
    image.dataset.pageRenderGeneration = '1';
    Object.defineProperties(image, {
        complete: {value: true},
        naturalWidth: {value: 100},
    });
    page.append(image);
    viewport.append(page);
    document.body.append(viewport);
    const fence = Object.freeze({
        documentRevision: 'revision-a',
        loadGeneration: 1,
        openSurfaceGeneration: null,
        src: documentRef,
    });
    const loadController = new AbortController();
    const oldRelease = vi.fn();
    const oldLease: IDocumentSurfaceLease = {
        bytes: 40_000,
        heightPx: 100,
        release: oldRelease,
        surface: 'old-surface',
        widthPx: 100,
    };
    let resolveReplacement!: (lease: IDocumentSurfaceLease) => void;
    const replacement = new Promise<IDocumentSurfaceLease>((resolve) => {
        resolveReplacement = resolve;
    });
    const source: IDocumentPageSource = {
        dispose: vi.fn(),
        documentRef,
        getPageMetrics: vi.fn(async () => ({
            heightPoints: 100,
            rotation: 0 as const,
            widthPoints: 100,
        })),
        kind: 'djvu',
        pageCount: 1,
        renderPage: vi.fn(() => replacement),
    };
    const renderSession = cast<IDocumentViewerRenderSession>({
        releasePage: vi.fn(),
        runPageRender: async (
            _pageNumber: number,
            render: (generation: number) => Promise<IDocumentSurfaceLease>,
        ) => ({
            committed: true,
            generation: 2,
            value: await render(2),
        }),
    });
    const renderMountedPages = vi.fn(async () => {});
    const presentation = createDocumentPageSourcePresentation({
        chassisAuthority: null,
        emit: vi.fn(),
        ensureExactPageMetric: vi.fn(async () => ({
            heightPoints: 100,
            rotation: 0 as const,
            widthPoints: 100,
        })),
        flushMetricPublication: vi.fn(),
        getOpeningTarget: () => null,
        hasPendingMetric: () => false,
        isFenceCurrent: candidate => candidate === fence,
        openSurfaceRenderOwner: undefined,
        readContinuousScroll: () => false,
        readCurrentPage: () => 1,
        readFence: () => fence,
        readIsActive: () => true,
        readLoadSignal: () => loadController.signal,
        readMetric: () => ({
            heightPoints: 100,
            rotation: 0,
            widthPoints: 100,
        }),
        readPageScale: () => 2,
        readPixelRatio: () => 1,
        readRenderDemand: () => ({
            bufferPages: [],
            residentPages: [1],
            visiblePages: [1],
        }),
        readSource: () => source,
        readViewport: () => viewport,
        readViewportScrollDirection: () => 0,
        renderSession,
        scheduleRender: vi.fn(),
    });
    const state: IDocumentPageSourceVisualState = reactive({
        error: null,
        generation: 1,
        lease: oldLease,
        priority: 'navigation',
        ready: true,
        retryCount: 0,
        unsubscribeInvalidation: null,
        widthPx: 100,
    });
    presentation.pageStates.set(1, state);
    return {
        fence,
        image,
        oldLease,
        oldRelease,
        presentation,
        renderMountedPages,
        resolveReplacement,
        source,
        viewport,
    };
}

describe('document page-source presentation lifecycle', () => {
    it('retains a painted lease through restore until its replacement commits', async () => {
        const harness = createPresentationHarness();
        const transition = {
            fence: harness.fence,
            isCurrent: () => true,
            kind: 'restore' as const,
        };
        const restore = harness.presentation.restore(transition, {
            measureViewport: vi.fn(),
            renderMountedPages: harness.renderMountedPages,
        });
        await vi.waitFor(() => expect(harness.source.renderPage).toHaveBeenCalledOnce());
        expect(harness.oldRelease).not.toHaveBeenCalled();
        expect(harness.presentation.getState(1)?.lease?.surface).toBe(harness.oldLease.surface);

        const replacementLease: IDocumentSurfaceLease = {
            bytes: 160_000,
            heightPx: 200,
            release: vi.fn(),
            surface: document.createElement('canvas'),
            widthPx: 200,
        };
        harness.resolveReplacement(replacementLease);
        await restore;

        expect(harness.oldRelease).toHaveBeenCalledOnce();
        expect(harness.presentation.getState(1)?.lease?.surface).toBe(replacementLease.surface);
        expect(harness.renderMountedPages).toHaveBeenCalledOnce();
        harness.viewport.remove();
    });
});
