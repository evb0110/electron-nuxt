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

    function resolveFitHeightBaseDimension(
        normalizedPageMetrics: IPdfPageMetric[],
        documentBaseHeight: number,
    ) {
        // Fit-height should be anchored to the active page instead of the
        // tallest page in the document so toggling continuous scroll does
        // not nudge the zoom level on mixed-height PDFs.
        const page = toValue(currentPage);
        const pageHeight = normalizedPageMetrics[page - 1]?.height ?? null;
        return (pageHeight != null && pageHeight > 0) ? pageHeight : documentBaseHeight;
    }

    function getFitRawSize(container: HTMLElement, mode: TFitMode) {
        return mode === 'height'
            ? container.clientHeight
            : container.clientWidth;
    }

    function getFitAvailableSize(rawSize: number, mode: TFitMode) {
        if (mode === 'height') {
            return rawSize - BASE_MARGIN * 2;
        }

        const columns = getViewColumnCount(toValue(viewMode), toValue(numPages));
        return rawSize - BASE_MARGIN * (columns + 1);
    }

    function hasUnchangedFitDimensions(rawSize: number, baseDimension: number) {
        return lastContainerSize.value !== null
            && lastBaseDimension.value !== null
            && Math.abs(rawSize - lastContainerSize.value) < 1
            && Math.abs(baseDimension - lastBaseDimension.value) < 0.001;
    }

    function rememberFitDimensions(rawSize: number, baseDimension: number) {
        lastContainerSize.value = rawSize;
        lastBaseDimension.value = baseDimension;
    }

    function logMissingFitDimensions(
        container: HTMLElement | null,
        normalizedPageMetrics: IPdfPageMetric[],
        spreadBaseWidth: number | null,
        documentBaseHeight: number | null,
    ) {
        BrowserLogger.warn('pdf-nav', '[scale] skipped computeFitWidthScale: missing container/base dimensions', {
            hasContainer: Boolean(container),
            basePageWidth: toValue(basePageWidth),
            basePageHeight: toValue(basePageHeight),
            normalizedPageMetricsCount: normalizedPageMetrics.length,
            spreadBaseWidth,
            documentBaseHeight,
        });
    }

    function computeFitWidthScale(container: HTMLElement | null): boolean {
        const totalPages = toValue(numPages);
        const normalizedPageMetrics = getNormalizedPageMetrics();
        const height = resolveDocumentBaseMetric(normalizedPageMetrics, 'height');
        const width = resolveSpreadBaseWidth(
            normalizedPageMetrics,
            toValue(viewMode),
            totalPages,
        );

        if (!container || !width || !height) {
            logMissingFitDimensions(container, normalizedPageMetrics, width, height);
            return false;
        }

        const mode = toValue(fitMode);
        const rawSize = getFitRawSize(container, mode);

        if (rawSize <= 0) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: rawSize<=0 mode=${mode}`, {
                rawSize,
                clientWidth: container.clientWidth,
                clientHeight: container.clientHeight,
            });
            return false;
        }

        const availableSize = getFitAvailableSize(rawSize, mode);
        if (availableSize <= 0) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: availableSize<=0 mode=${mode}`, {
                rawSize,
                baseMargin: BASE_MARGIN,
                availableSize,
            });
            return false;
        }
        const baseDimension = mode === 'height'
            ? resolveFitHeightBaseDimension(normalizedPageMetrics, height)
            : width;

        if (hasUnchangedFitDimensions(rawSize, baseDimension)) {
            BrowserLogger.warn('pdf-nav', `[scale] skipped computeFitWidthScale: dimensions unchanged mode=${mode}`, {
                rawSize,
                previousRawSize: lastContainerSize.value,
                baseDimension,
                previousBaseDimension: lastBaseDimension.value,
            });
            return false;
        }

        rememberFitDimensions(rawSize, baseDimension);

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
            basePageWidth: toValue(basePageWidth),
            basePageHeight: toValue(basePageHeight),
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
