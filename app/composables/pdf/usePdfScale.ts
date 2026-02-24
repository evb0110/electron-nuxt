import {
    ref,
    computed,
    toValue,
    type MaybeRefOrGetter,
} from 'vue';
import type { TFitMode } from '@app/types/pdf';
import type { TPdfViewMode } from '@app/types/shared';
import { getViewColumnCount } from '@app/utils/pdf-view-mode';
import { BrowserLogger } from '@app/utils/browser-logger';

const BASE_MARGIN = 20;

export const usePdfScale = (
    zoom: MaybeRefOrGetter<number>,
    fitMode: MaybeRefOrGetter<TFitMode>,
    viewMode: MaybeRefOrGetter<TPdfViewMode>,
    numPages: MaybeRefOrGetter<number>,
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
) => {
    const fitWidthScale = ref(1);
    const lastContainerSize = ref<number | null>(null);
    const lastBaseDimension = ref<number | null>(null);

    const effectiveScale = computed(() => toValue(zoom) * fitWidthScale.value);

    const containerStyle = computed(() => {
        return {
            padding: `${BASE_MARGIN}px`,
            gap: `${BASE_MARGIN}px`,
        };
    });

    const scaledMargin = computed(() => BASE_MARGIN);

    function computeFitWidthScale(container: HTMLElement | null): boolean {
        const width = toValue(basePageWidth);
        const height = toValue(basePageHeight);
        if (!container || !width || !height) {
            BrowserLogger.warn('pdf-nav', '[scale] skipped computeFitWidthScale: missing container/base dimensions', {
                hasContainer: Boolean(container),
                basePageWidth: width,
                basePageHeight: height,
            });
            return false;
        }

        const mode = toValue(fitMode);
        const rawSize = mode === 'height'
            ? container.clientHeight
            : container.clientWidth;

        if (rawSize <= 0) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: rawSize<=0 mode=${mode}`, {
                rawSize,
                clientWidth: container.clientWidth,
                clientHeight: container.clientHeight,
            });
            return false;
        }

        const columns = mode === 'height'
            ? 1
            : getViewColumnCount(toValue(viewMode), toValue(numPages));
        const availableSize = mode === 'height'
            ? rawSize - BASE_MARGIN * 2
            : rawSize - BASE_MARGIN * (columns + 1);
        if (availableSize <= 0) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: availableSize<=0 mode=${mode}`, {
                rawSize,
                columns,
                baseMargin: BASE_MARGIN,
                availableSize,
            });
            return false;
        }
        const baseDimension = mode === 'height'
            ? height
            : width * columns;

        if (
            lastContainerSize.value !== null
            && lastBaseDimension.value !== null
            && Math.abs(rawSize - lastContainerSize.value) < 1
            && Math.abs(baseDimension - lastBaseDimension.value) < 0.001
        ) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: dimensions unchanged mode=${mode}`, {
                rawSize,
                previousRawSize: lastContainerSize.value,
                baseDimension,
                previousBaseDimension: lastBaseDimension.value,
            });
            return false;
        }

        lastContainerSize.value = rawSize;
        lastBaseDimension.value = baseDimension;

        const newScale = availableSize / baseDimension;

        if (Math.abs(newScale - fitWidthScale.value) < 0.001) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: delta below epsilon mode=${mode}`, {
                currentScale: fitWidthScale.value,
                newScale,
                availableSize,
                baseDimension,
                epsilon: 0.001,
            });
            return false;
        }

        BrowserLogger.warn('pdf-nav', `[scale] computeFitWidthScale mode=${mode} columns=${columns} ${fitWidthScale.value.toFixed(4)}->${newScale.toFixed(4)}`, {
            rawSize,
            availableSize,
            baseDimension,
            basePageWidth: width,
            basePageHeight: height,
            zoom: toValue(zoom),
            viewMode: toValue(viewMode),
            numPages: toValue(numPages),
            previousScale: fitWidthScale.value,
            nextScale: newScale,
        });
        fitWidthScale.value = newScale;
        return true;
    }

    function resetScale() {
        fitWidthScale.value = 1;
        lastContainerSize.value = null;
        lastBaseDimension.value = null;
    }

    return {
        fitWidthScale,
        effectiveScale,
        containerStyle,
        scaledMargin,
        computeFitWidthScale,
        resetScale,
    };
};
