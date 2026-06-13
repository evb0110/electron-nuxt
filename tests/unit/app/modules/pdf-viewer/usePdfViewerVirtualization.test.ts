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
import { usePdfViewerVirtualization } from '@app/modules/pdf-viewer/runtime/composables/usePdfViewerVirtualization';
import { expandVirtualWindowForAnchor } from '@app/modules/pdf-viewer/runtime/viewport/expandVirtualWindowForAnchor';
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
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
        navigationAnchorPage: ref(null),
        resizeTransitionAnchorPage: ref(null),
        zoomVirtualizationFreeze: ref(null),
    });
}

function createPagedHarness(options?: {
    viewMode?: TPdfViewMode;
    currentPage?: number;
    navigationAnchorPage?: number | null;
    navigationHeldPageNumbers?: number[];
    bufferPages?: number;
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
        bufferPages: computed(() => options?.bufferPages ?? 2),
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
        navigationAnchorPage: ref(options?.navigationAnchorPage ?? null),
        navigationHeldPageNumbers: computed(() => options?.navigationHeldPageNumbers ?? []),
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

    it('keeps only the active spread row visible while mounting warm paged buffers', () => {
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
            7,
            8,
            9,
            10,
            11,
            12,
            13,
            14,
        ]);
        expect(virtualization.isPageBuffered(8)).toBe(true);
        expect(virtualization.isPageBuffered(9)).toBe(false);
        expect(virtualization.isPageBuffered(10)).toBe(false);
        expect(virtualization.isPageBuffered(11)).toBe(true);
        expect(virtualization.topVirtualSpacerStyle.value).toBeNull();
        expect(virtualization.bottomVirtualSpacerStyle.value).toBeNull();
    });

    it('uses a navigation anchor row as the temporary paged mount window', () => {
        const virtualization = createPagedHarness({
            viewMode: 'facing-first-single',
            currentPage: 1,
            navigationAnchorPage: 10,
            visibleRange: {
                start: 1,
                end: 1,
            },
        });

        expect(virtualization.pagesToRender.value).toEqual([
            8,
            9,
            10,
            11,
            12,
            13,
            14,
            15,
        ]);
        expect(virtualization.virtualWindowStartPage.value).toBe(10);
        expect(virtualization.virtualWindowEndPage.value).toBe(11);
        expect(virtualization.isPageBuffered(9)).toBe(true);
        expect(virtualization.isPageBuffered(10)).toBe(false);
        expect(virtualization.isPageBuffered(11)).toBe(false);
        expect(virtualization.isPageBuffered(12)).toBe(true);
    });

    it('keeps held paged rows mounted while a far navigation target is pending', () => {
        const virtualization = createPagedHarness({
            viewMode: 'single',
            currentPage: 1,
            navigationAnchorPage: 18,
            navigationHeldPageNumbers: [1],
            visibleRange: {
                start: 1,
                end: 1,
            },
        });

        expect(virtualization.pagesToRender.value).toEqual([
            1,
            17,
            18,
            19,
            20,
        ]);
        expect(virtualization.isPageBuffered(1)).toBe(true);
        expect(virtualization.isPageBuffered(18)).toBe(false);
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
            navigationAnchorPage: ref(null),
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

    it('clamps continuous-mode placeholder mounts while layout metrics are unavailable', () => {
        const virtualization = usePdfViewerVirtualization({
            bufferPages: computed(() => 2),
            viewMode: computed(() => 'single'),
            numPages: ref(2_000),
            currentPage: ref(1_000),
            continuousScroll: computed(() => true),
            basePageWidth: ref(null),
            basePageHeight: ref(null),
            pageMetrics: ref([]),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 1_000,
                end: 1_000,
            }),
            navigationAnchorPage: ref(null),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
        });

        expect(virtualization.pagesToRender.value).toEqual(
            Array.from({length: 13}, (_, index) => 994 + index),
        );
        expect(virtualization.pagesToRender.value.length).toBeLessThan(2_000);
    });

    it('ignores a zoom freeze that would hide the active navigation anchor', () => {
        const navigationAnchorPage = ref(10);
        const zoomVirtualizationFreeze = ref({
            sessionId: 1,
            capturedAtMs: 0,
            windowStart: 30,
            windowEnd: 34,
            topSpacerHeight: 1234,
            bottomSpacerHeight: 5678,
        });
        const virtualization = usePdfViewerVirtualization({
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'single'),
            numPages: ref(60),
            currentPage: ref(32),
            continuousScroll: computed(() => true),
            basePageWidth: ref(300),
            basePageHeight: ref(100),
            pageMetrics: ref(Array.from({ length: 60 }, () => ({
                width: 300,
                height: 100,
            }))),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 30,
                end: 32,
            }),
            navigationAnchorPage,
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze,
        });

        expect(virtualization.virtualWindowStart.value).toBeLessThanOrEqual(10);
        expect(virtualization.virtualWindowEnd.value).toBeGreaterThanOrEqual(10);
        expect(virtualization.pagesToRender.value).toContain(10);
        expect(virtualization.topVirtualSpacerStyle.value).not.toEqual({height: '1234px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).not.toEqual({height: '5678px'});
    });

    it('keeps a compatible zoom freeze while the navigation anchor is inside it', () => {
        const effectiveScale = ref(1);
        const virtualization = usePdfViewerVirtualization({
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'single'),
            numPages: ref(60),
            currentPage: ref(32),
            continuousScroll: computed(() => true),
            basePageWidth: ref(300),
            basePageHeight: ref(100),
            pageMetrics: ref(Array.from({ length: 60 }, () => ({
                width: 300,
                height: 100,
            }))),
            pageMetricsVersion: ref(0),
            effectiveScale,
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 30,
                end: 32,
            }),
            navigationAnchorPage: ref(32),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref({
                sessionId: 1,
                capturedAtMs: 0,
                windowStart: 30,
                windowEnd: 34,
                topSpacerHeight: 1234,
                bottomSpacerHeight: 5678,
            }),
        });

        expect(virtualization.virtualWindowStart.value).toBe(30);
        expect(virtualization.virtualWindowEnd.value).toBe(34);
        expect(virtualization.topVirtualSpacerStyle.value).toEqual({height: '3460px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).toEqual({height: '3100px'});

        effectiveScale.value = 2;

        expect(virtualization.virtualWindowStart.value).toBe(30);
        expect(virtualization.virtualWindowEnd.value).toBe(34);
        expect(virtualization.topVirtualSpacerStyle.value).toEqual({height: '6360px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).toEqual({height: '5700px'});
    });
});
