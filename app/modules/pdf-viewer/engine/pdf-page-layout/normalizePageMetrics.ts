import {isFinitePositive} from '@contracts/runtimeGuards';
import type { IPdfPageMetric } from '@app/types/pdf';


function isValidPageMetric(metric: IPdfPageMetric | null | undefined): metric is IPdfPageMetric {
    return isFinitePositive(metric?.width) && isFinitePositive(metric?.height);
}

function clonePageMetric(metric: IPdfPageMetric): IPdfPageMetric {
    return {
        width: metric.width,
        height: metric.height,
    };
}

function resolveNearestMetricEstimate(
    before: {
        index: number;
        metric: IPdfPageMetric;
    } | null,
    after: {
        index: number;
        metric: IPdfPageMetric;
    } | null,
    targetIndex: number,
    fallbackMetric: IPdfPageMetric,
) {
    if (before && after) {
        const beforeDistance = targetIndex - before.index;
        const afterDistance = after.index - targetIndex;
        return beforeDistance <= afterDistance ? before.metric : after.metric;
    }

    return before?.metric ?? after?.metric ?? fallbackMetric;
}

export function normalizePageMetrics(options: {
    pageMetrics: IPdfPageMetric[];
    totalPages: number;
    fallbackWidth: number | null;
    fallbackHeight: number | null;
}): IPdfPageMetric[] {
    const {
        pageMetrics,
        totalPages,
        fallbackWidth,
        fallbackHeight,
    } = options;

    if (totalPages <= 0) {
        return [];
    }

    const safeFallbackWidth = isFinitePositive(fallbackWidth) ? fallbackWidth : 1;
    const safeFallbackHeight = isFinitePositive(fallbackHeight) ? fallbackHeight : 1;
    const fallbackMetric = {
        width: safeFallbackWidth,
        height: safeFallbackHeight,
    } satisfies IPdfPageMetric;
    const nearestBefore: Array<{
        index: number;
        metric: IPdfPageMetric;
    } | null> = Array.from({ length: totalPages }, () => null);
    let previousKnownMetric: {
        index: number;
        metric: IPdfPageMetric;
    } | null = null;

    for (let index = 0; index < totalPages; index += 1) {
        nearestBefore[index] = previousKnownMetric;
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            previousKnownMetric = {
                index,
                metric,
            };
        }
    }

    const normalizedMetrics = new Array<IPdfPageMetric>(totalPages);
    let nextKnownMetric: {
        index: number;
        metric: IPdfPageMetric;
    } | null = null;

    for (let index = totalPages - 1; index >= 0; index -= 1) {
        const metric = pageMetrics[index];
        if (isValidPageMetric(metric)) {
            normalizedMetrics[index] = clonePageMetric(metric);
            nextKnownMetric = {
                index,
                metric,
            };
            continue;
        }

        normalizedMetrics[index] = clonePageMetric(resolveNearestMetricEstimate(
            nearestBefore[index] ?? null,
            nextKnownMetric,
            index,
            fallbackMetric,
        ));
    }

    return normalizedMetrics;
}
