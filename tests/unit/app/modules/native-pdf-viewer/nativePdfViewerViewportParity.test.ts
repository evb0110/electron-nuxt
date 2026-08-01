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
    type EffectScope,
    type Ref,
} from 'vue';
import { canRestoreNativePdfViewportLayout } from '@app/modules/native-pdf-viewer/runtime/canRestoreNativePdfViewportLayout';
import { useDocumentViewportLayoutLifecycle } from '@app/utils/document-viewer/lifecycle/useDocumentViewportLayoutLifecycle';
import type { IDocumentZoomPageLayout } from '@app/utils/document-viewer/zoomAnchor';
import {
    resolveDocumentContinuousScrollGeometry,
    resolveDocumentContinuousScrollWindow,
    resolveDocumentViewportPageNumbers,
} from '@app/utils/document-viewer/viewport/resolveDocumentContinuousScrollWindow';

interface INativePdfTestPageLayout extends IDocumentZoomPageLayout {
    readonly height: number;
    readonly top: number;
    readonly width: number;
}

interface INativePdfPaneAnchorHarness {
    readonly isActive: boolean;
    readonly lifecycle: ReturnType<typeof useDocumentViewportLayoutLifecycle>;
    readonly pageLayouts: Ref<INativePdfTestPageLayout[]>;
    readonly viewport: HTMLElement;
}

const NATIVE_PDF_TEST_PAGE_COUNT = 12;
const NATIVE_PDF_TEST_PAGE_HEIGHT = 800;
const NATIVE_PDF_TEST_PAGE_GAP = 20;
const NATIVE_PDF_TEST_VIEWPORT_HEIGHT = 600;
const NATIVE_PDF_TEST_INITIAL_SCALE = 1;
const NATIVE_PDF_TEST_CHANGED_SCALE = 0.5;
const activeNativePdfAnchorScopes = new Set<EffectScope>();

function createTestPageLayouts(scale: number): INativePdfTestPageLayout[] {
    const pageHeight = NATIVE_PDF_TEST_PAGE_HEIGHT * scale;
    return Array.from({length: NATIVE_PDF_TEST_PAGE_COUNT}, (_, index) => ({
        height: pageHeight,
        top: NATIVE_PDF_TEST_PAGE_GAP + index * (pageHeight + NATIVE_PDF_TEST_PAGE_GAP),
        width: 600 * scale,
    }));
}

function createTestViewport(scrollTop: number) {
    return {
        clientHeight: NATIVE_PDF_TEST_VIEWPORT_HEIGHT,
        clientWidth: 800,
        scrollHeight: 120_000,
        scrollLeft: 0,
        scrollTop,
        scrollWidth: 800,
    } as HTMLElement;
}

function resolvePageTop(pageNumber: number, scale: number) {
    const pageHeight = NATIVE_PDF_TEST_PAGE_HEIGHT * scale;
    return NATIVE_PDF_TEST_PAGE_GAP
        + (pageNumber - 1) * (pageHeight + NATIVE_PDF_TEST_PAGE_GAP);
}

function resolvePageAnchorScrollTop(pageNumber: number, yRatio: number, scale: number) {
    const pageHeight = NATIVE_PDF_TEST_PAGE_HEIGHT * scale;
    return resolvePageTop(pageNumber, scale)
        + pageHeight * yRatio
        - NATIVE_PDF_TEST_VIEWPORT_HEIGHT / 2;
}

function resolveMostVisiblePage(
    pageLayouts: readonly INativePdfTestPageLayout[],
    scrollTop: number,
) {
    const viewportBottom = scrollTop + NATIVE_PDF_TEST_VIEWPORT_HEIGHT;
    let mostVisiblePage = 0;
    let mostVisibleHeight = -1;
    pageLayouts.forEach((layout, index) => {
        const visibleHeight = Math.max(
            0,
            Math.min(layout.top + layout.height, viewportBottom)
                - Math.max(layout.top, scrollTop),
        );
        if (visibleHeight > mostVisibleHeight) {
            mostVisibleHeight = visibleHeight;
            mostVisiblePage = index + 1;
        }
    });
    return mostVisiblePage;
}

function createPaneAnchorHarness(
    isActive: boolean,
    pageNumber: number,
    yRatio: number,
    scale: number,
): INativePdfPaneAnchorHarness {
    const viewport = createTestViewport(resolvePageAnchorScrollTop(pageNumber, yRatio, scale));
    const pageLayouts = ref(createTestPageLayouts(scale));
    const lifecycle = useDocumentViewportLayoutLifecycle({
        viewerContainer: ref<HTMLElement | null>(viewport),
        pageLayouts,
        captureRestoreEpoch: () => 1,
        canRestore: epoch => canRestoreNativePdfViewportLayout(epoch, {
            currentLoadGeneration: 1,
            hasDocumentIdentity: true,
        }),
        applyRestoredScroll: restored => {
            viewport.scrollLeft = restored.left;
            viewport.scrollTop = restored.top;
        },
    });
    return {
        isActive,
        lifecycle,
        pageLayouts,
        viewport,
    };
}

afterEach(() => {
    for (const scope of activeNativePdfAnchorScopes) {
        scope.stop();
    }
    activeNativePdfAnchorScopes.clear();
    vi.unstubAllGlobals();
});

function bruteForceVisiblePages(options: {
    pageHeights: number[];
    pageGapPx: number;
    scrollTop: number;
    viewportHeight: number;
    overscanViewports: number;
}) {
    const geometry = resolveDocumentContinuousScrollGeometry({
        pageGapPx: options.pageGapPx,
        pageHeights: options.pageHeights,
        totalPages: options.pageHeights.length,
    });
    const start = Math.max(0, options.scrollTop - options.viewportHeight * options.overscanViewports);
    const end = options.scrollTop + options.viewportHeight * (1 + options.overscanViewports);
    return geometry.pageTops.flatMap((top, index) => (
        top + (geometry.pageHeights[index] ?? 0) >= start && top <= end ? [index + 1] : []
    ));
}

describe('Native PDF viewer viewport primitive parity', () => {
    it.each([
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 0,
            viewportHeight: 160,
            overscan: 0,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 125,
            viewportHeight: 190,
            overscan: 0,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 280,
            viewportHeight: 120,
            overscan: 2,
        },
        {
            heights: [
                100,
                200,
                80,
                300,
            ],
            scrollTop: 116,
            viewportHeight: 216,
            overscan: 0,
        },
    ])('matches the legacy intersection window for $scrollTop', ({
        heights,
        scrollTop,
        viewportHeight,
        overscan,
    }) => {
        const pageGapPx = 16;
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx,
            pageHeights: heights,
            totalPages: heights.length,
        });
        const pages = resolveDocumentViewportPageNumbers({
            geometry,
            pageGapPx,
            scrollTop,
            totalPages: heights.length,
            viewportHeight,
            overscanViewports: overscan,
        });
        expect(pages).toEqual(bruteForceVisiblePages({
            pageHeights: heights,
            pageGapPx,
            scrollTop,
            viewportHeight,
            overscanViewports: overscan,
        }));
    });

    it('selects the page with the largest viewport intersection', () => {
        const heights = [
            100,
            200,
            80,
        ];
        const geometry = resolveDocumentContinuousScrollGeometry({
            pageGapPx: 16,
            pageHeights: heights,
            totalPages: heights.length,
        });
        expect(resolveDocumentContinuousScrollWindow({
            currentPage: 1,
            geometry,
            pageGapPx: 16,
            pageHeights: heights,
            renderMarginPages: 0,
            scrollTop: 90,
            totalPages: heights.length,
            viewportHeight: 180,
            overscanViewports: 0,
        })?.mostVisiblePage).toBe(2);
    });

    it('re-anchors active and inactive panes to their current pages after a scale change', async () => {
        vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
            callback(0);
            return 1;
        });
        const scope = effectScope();
        activeNativePdfAnchorScopes.add(scope);
        const panes = scope.run(() => [
            createPaneAnchorHarness(true, 3, 0.35, NATIVE_PDF_TEST_INITIAL_SCALE),
            createPaneAnchorHarness(false, 5, 0.65, NATIVE_PDF_TEST_INITIAL_SCALE),
        ]);
        if (!panes) {
            throw new Error('Native PDF pane anchor fixtures did not initialize');
        }
        const [
            activePane,
            inactivePane,
        ] = panes;
        if (!activePane || !inactivePane) {
            throw new Error('Native PDF pane anchor fixtures are incomplete');
        }
        expect(activePane.isActive).toBe(true);
        expect(inactivePane.isActive).toBe(false);
        expect(resolveMostVisiblePage(activePane.pageLayouts.value, activePane.viewport.scrollTop)).toBe(3);
        expect(resolveMostVisiblePage(inactivePane.pageLayouts.value, inactivePane.viewport.scrollTop)).toBe(5);

        activePane.pageLayouts.value = createTestPageLayouts(NATIVE_PDF_TEST_CHANGED_SCALE);
        inactivePane.pageLayouts.value = createTestPageLayouts(NATIVE_PDF_TEST_CHANGED_SCALE);
        await nextTick();
        await nextTick();

        expect(resolveMostVisiblePage(activePane.pageLayouts.value, activePane.viewport.scrollTop)).toBe(3);
        expect(resolveMostVisiblePage(inactivePane.pageLayouts.value, inactivePane.viewport.scrollTop)).toBe(5);
        expect(activePane.viewport.scrollTop).toBeCloseTo(
            resolvePageAnchorScrollTop(3, 0.35, NATIVE_PDF_TEST_CHANGED_SCALE),
            5,
        );
        expect(inactivePane.viewport.scrollTop).toBeCloseTo(
            resolvePageAnchorScrollTop(5, 0.65, NATIVE_PDF_TEST_CHANGED_SCALE),
            5,
        );
    });
});
