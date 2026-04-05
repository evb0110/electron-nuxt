import type { MaybeRefOrGetter } from 'vue';
import type {
    IPdfPageMetric,
    TFitMode,
} from '@app/types/pdf';
import type { TPdfViewMode } from '@contracts/shared';
import { getViewColumnCount } from '@app/utils/pdf-view-mode';
import { BrowserLogger } from '@app/utils/browser-logger';
import {
    normalizePageMetrics,
    resolveDocumentBaseMetric,
    resolveSpreadBaseWidth,
} from '@app/composables/pdf/pdfPageLayout';

const BASE_MARGIN = 20;

export const usePdfScale = (
    zoom: MaybeRefOrGetter<number>,
    fitMode: MaybeRefOrGetter<TFitMode>,
    viewMode: MaybeRefOrGetter<TPdfViewMode>,
    numPages: MaybeRefOrGetter<number>,
    pageMetrics: MaybeRefOrGetter<IPdfPageMetric[]>,
    pageMetricsVersion: MaybeRefOrGetter<number>,
    basePageWidth: MaybeRefOrGetter<number | null>,
    basePageHeight: MaybeRefOrGetter<number | null>,
    currentPage: MaybeRefOrGetter<number>,
    _continuousScroll: MaybeRefOrGetter<boolean>,
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

    let normalizedMetricsCacheKey = '';
    let normalizedMetricsCacheValue: IPdfPageMetric[] = [];

    function getNormalizedPageMetrics() {
        const totalPages = toValue(numPages);
        const fallbackWidth = toValue(basePageWidth);
        const fallbackHeight = toValue(basePageHeight);
        const cacheKey = [
            toValue(pageMetricsVersion),
            totalPages,
            fallbackWidth ?? 'null',
            fallbackHeight ?? 'null',
        ].join('|');

        if (cacheKey === normalizedMetricsCacheKey) {
            return normalizedMetricsCacheValue;
        }

        normalizedMetricsCacheKey = cacheKey;
        normalizedMetricsCacheValue = normalizePageMetrics({
            pageMetrics: toValue(pageMetrics),
            totalPages,
            fallbackWidth,
            fallbackHeight,
        });
        return normalizedMetricsCacheValue;
    }

    function computeFitWidthScale(container: HTMLElement | null): boolean {
        const fallbackWidth = toValue(basePageWidth);
        const fallbackHeight = toValue(basePageHeight);
        const totalPages = toValue(numPages);
        const normalizedPageMetrics = getNormalizedPageMetrics();
        const height = resolveDocumentBaseMetric(normalizedPageMetrics, 'height');
        const width = resolveSpreadBaseWidth(
            normalizedPageMetrics,
            toValue(viewMode),
            totalPages,
        );

        if (!container || !width || !height) {
            BrowserLogger.warn('pdf-nav', '[scale] skipped computeFitWidthScale: missing container/base dimensions', {
                hasContainer: Boolean(container),
                basePageWidth: fallbackWidth,
                basePageHeight: fallbackHeight,
                normalizedPageMetricsCount: normalizedPageMetrics.length,
                spreadBaseWidth: width,
                documentBaseHeight: height,
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
                baseMargin: BASE_MARGIN,
                availableSize,
            });
            return false;
        }
        const baseDimension = (() => {
            if (mode !== 'height') {
                return width;
            }

            // Fit-height should be anchored to the active page instead of the
            // tallest page in the document so toggling continuous scroll does
            // not nudge the zoom level on mixed-height PDFs.
            const page = toValue(currentPage);
            const pageHeight = normalizedPageMetrics[page - 1]?.height ?? null;
            return (pageHeight != null && pageHeight > 0) ? pageHeight : height;
        })();

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

        BrowserLogger.warn('pdf-nav', `[scale] computeFitWidthScale mode=${mode} ${fitWidthScale.value.toFixed(4)}->${newScale.toFixed(4)}`, {
            rawSize,
            availableSize,
            baseDimension,
            basePageWidth: fallbackWidth,
            basePageHeight: fallbackHeight,
            spreadBaseWidth: width,
            documentBaseHeight: height,
            zoom: toValue(zoom),
            viewMode: toValue(viewMode),
            numPages: totalPages,
            previousScale: fitWidthScale.value,
            nextScale: newScale,
        });
        fitWidthScale.value = newScale;
        return true;
    }

    function invalidateScaleCache() {
        lastContainerSize.value = null;
        lastBaseDimension.value = null;
    }

    function resetScale() {
        fitWidthScale.value = 1;
        invalidateScaleCache();
    }

    return {
        fitWidthScale,
        effectiveScale,
        containerStyle,
        scaledMargin,
        computeFitWidthScale,
        invalidateScaleCache,
        resetScale,
    };
};
