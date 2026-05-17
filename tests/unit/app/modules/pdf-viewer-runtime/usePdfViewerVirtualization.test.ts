import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    computed,
    ref,
} from 'vue';
import type { TPdfViewMode } from '@contracts/shared';
import {
    expandVirtualWindowForAnchor,
    usePdfViewerVirtualization,
} from '@app/modules/pdf-viewer-runtime/composables/usePdfViewerVirtualization';
import { getPageRowBoundsForViewMode } from '@app/composables/pdf/pdfPageLayout';
import type { IPdfPageMetric } from '@app/types/pdf';

describe('expandVirtualWindowForAnchor', () => {
    it('keeps the existing window when no anchor page is provided', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 10,
            baseEnd: 20,
            anchorPage: null,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 10,
            end: 20,
        });
    });

    it('expands the window to keep the resize anchor page mounted', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 40,
            baseEnd: 52,
            anchorPage: 30,
            totalPages: 100,
            buffer: 6,
        })).toEqual({
            start: 24,
            end: 52,
        });
    });

    it('clamps the expanded window into the document bounds', () => {
        expect(expandVirtualWindowForAnchor({
            baseStart: 3,
            baseEnd: 10,
            anchorPage: 1,
            totalPages: 12,
            buffer: 8,
        })).toEqual({
            start: 1,
            end: 10,
        });
    });
});

describe('getPageRowBoundsForViewMode', () => {
    it('returns the current spread bounds without building full layout metrics', () => {
        expect(getPageRowBoundsForViewMode({
            pageNumber: 9,
            viewMode: 'facing',
            totalPages: 20,
        })).toEqual({
            start: 9,
            end: 10,
        });
    });

    it('keeps the first page single in facing-first-single mode', () => {
        expect(getPageRowBoundsForViewMode({
            pageNumber: 1,
            viewMode: 'facing-first-single',
            totalPages: 20,
        })).toEqual({
            start: 1,
            end: 1,
        });
    });
});

function createVirtualizationHarness(viewMode: TPdfViewMode) {
    const numPages = ref(20);
    const currentPage = ref(9);
    const pageMetrics = ref(Array.from({ length: 20 }, () => ({
        width: 300,
        height: 100,
    })));

    return usePdfViewerVirtualization({
        bufferPages: computed(() => 0),
        viewMode: computed(() => viewMode),
        numPages,
        currentPage,
        continuousScroll: computed(() => true),
        basePageWidth: ref(300),
        basePageHeight: ref(100),
        pageMetrics,
        pageMetricsVersion: ref(0),
        effectiveScale: ref(1),
        scaledMargin: ref(20),
        visibleRange: ref({
            start: 9,
            end: 10,
        }),
        searchNavigationTargetPage: ref(null),
        resizeTransitionAnchorPage: ref(null),
        zoomVirtualizationFreeze: ref(null),
    });
}

function createPagedHarness(options?: {
    viewMode?: TPdfViewMode;
    currentPage?: number;
    searchNavigationTargetPage?: number | null;
    visibleRange?: {
        start: number;
        end: number;
    };
}) {
    const numPages = ref(20);
    const currentPage = ref(options?.currentPage ?? 9);
    const pageMetrics = ref(Array.from({ length: 20 }, () => ({
        width: 300,
        height: 100,
    })));

    return usePdfViewerVirtualization({
        bufferPages: computed(() => 0),
        viewMode: computed(() => options?.viewMode ?? 'single'),
        numPages,
        currentPage,
        continuousScroll: computed(() => false),
        basePageWidth: ref(300),
        basePageHeight: ref(100),
        pageMetrics,
        pageMetricsVersion: ref(0),
        effectiveScale: ref(1),
        scaledMargin: ref(20),
        visibleRange: ref(options?.visibleRange ?? {
            start: 9,
            end: 10,
        }),
        searchNavigationTargetPage: ref(options?.searchNavigationTargetPage ?? null),
        resizeTransitionAnchorPage: ref(null),
        zoomVirtualizationFreeze: ref(null),
    });
}

describe('usePdfViewerVirtualization', () => {
    it('keeps virtualization enabled for facing spread modes and aligns render rows', () => {
        const virtualization = createVirtualizationHarness('facing');

        expect(virtualization.virtualizedContinuousMode.value).toBe(true);
        expect(virtualization.virtualWindowStartPage.value).toBe(3);
        expect(virtualization.virtualWindowEndPage.value).toBe(16);
        expect(virtualization.pagesToRender.value).toEqual([
            3,
            4,
            5,
            6,
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15,
            16,
        ]);
        expect(virtualization.topVirtualSpacerStyle.value).toEqual({ height: '100px' });
        expect(virtualization.bottomVirtualSpacerStyle.value).toEqual({ height: '220px' });
    });

    it('mounts only the active spread row in paged mode', () => {
        const virtualization = createPagedHarness({
            viewMode: 'facing',
            currentPage: 9,
            visibleRange: {
                start: 9,
                end: 10,
            },
        });

        expect(virtualization.virtualizedContinuousMode.value).toBe(false);
        expect(virtualization.virtualWindowStartPage.value).toBe(9);
        expect(virtualization.virtualWindowEndPage.value).toBe(10);
        expect(virtualization.pagesToRender.value).toEqual([
            9,
            10,
        ]);
        expect(virtualization.topVirtualSpacerStyle.value).toBeNull();
        expect(virtualization.bottomVirtualSpacerStyle.value).toBeNull();
    });

    it('uses a search navigation row as the temporary paged mount window', () => {
        const virtualization = createPagedHarness({
            viewMode: 'facing-first-single',
            currentPage: 1,
            searchNavigationTargetPage: 10,
            visibleRange: {
                start: 1,
                end: 1,
            },
        });

        expect(virtualization.pagesToRender.value).toEqual([
            10,
            11,
        ]);
        expect(virtualization.virtualWindowStartPage.value).toBe(10);
        expect(virtualization.virtualWindowEndPage.value).toBe(11);
    });

    it('does not size skeleton placeholders from a wider document fallback while page metrics hydrate', () => {
        const pageMetrics = ref<IPdfPageMetric[]>([]);
        pageMetrics.value[0] = {
            width: 300,
            height: 500,
        };
        pageMetrics.value[4] = {
            width: 320,
            height: 520,
        };
        const virtualization = usePdfViewerVirtualization({
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'single'),
            numPages: ref(6),
            currentPage: ref(2),
            continuousScroll: computed(() => true),
            basePageWidth: ref(1200),
            basePageHeight: ref(1600),
            pageMetrics,
            pageMetricsVersion: ref(0),
            effectiveScale: ref(2),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 2,
                end: 3,
            }),
            searchNavigationTargetPage: ref(null),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
        });

        expect(virtualization.getPagePlaceholderStyle(2)).toEqual({
            width: '600px',
            height: '1000px',
        });
        expect(virtualization.getPagePlaceholderStyle(4)).toEqual({
            width: '640px',
            height: '1040px',
        });
    });
});
