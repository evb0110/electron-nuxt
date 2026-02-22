import {
    describe,
    expect,
    it,
} from 'vitest';
import { ref } from 'vue';
import { usePdfScale } from '@app/composables/pdf/usePdfScale';
import type { TFitMode } from '@app/types/pdf';
import type { TPdfViewMode } from '@app/types/shared';

function createContainer(
    width: number,
    height: number,
): HTMLElement {
    return {
        clientWidth: width,
        clientHeight: height,
    } as HTMLElement;
}

function createScaleComposable(options: {
    width: number;
    height: number;
    mode?: TFitMode;
    zoom?: number;
    viewMode?: TPdfViewMode;
}) {
    const zoom = ref(options.zoom ?? 1);
    const fitMode = ref<TFitMode>(options.mode ?? 'width');
    const viewMode = ref<TPdfViewMode>(options.viewMode ?? 'single');
    const numPages = ref(1);
    const baseWidth = ref(options.width);
    const baseHeight = ref(options.height);

    return {
        baseWidth,
        baseHeight,
        scale: usePdfScale(
            zoom,
            fitMode,
            viewMode,
            numPages,
            baseWidth,
            baseHeight,
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
});
