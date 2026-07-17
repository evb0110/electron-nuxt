// @vitest-environment happy-dom

import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    effectScope,
    ref,
    shallowRef,
} from 'vue';
import type { PDFDocumentProxy } from '@app/types/pdfContracts';
import { buildPageLayoutMetrics } from '@app/modules/pdf-viewer/engine/pdf-page-layout/buildPageLayoutMetrics';
import { createPdfPageSlotRegistry } from '@app/modules/pdf-viewer/runtime/page-slots/pdfPageSlotRegistry';
import { usePdfSinglePageNavigationController } from '@app/modules/pdf-viewer/runtime/navigation/usePdfSinglePageNavigationController';
import { createTestPdfViewportWritePort } from '@tests/helpers/createTestPdfViewportWritePort';

function createDeferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}

describe('usePdfSinglePageNavigationController', () => {
    it('uses page-local scroll coordinates in paged mode instead of the cumulative document track', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 840},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(false),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as PDFDocumentProxy),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(3)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(3);
            });
            expect(layout.pageTops[2]).toBeGreaterThan(viewer.scrollHeight);
            expect(viewportWrites.writes.at(-1)?.top).toBe(0);
            expect(viewer.scrollTop).toBe(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('accumulates sustained paged wheel intent while earlier pages are still preparing', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollHeight: {value: 700},
            scrollWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        const pageSlots = createPdfPageSlotRegistry();
        for (let pageNumber = 1; pageNumber <= 5; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
            pageSlots.markMounted(pageNumber);
        }
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 5}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 5,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const preparation = createDeferred();
        const viewportWrites = createTestPdfViewportWritePort();
        const preventDefault = vi.fn();
        const requestSurfacePageNavigation = vi.fn((page: number) => page);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(5),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(false),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 5} as PDFDocumentProxy),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                preparePagedNavigationLayout: async () => preparation.promise,
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                requestSurfacePageNavigation,
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            for (const timeStamp of [
                1_000,
                1_200,
                1_400,
            ]) {
                expect(controller.handleWheel({
                    deltaX: 0,
                    deltaY: 180,
                    preventDefault,
                    timeStamp,
                })).toBe(true);
            }
            expect(controller.navigationAnchorPage.value).toBe(4);
            expect(controller.viewportAuthority.currentPage.value).toBe(1);
            expect(preventDefault).toHaveBeenCalledTimes(3);
            expect(requestSurfacePageNavigation.mock.calls).toEqual([
                [2],
                [3],
                [4],
            ]);

            preparation.resolve();
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.currentPage.value).toBe(4);
            });
            expect(viewportWrites.writes).toHaveLength(1);
            expect(controller.handleWheel({
                deltaX: 0,
                deltaY: 0,
                preventDefault,
                timeStamp: 1_600,
            })).toBe(false);
            expect(requestSurfacePageNavigation).toHaveBeenCalledTimes(3);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('anchors zoom to the viewport authority page while the outer requested page lags', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
            scrollLeft: {
                value: 0,
                writable: true,
            },
            scrollTop: {
                value: 0,
                writable: true,
            },
        });
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const currentPage = ref(1);
        const requestedCurrentPage = ref<number | undefined>(1);
        const isResizeTransitionActive = ref(false);
        const viewportWrites = createTestPdfViewportWritePort();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isResizeTransitionActive,
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 2} as PDFDocumentProxy),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 2,
                }),
                emitCurrentPage: page => { currentPage.value = page; },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            await expect(controller.submitViewportStateIntent('fit')).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 1},
            });
            expect(controller.viewportAuthority.currentPage.value).toBe(1);

            viewer.scrollTop = 850;
            isResizeTransitionActive.value = true;
            controller.handleScroll({isTrusted: true} as Event);
            expect(controller.viewportAuthority.currentPage.value).toBe(1);
            expect(controller.currentPageAuthority.canSyncFromViewport()).toBe(false);
            isResizeTransitionActive.value = false;
            const livePageTwoAnchor = controller.captureCurrentSemanticAnchor();
            expect(livePageTwoAnchor?.page).toBe(2);
            controller.viewportAuthority.observeUserScroll(livePageTwoAnchor!);
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(requestedCurrentPage.value).toBe(1);
            const zoom = controller.submitViewportStateIntent('zoom', {zoom: 5.03});
            expect(controller.viewportAuthority.activeIntent.value?.anchor?.page).toBe(2);
            const zoomIntentId = controller.viewportAuthority.activeIntent.value?.id;
            controller.handleScroll(undefined, true);
            expect(controller.viewportAuthority.activeIntent.value?.id).toBe(zoomIntentId);
            controller.handleScroll({isTrusted: true} as Event);
            expect(controller.viewportAuthority.activeIntent.value?.id).toBe(zoomIntentId);
            expect(controller.shouldCancelProgrammaticNavigationForViewportScroll()).toBe(false);
            controller.cancelDestinationNavigationTarget();
            expect(controller.viewportAuthority.activeIntent.value?.id).toBe(zoomIntentId);
            await expect(zoom).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 2},
            });
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('transfers an unresolved page destination into an immediate fit intent', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
        });
        for (let pageNumber = 1; pageNumber <= 2; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container page_container--rendered';
            page.dataset.page = String(pageNumber);
            page.innerHTML = '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        const metricPreparation = createDeferred();
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 2}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 2,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();
        const requestedCurrentPage = ref<number | undefined>(1);
        const emittedCurrentPage = ref(1);
        const ensurePageMetricsInRange = vi.fn(async () => {
            await metricPreparation.promise;
            return false;
        });

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(2),
                currentPage: emittedCurrentPage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 2} as PDFDocumentProxy),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                isPageFreshlyRenderedForNavigation: vi.fn(() => true),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: page => {
                    emittedCurrentPage.value = page;
                    requestedCurrentPage.value = page;
                },
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                ensurePageMetricsInRange,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(2)).toBe(true);
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.pendingTargetPage.value).toBe(2);
            });
            expect(controller.viewportAuthority.currentPage.value).toBe(1);

            const fit = controller.submitViewportStateIntent('fit');
            expect(controller.viewportAuthority.activeIntent.value).toMatchObject({
                kind: 'fit',
                anchor: {page: 2},
                navigation: {target: {
                    kind: 'page',
                    page: 2,
                }},
            });
            expect(controller.viewportAuthority.pendingAnchorPage.value).toBe(2);
            metricPreparation.resolve();

            await expect(fit).resolves.toMatchObject({
                outcome: 'settled',
                positionCommit: {page: 2},
            });
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.getTerminalOutcome('viewport-navigation-1'))
                    .toBe('cancelled');
            });
            expect(viewportWrites.writes).toHaveLength(1);
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(emittedCurrentPage.value).toBe(2);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('prepares only the latest rapid navigation target before committing its viewport', async () => {
        const scope = effectScope();
        const viewer = document.createElement('div');
        Object.defineProperties(viewer, {
            clientHeight: {value: 700},
            clientWidth: {value: 900},
        });
        for (let pageNumber = 1; pageNumber <= 3; pageNumber += 1) {
            const page = document.createElement('div');
            page.className = 'page_container';
            page.dataset.page = String(pageNumber);
            page.innerHTML = pageNumber === 1
                ? '<div class="page_canvas"><canvas width="600" height="800"></canvas></div>'
                : '<div class="document-page-skeleton"></div>';
            viewer.append(page);
        }
        const pageSlots = createPdfPageSlotRegistry();
        pageSlots.markMounted(1);
        pageSlots.markMounted(2);
        pageSlots.markMounted(3);
        const firstPreparation = createDeferred();
        const freshPages = new Set([1]);
        const prepareNavigationVisual = vi.fn(async (range: {
            start: number;
            end: number;
        }) => {
            if (range.start === 2) {
                await firstPreparation.promise;
            }
            const target = viewer.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            target?.querySelector('.document-page-skeleton')?.remove();
            const layer = document.createElement('div');
            layer.className = 'page_canvas';
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 800;
            layer.append(canvas);
            target?.append(layer);
            freshPages.add(range.start);
        });
        const layout = buildPageLayoutMetrics({
            pageMetrics: Array.from({length: 3}, () => ({
                width: 600,
                height: 800,
            })),
            totalPages: 3,
            viewMode: 'single',
            scale: 1,
            gap: 20,
            paddingTop: 20,
            paddingBottom: 20,
            fallbackWidth: null,
            fallbackHeight: null,
        });
        if (!layout) {
            throw new Error('Expected PDF layout metrics');
        }
        const viewportWrites = createTestPdfViewportWritePort();
        const emitCurrentPage = vi.fn();

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: ref(viewer),
                numPages: ref(3),
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading: ref(false),
                pdfDocument: shallowRef({numPages: 3} as PDFDocumentProxy),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: prepareNavigationVisual,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(2)).toBe(true);
            await vi.waitFor(() => {
                expect(prepareNavigationVisual).toHaveBeenCalledWith(
                    {
                        start: 2,
                        end: 2,
                    },
                );
            });
            expect(viewportWrites.writes).toHaveLength(1);
            expect(controller.viewportAuthority.currentPage.value).toBe(2);
            expect(controller.navigationState.value).toMatchObject({
                source: 'continuous',
                status: 'settling',
                targetPage: 2,
            });
            expect(viewer.querySelector('[data-page="1"] canvas')).not.toBeNull();
            expect(viewer.querySelector('[data-page="2"] .document-page-skeleton')).not.toBeNull();

            expect(controller.scrollToPage(3)).toBe(true);
            await vi.waitFor(() => {
                expect(viewportWrites.writes).toHaveLength(2);
            });
            expect(controller.viewportAuthority.currentPage.value).toBe(3);
            expect(controller.navigationState.value.status).toBe('idle');
            expect(freshPages.has(3)).toBe(true);
            expect(viewer.querySelector('[data-page="3"] .document-page-skeleton')).toBeNull();
            expect(viewer.querySelector('[data-page="3"] canvas')).not.toBeNull();

            firstPreparation.resolve();
            await vi.waitFor(() => {
                expect(controller.viewportAuthority.getTerminalOutcome('viewport-navigation-1'))
                    .toBe('cancelled');
            });
            expect(viewportWrites.writes).toHaveLength(2);
            expect(emitCurrentPage).toHaveBeenLastCalledWith(3);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('preserves the latest pre-operational Next target across an early fit intent and replays it once', async () => {
        const scope = effectScope();
        const viewerRef = ref<HTMLElement | null>(null);
        const numPages = ref(0);
        const isLoading = ref(true);
        const pageSlots = createPdfPageSlotRegistry();
        const pdfDocument = shallowRef<PDFDocumentProxy | null>(null);
        const viewportWrites = createTestPdfViewportWritePort();
        const navigationFeedback = vi.fn();
        const committedWorkspacePage = ref(1);
        const requestedCurrentPage = ref<number | undefined>(1);
        const freshPages = new Set<number>();
        const documentRevision = ref(0);
        const geometryRevision = ref(0);
        let layout: ReturnType<typeof buildPageLayoutMetrics> = null;
        const prepareNavigationVisual = vi.fn(async (range: {
            start: number;
            end: number
        }) => {
            const target = viewerRef.value?.querySelector<HTMLElement>(
                `.page_container[data-page="${String(range.start)}"]`,
            );
            target?.querySelector('.document-page-skeleton')?.remove();
            const layer = document.createElement('div');
            layer.className = 'page_canvas';
            const canvas = document.createElement('canvas');
            canvas.width = 600;
            canvas.height = 800;
            layer.append(canvas);
            target?.append(layer);
            freshPages.add(range.start);
        });

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: viewerRef,
                numPages,
                currentPage: committedWorkspacePage,
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading,
                pdfDocument,
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: prepareNavigationVisual,
                isPageFreshlyRenderedForNavigation: pageNumber => freshPages.has(pageNumber),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: page => {
                    committedWorkspacePage.value = page;
                },
                emitNavigationFeedbackPage: navigationFeedback,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => layout,
                requestedCurrentPage,
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => documentRevision.value,
                getGeometryRevision: () => geometryRevision.value,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            for (let requestedPage = 2; requestedPage <= 6; requestedPage += 1) {
                requestedCurrentPage.value = requestedPage;
                await nextTick();
            }
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(navigationFeedback).toHaveBeenLastCalledWith(6);
            expect(committedWorkspacePage.value).toBe(1);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);

            // A ResizeObserver callback can arrive during the same
            // pre-operational window while a split pane is mounting. It must
            // be ignored without rejecting into the renderer process.
            const staleResize = controller.submitViewportStateIntent('resize');
            await expect(staleResize).resolves.toMatchObject({outcome: 'cancelled'});

            const staleFit = controller.submitViewportStateIntent('fit');
            await expect(staleFit).resolves.toMatchObject({outcome: 'cancelled'});
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);

            // Loading flags briefly settle before the PDF document and page
            // count are published. That transient idle shape is not a session
            // close and must not erase the latest command.
            isLoading.value = false;
            await nextTick();
            expect(controller.navigationAnchorPage.value).toBe(6);
            expect(navigationFeedback).toHaveBeenLastCalledWith(6);

            const viewer = document.createElement('div');
            Object.defineProperties(viewer, {
                clientHeight: {value: 700},
                clientWidth: {value: 900},
            });
            for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
                const page = document.createElement('div');
                page.className = 'page_container';
                page.dataset.page = String(pageNumber);
                page.innerHTML = '<div class="document-page-skeleton"></div>';
                viewer.append(page);
            }
            layout = buildPageLayoutMetrics({
                pageMetrics: Array.from({length: 10}, () => ({
                    width: 600,
                    height: 800,
                })),
                totalPages: 10,
                viewMode: 'single',
                scale: 1,
                gap: 20,
                paddingTop: 20,
                paddingBottom: 20,
                fallbackWidth: null,
                fallbackHeight: null,
            });
            pageSlots.markMounted(6);
            viewerRef.value = viewer;
            numPages.value = 10;
            geometryRevision.value = 2;

            await nextTick();
            expect(viewportWrites.writes).toHaveLength(0);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();

            pdfDocument.value = {numPages: 10} as PDFDocumentProxy;
            documentRevision.value = 2;
            isLoading.value = false;

            await vi.waitFor(() => {
                expect(viewportWrites.writes).toHaveLength(1);
            });
            expect(prepareNavigationVisual).toHaveBeenCalledOnce();
            expect(prepareNavigationVisual).toHaveBeenCalledWith(
                {
                    start: 6,
                    end: 6,
                },
            );
            expect(controller.viewportAuthority.currentPage.value).toBe(6);
            expect(committedWorkspacePage.value).toBe(6);
            expect(viewportWrites.writes[0]?.top).toBeGreaterThan(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });

    it('cancels a queued pre-metadata target only through an explicit lifecycle command', async () => {
        const scope = effectScope();
        const viewerRef = ref<HTMLElement | null>(null);
        const numPages = ref(0);
        const isLoading = ref(true);
        const pageSlots = createPdfPageSlotRegistry();
        const viewportWrites = createTestPdfViewportWritePort();
        const navigationFeedback = vi.fn();
        const prepareNavigationVisual = vi.fn(async () => undefined);

        try {
            const controller = scope.run(() => usePdfSinglePageNavigationController({
                viewerContainer: viewerRef,
                numPages,
                currentPage: ref(1),
                scaledMargin: ref(20),
                viewMode: ref('single'),
                continuousScroll: ref(true),
                isLoading,
                pdfDocument: shallowRef(null),
                getMostVisiblePage: vi.fn(() => 1),
                scrollToPageInternal: vi.fn(),
                updateVisibleRange: vi.fn(),
                updateCurrentPage: vi.fn(() => 1),
                renderVisiblePages: vi.fn(async () => undefined),
                visibleRange: ref({
                    start: 1,
                    end: 1,
                }),
                emitCurrentPage: vi.fn(),
                emitNavigationFeedbackPage: navigationFeedback,
                viewportWritePort: viewportWrites.port,
                getPageLayoutMetrics: () => null,
                requestedCurrentPage: ref(undefined),
                cancelPendingSearchScroll: vi.fn(),
                pageSlots,
                getDocumentRevision: () => 1,
                getGeometryRevision: () => 1,
            }));
            if (!controller) {
                throw new Error('Expected navigation controller');
            }

            expect(controller.scrollToPage(5)).toBe(true);
            expect(controller.navigationAnchorPage.value).toBe(5);
            isLoading.value = false;
            await nextTick();

            expect(controller.navigationAnchorPage.value).toBe(5);
            expect(navigationFeedback).toHaveBeenLastCalledWith(5);

            controller.cancelDestinationNavigationTarget();
            expect(controller.navigationAnchorPage.value).toBeNull();
            expect(navigationFeedback).toHaveBeenLastCalledWith(null);
            expect(prepareNavigationVisual).not.toHaveBeenCalled();
            expect(viewportWrites.writes).toHaveLength(0);
        } finally {
            pageSlots.dispose();
            scope.stop();
        }
    });
});
