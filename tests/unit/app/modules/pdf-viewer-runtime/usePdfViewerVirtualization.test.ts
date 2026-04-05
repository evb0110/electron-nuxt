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

function createVirtualizationHarness(viewMode: TPdfViewMode) {
    const numPages = ref(20);
    const pageMetrics = ref(Array.from({ length: 20 }, () => ({
        width: 300,
        height: 100,
    })));

    return usePdfViewerVirtualization({
        bufferPages: computed(() => 0),
        continuousScroll: computed(() => true),
        viewMode: computed(() => viewMode),
        numPages,
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
    continuousScroll?: boolean;
    visibleRange?: {
        start: number;
        end: number;
    };
}) {
    const numPages = ref(20);
    const pageMetrics = ref(Array.from({ length: 20 }, () => ({
        width: 300,
        height: 100,
    })));

    return usePdfViewerVirtualization({
        bufferPages: computed(() => 0),
        continuousScroll: computed(() => options?.continuousScroll ?? true),
        viewMode: computed(() => options?.viewMode ?? 'single'),
        numPages,
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
        searchNavigationTargetPage: ref(null),
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

    it('renders only the visible spread when continuous scrolling is disabled', () => {
        const virtualization = createPagedHarness({
            viewMode: 'facing',
            continuousScroll: false,
            visibleRange: {
                start: 9,
                end: 10,
            },
        });

        expect(virtualization.virtualizedContinuousMode.value).toBe(false);
        expect(virtualization.pagesToRender.value).toEqual([
            9,
            10,
        ]);
    });
});
