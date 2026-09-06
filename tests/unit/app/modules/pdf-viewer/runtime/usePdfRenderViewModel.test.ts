import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    computed,
    effectScope,
    ref,
    shallowRef,
    type Ref,
} from 'vue';
import { requirePageNumber } from '@contracts/pageNumbers';
import { createPdfRenderPagePredicate } from '@app/modules/pdf-viewer/runtime/rendering/createPdfRenderPagePredicate';
import { usePdfRenderViewModel } from '@app/modules/pdf-viewer/runtime/rendering/usePdfRenderViewModel';
import type {
    PDFDocumentProxy,
    PDFPageProxy,
} from '@app/types/pdfContracts';
import type { TPdfSource } from '@app/types/pdfUi';
import { createPdfDocumentProxy } from '@tests/helpers/createPdfDocumentProxy';
import { createDocumentOpenSurfaceSession } from '@app/utils/document-viewer/chassis/documentOpenSurfaceSession';

function createPdfPageProxy(): PDFPageProxy {
    // The view model stores the page returned by getPage but does not inspect
    // it in these state-only tests.
    return {} as PDFPageProxy;
}

function createHarness(options?: {
    hasMountedPageCanvas?: (page: number) => boolean;
    isPageBuffered?: (page: number) => boolean;
    isPageRenderedForClass?: (page: number) => boolean;
    isPageRendering?: (page: number) => boolean;
    isPageRenderFailed?: (page: number) => boolean;
    shouldShowSkeletonImmediately?: (page: number) => boolean;
    shouldShowSkeleton?: (page: number) => boolean;
    suppressLoadingOverlay?: boolean;
    numPages?: Ref<number>;
    markersByPage?: Ref<Map<number, never[]>>;
    linksByPage?: Record<number, never[]>;
}) {
    const scope = effectScope();
    const mountedPages = ref([1]);
    const visibleRange = ref({
        start: 1,
        end: 1,
    });

    const viewModel = scope.run(() => usePdfRenderViewModel({
        src: computed(() => null as TPdfSource | null),
        isLoading: ref(false),
        pdfDocument: shallowRef<PDFDocumentProxy | null>(createPdfDocumentProxy()),
        getPage: vi.fn(async () => createPdfPageProxy()),
        openSurface: createDocumentOpenSurfaceSession(),
        isVisualReloadTransitionActive: ref(false),
        suppressLoadingOverlay: computed(() => options?.suppressLoadingOverlay ?? false),
        skeletonContentInsets: ref(null),
        pagesToRender: computed(() => mountedPages.value),
        isPageBuffered: options?.isPageBuffered ?? vi.fn(() => false),
        isPageRenderedForClass: options?.isPageRenderedForClass ?? vi.fn(() => false),
        isPageRendering: options?.isPageRendering ?? vi.fn(() => false),
        isPageRenderFailed: options?.isPageRenderFailed ?? vi.fn(() => false),
        shouldShowSkeleton: options?.shouldShowSkeleton ?? vi.fn(() => false),
        visibleRange,
        currentPage: ref(1),
        zoom: computed(() => 1),
        zoomMode: computed(() => 'fit-height' as const),
        fitMode: computed(() => 'height' as const),
        effectiveScale: ref(1),
        continuousScroll: computed(() => false),
        numPages: options?.numPages ?? ref(1_000),
        markersByPage: options?.markersByPage ?? ref(new Map<number, never[]>()),
        linksByPage: computed<Record<number, never[]>>(() => options?.linksByPage ?? {}),
    }));

    return {
        scope,
        viewModel,
    };
}

describe('usePdfRenderViewModel', () => {
    it('replaces the skeleton when render demand reaches a terminal error', () => {
        const {
            scope,
            viewModel,
        } = createHarness({
            isPageRenderFailed: () => true,
            shouldShowSkeleton: () => true,
        });

        expect(viewModel?.shouldShowPageSkeleton(1)).toBe(false);
        expect(viewModel?.isPageRenderFailed(1)).toBe(true);

        scope.stop();
    });

    it('keeps page skeletons while an uncommitted canvas is mounted and rendering', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(false);
            const isRendering = ref(false);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => isRendering.value,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            hasMountedCanvas.value = true;
            isRendering.value = true;
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('hides page skeletons after the page is finalized as rendered', () => {
        vi.useFakeTimers();
        try {
            const isRendered = ref(false);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                isPageRenderedForClass: () => isRendered.value,
                isPageRendering: () => true,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            isRendered.value = true;
            expect(viewModel.shouldShowPageSkeleton(1)).toBe(false);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps page skeletons visible when no final canvas is ready', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({ shouldShowSkeleton: () => true });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('shows immediate navigation skeletons without waiting for the delayed timer', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                shouldShowSkeleton: () => true,
                shouldShowSkeletonImmediately: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('blocks immediate navigation skeletons while skeletons are globally suppressed', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                shouldShowSkeleton: () => true,
                shouldShowSkeletonImmediately: () => true,
                suppressLoadingOverlay: true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(false);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps recovery skeletons for an orphan canvas without current-generation readiness', () => {
        vi.useFakeTimers();
        try {
            const hasMountedCanvas = ref(true);
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => hasMountedCanvas.value,
                isPageRendering: () => false,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not treat DOM canvas existence as navigation visual readiness', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not treat an orphaned canvas as recovery visual readiness', () => {
        vi.useFakeTimers();
        try {
            const {
                scope,
                viewModel,
            } = createHarness({
                hasMountedPageCanvas: () => true,
                isPageRendering: () => false,
                shouldShowSkeleton: () => true,
            });

            if (!viewModel) {
                throw new Error('Failed to create PDF render view model');
            }

            expect(viewModel.shouldShowPageSkeleton(1)).toBe(true);

            scope.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('does not query stale markers after the document page count resets during teardown', () => {
        const pageCount = ref(383);
        const markersByPage = ref(new Map<number, never[]>([[
            5,
            [],
        ]]));
        const {
            scope,
            viewModel,
        } = createHarness({
            numPages: pageCount,
            markersByPage,
            linksByPage: {5: []},
            isPageRenderedForClass: createPdfRenderPagePredicate(
                () => pageCount.value,
                page => requirePageNumber(page, pageCount.value) > 0,
            ),
        });

        if (!viewModel) {
            throw new Error('Failed to create PDF render view model');
        }

        try {
            expect([...viewModel.visibleMarkersByPage.value.keys()]).toEqual([5]);
            expect(viewModel.visibleLinksByPage.value).toEqual({5: []});

            pageCount.value = 0;
            expect(viewModel.visibleMarkersByPage.value).toEqual(new Map());
            expect(viewModel.visibleLinksByPage.value).toEqual({});

            pageCount.value = 3;
            expect(viewModel.visibleMarkersByPage.value).toEqual(new Map());
            expect(viewModel.visibleLinksByPage.value).toEqual({});

            pageCount.value = 383;
            expect([...viewModel.visibleMarkersByPage.value.keys()]).toEqual([5]);
            expect(viewModel.visibleLinksByPage.value).toEqual({5: []});
        } finally {
            scope.stop();
        }
    });
});
