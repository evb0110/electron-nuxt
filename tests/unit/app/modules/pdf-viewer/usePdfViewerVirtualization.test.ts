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
import { getPageRowBoundsForViewMode } from '@app/modules/pdf-viewer/engine/pdf-page-layout/getPageRowBoundsForViewMode';
import {
    resolvePdfRenderPerformancePolicy,
    type IPdfRenderPerformancePolicy,
} from '@app/modules/pdf-viewer/engine/pdf-render-performance/resolvePdfRenderPerformancePolicy';
import type { IPdfPageMetric } from '@app/types/pdfUi';

const normalPerformancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: false,
    lowMemory: false,
});
const constrainedPerformancePolicy = resolvePdfRenderPerformancePolicy({
    lowCpu: true,
    lowMemory: false,
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
        performancePolicy: normalPerformancePolicy,
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
    bufferPages?: number;
    performancePolicy?: IPdfRenderPerformancePolicy;
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
        performancePolicy: options?.performancePolicy ?? normalPerformancePolicy,
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
        expect(virtualization.topVirtualSpacerStyle.value).toMatchObject({height: '100px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).toMatchObject({height: '220px'});
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

    it('mounts only the target paged window while a far navigation target is pending', () => {
        const virtualization = createPagedHarness({
            viewMode: 'single',
            currentPage: 1,
            navigationAnchorPage: 18,
            visibleRange: {
                start: 1,
                end: 1,
            },
        });

        expect(virtualization.pagesToRender.value).toEqual([
            17,
            18,
            19,
            20,
        ]);
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
            performancePolicy: normalPerformancePolicy,
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
            '--scale-factor': '2',
            '--user-unit': '1',
            '--total-scale-factor': 'calc(var(--scale-factor, 1) * var(--user-unit, 1))',
        });
        expect(virtualization.getPagePlaceholderStyle(4)).toEqual({
            width: '640px',
            height: '1040px',
            '--scale-factor': '2',
            '--user-unit': '1',
            '--total-scale-factor': 'calc(var(--scale-factor, 1) * var(--user-unit, 1))',
        });
        expect(virtualization.getPageScale(2)).toEqual({
            scaleFactor: 2,
            userUnit: 1,
            totalScaleFactor: 2,
        });
    });

    it('clamps continuous-mode placeholder mounts while layout metrics are unavailable', () => {
        const virtualization = usePdfViewerVirtualization({
            performancePolicy: normalPerformancePolicy,
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

    it('keeps the committed window mounted beside a far offscreen navigation target', () => {
        const visibleRange = ref({
            start: 1,
            end: 2,
        });
        const virtualization = usePdfViewerVirtualization({
            performancePolicy: normalPerformancePolicy,
            bufferPages: computed(() => 2),
            viewMode: computed(() => 'single'),
            numPages: ref(1_000),
            currentPage: ref(1),
            continuousScroll: computed(() => true),
            basePageWidth: ref(300),
            basePageHeight: ref(100),
            pageMetrics: ref(Array.from({length: 1_000}, () => ({
                width: 300,
                height: 100,
            }))),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange,
            navigationAnchorPage: ref(928),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
        });

        expect(virtualization.virtualPageSegments.value).toHaveLength(2);
        expect(virtualization.pagesToRender.value).toContain(1);
        expect(virtualization.pagesToRender.value).toContain(928);
        expect(virtualization.pagesToRender.value.length).toBeLessThan(120);
        expect(virtualization.pagesToRender.value).not.toContain(500);
        const targetSegment = virtualization.virtualPageSegments.value[1];
        expect(targetSegment?.spacerBeforeStyle).toMatchObject({
            height: expect.any(String),
            minHeight: expect.any(String),
            flexBasis: expect.any(String),
        });
        expect(targetSegment?.spacerBeforeStyle?.minHeight).toBe(
            targetSegment?.spacerBeforeStyle?.height,
        );
        expect(targetSegment?.spacerBeforeStyle?.flexBasis).toBe(
            targetSegment?.spacerBeforeStyle?.height,
        );

        visibleRange.value = {
            start: 450,
            end: 452,
        };

        expect(virtualization.virtualPageSegments.value).toHaveLength(2);
        expect(virtualization.pagesToRender.value).toContain(450);
        expect(virtualization.pagesToRender.value).toContain(928);
        expect(virtualization.pagesToRender.value).not.toContain(700);
    });

    it('ignores a zoom freeze that would hide the active navigation anchor', () => {
        const navigationAnchorPage = ref(10);
        const zoomVirtualizationFreeze = ref({
            sessionId: 1,
            capturedAtMs: 0,
            windowStart: 30,
            windowEnd: 34,
        });
        const virtualization = usePdfViewerVirtualization({
            performancePolicy: normalPerformancePolicy,
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

    it.each([
        {
            name: 'normal tier',
            performancePolicy: normalPerformancePolicy,
            radius: 18,
        },
        {
            name: 'constrained tier',
            performancePolicy: constrainedPerformancePolicy,
            radius: 8,
        },
    ])('applies the $name navigation-anchor mount floor', ({
        performancePolicy,
        radius,
    }) => {
        const virtualization = usePdfViewerVirtualization({
            performancePolicy,
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'single'),
            numPages: ref(100),
            currentPage: ref(60),
            continuousScroll: computed(() => true),
            basePageWidth: ref(300),
            basePageHeight: ref(100),
            pageMetrics: ref(Array.from({ length: 100 }, () => ({
                width: 300,
                height: 100,
            }))),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(1),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 60,
                end: 60,
            }),
            navigationAnchorPage: ref(40),
            resizeTransitionAnchorPage: ref(null),
            zoomVirtualizationFreeze: ref(null),
        });

        expect(virtualization.virtualWindowStart.value).toBe(40 - radius);
        expect(virtualization.virtualWindowEnd.value).toBe(60 + radius);
        expect(virtualization.pagesToRender.value).toContain(40);
        expect(virtualization.pagesToRender.value).toContain(60);
    });

    it.each([
        {
            name: 'normal tier',
            performancePolicy: normalPerformancePolicy,
            navigationBounds: {
                start: 19,
                end: 80,
            },
            resizeBounds: {
                start: 39,
                end: 100,
            },
        },
        {
            name: 'constrained tier',
            performancePolicy: constrainedPerformancePolicy,
            navigationBounds: {
                start: 37,
                end: 62,
            },
            resizeBounds: {
                start: 57,
                end: 82,
            },
        },
    ])('applies the $name layout-pending floor around transaction anchors', ({
        performancePolicy,
        navigationBounds,
        resizeBounds,
    }) => {
        const navigationAnchorPage = ref<number | null>(50);
        const virtualization = usePdfViewerVirtualization({
            performancePolicy,
            bufferPages: computed(() => 0),
            viewMode: computed(() => 'facing'),
            numPages: ref(120),
            currentPage: ref(115),
            continuousScroll: computed(() => true),
            basePageWidth: ref(300),
            basePageHeight: ref(100),
            pageMetrics: ref([]),
            pageMetricsVersion: ref(0),
            effectiveScale: ref(0),
            scaledMargin: ref(20),
            visibleRange: ref({
                start: 115,
                end: 115,
            }),
            navigationAnchorPage,
            resizeTransitionAnchorPage: ref(70),
            zoomVirtualizationFreeze: ref(null),
        });

        expect(virtualization.pagesToRender.value.at(0)).toBe(navigationBounds.start);
        expect(virtualization.pagesToRender.value.at(-1)).toBe(navigationBounds.end);
        expect(virtualization.pagesToRender.value).toContain(50);

        navigationAnchorPage.value = null;

        expect(virtualization.pagesToRender.value.at(0)).toBe(resizeBounds.start);
        expect(virtualization.pagesToRender.value.at(-1)).toBe(resizeBounds.end);
        expect(virtualization.pagesToRender.value).toContain(70);
        expect(virtualization.pagesToRender.value).not.toContain(115);
    });

    it('lets an active navigation anchor supersede a compatible zoom freeze', () => {
        const effectiveScale = ref(1);
        const virtualization = usePdfViewerVirtualization({
            performancePolicy: normalPerformancePolicy,
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
            }),
        });

        expect(virtualization.virtualWindowStart.value).toBe(12);
        expect(virtualization.virtualWindowEnd.value).toBe(50);
        expect(virtualization.virtualPageSegments.value).toHaveLength(1);
        expect(virtualization.topVirtualSpacerStyle.value).toMatchObject({height: '1300px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).toMatchObject({height: '1180px'});

        effectiveScale.value = 2;

        expect(virtualization.virtualWindowStart.value).toBe(12);
        expect(virtualization.virtualWindowEnd.value).toBe(50);
        expect(virtualization.topVirtualSpacerStyle.value).toMatchObject({height: '2400px'});
        expect(virtualization.bottomVirtualSpacerStyle.value).toMatchObject({height: '2180px'});
    });
});
