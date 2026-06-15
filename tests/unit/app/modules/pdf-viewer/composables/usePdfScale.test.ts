import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { usePdfScale } from '@app/modules/pdf-viewer/runtime/composables/pdf/usePdfScale';
import type {
    IPdfPageMetric,
    TFitMode,
} from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';

function createContainer(
    width: number,
    height: number,
) {
    return {
        clientWidth: width,
        clientHeight: height,
    } as HTMLElement;
}

function createScaleComposable(options: {
    width: number;
    height: number;
    pageMetrics?: IPdfPageMetric[];
    mode?: TFitMode;
    zoom?: number;
    viewMode?: TPdfViewMode;
    currentPage?: number;
    continuousScroll?: boolean;
}) {
    const zoom = ref(options.zoom ?? 1);
    const fitMode = ref<TFitMode>(options.mode ?? 'width');
    const viewMode = ref<TPdfViewMode>(options.viewMode ?? 'single');
    const pageMetrics = ref(options.pageMetrics ?? [{
        width: options.width,
        height: options.height,
    }]);
    const pageMetricsVersion = ref(0);
    const numPages = ref(pageMetrics.value.length);
    const baseWidth = ref(options.width);
    const baseHeight = ref(options.height);
    const currentPage = ref(options.currentPage ?? 1);
    const continuousScroll = ref(options.continuousScroll ?? true);

    return {
        baseWidth,
        baseHeight,
        pageMetrics,
        currentPage,
        continuousScroll,
        scale: usePdfScale(
            zoom,
            fitMode,
            viewMode,
            numPages,
            pageMetrics,
            pageMetricsVersion,
            baseWidth,
            baseHeight,
            currentPage,
            continuousScroll,
        ),
    };
}

describe('usePdfScale', () => {
    it('keeps viewer spacing fixed while fitting width', () => {
        const { scale } = createScaleComposable({
            width: 227.04,
            height: 350.64,
            mode: 'width',
        });
        const container = createContainer(1536, 900);

        const updated = scale.computeFitWidthScale(container);

        expect(updated).toBe(true);
        expect(scale.containerStyle.value).toEqual({
            padding: '20px',
            gap: '20px',
        });
        expect(scale.scaledMargin.value).toBe(20);
        expect(scale.effectiveScale.value * 227.04).toBeCloseTo(1496, 6);
    });

    it('produces similar rendered page width for different PDF page sizes', () => {
        const first = createScaleComposable({
            width: 227.04,
            height: 350.64,
            mode: 'width',
        });
        const second = createScaleComposable({
            width: 504,
            height: 648,
            mode: 'width',
        });
        const container = createContainer(1536, 900);

        first.scale.computeFitWidthScale(container);
        second.scale.computeFitWidthScale(container);

        const firstRenderedWidth = first.scale.effectiveScale.value * first.baseWidth.value;
        const secondRenderedWidth = second.scale.effectiveScale.value * second.baseWidth.value;

        expect(firstRenderedWidth).toBeCloseTo(1496, 6);
        expect(secondRenderedWidth).toBeCloseTo(1496, 6);
    });

    it('accounts for fixed margins in fit-height mode', () => {
        const { scale } = createScaleComposable({
            width: 504,
            height: 648,
            mode: 'height',
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * 648).toBeCloseTo(860, 6);
        expect(scale.containerStyle.value).toEqual({
            padding: '20px',
            gap: '20px',
        });
    });

    it('keeps fit-height scale stable when continuous scroll toggles on mixed-height PDFs', () => {
        const pageMetrics = [
            {
                width: 600,
                height: 800,
            },
            {
                width: 600,
                height: 900,
            },
            {
                width: 600,
                height: 800,
            },
        ] satisfies IPdfPageMetric[];
        const container = createContainer(1536, 900);
        const paged = createScaleComposable({
            width: 600,
            height: 900,
            pageMetrics,
            mode: 'height',
            currentPage: 1,
            continuousScroll: false,
        });
        const continuous = createScaleComposable({
            width: 600,
            height: 900,
            pageMetrics,
            mode: 'height',
            currentPage: 1,
            continuousScroll: true,
        });

        paged.scale.computeFitWidthScale(container);
        continuous.scale.computeFitWidthScale(container);

        expect(paged.scale.effectiveScale.value).toBeCloseTo(
            continuous.scale.effectiveScale.value,
            6,
        );
        expect(continuous.scale.effectiveScale.value * pageMetrics[0]!.height).toBeCloseTo(860, 6);
    });

    it('fits the current page width instead of the widest page in single-page mode', () => {
        const { scale } = createScaleComposable({
            width: 400,
            height: 500,
            pageMetrics: [
                {
                    width: 400,
                    height: 500,
                },
                {
                    width: 180,
                    height: 500,
                },
                {
                    width: 700,
                    height: 500,
                },
            ],
            mode: 'width',
            currentPage: 2,
        });
        const container = createContainer(1000, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * 180).toBeCloseTo(960, 6);
    });

    it('fits the current spread width in facing-page mode', () => {
        const pageMetrics = [
            {
                width: 300,
                height: 500,
            },
            {
                width: 220,
                height: 500,
            },
            {
                width: 280,
                height: 500,
            },
            {
                width: 600,
                height: 500,
            },
        ] satisfies IPdfPageMetric[];
        const { scale } = createScaleComposable({
            width: 300,
            height: 500,
            pageMetrics,
            mode: 'width',
            viewMode: 'facing',
            currentPage: 2,
        });
        const container = createContainer(1000, 900);

        scale.computeFitWidthScale(container);

        expect(
            scale.effectiveScale.value * (pageMetrics[0]!.width + pageMetrics[1]!.width),
        ).toBeCloseTo(940, 6);
    });

    it('uses the active facing spread row height for fit-height scale', () => {
        const pageMetrics = [
            {
                width: 600,
                height: 1000,
            },
            {
                width: 600,
                height: 700,
            },
            {
                width: 600,
                height: 800,
            },
        ] satisfies IPdfPageMetric[];
        const { scale } = createScaleComposable({
            width: 600,
            height: 1000,
            pageMetrics,
            mode: 'height',
            viewMode: 'facing-first-single',
            currentPage: 2,
            continuousScroll: false,
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container);

        expect(scale.effectiveScale.value * pageMetrics[2]!.height).toBeCloseTo(860, 6);
    });

    it('can fit-height against a pending navigation target before current page commits', () => {
        const pageMetrics = [
            {
                width: 320,
                height: 500,
            },
            {
                width: 600,
                height: 860,
            },
            {
                width: 600,
                height: 1_000,
            },
        ] satisfies IPdfPageMetric[];
        const {
            scale,
            currentPage,
        } = createScaleComposable({
            width: 320,
            height: 500,
            pageMetrics,
            mode: 'height',
            currentPage: 1,
            continuousScroll: false,
        });
        const container = createContainer(1536, 900);

        scale.computeFitWidthScale(container, { page: 3 });

        expect(currentPage.value).toBe(1);
        expect(scale.effectiveScale.value * pageMetrics[2]!.height).toBeCloseTo(860, 6);
    });
});
