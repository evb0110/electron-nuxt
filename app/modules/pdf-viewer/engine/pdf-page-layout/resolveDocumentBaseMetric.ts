import type { IPdfPageMetric } from '@app/types/pdf';

function isFinitePositive(value: number | null | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function resolveDocumentBaseMetric(
    pageMetrics: IPdfPageMetric[],
    dimension: 'width' | 'height',
) {
    let maxValue = 0;

    for (const metric of pageMetrics) {
        const value = metric?.[dimension];
        if (!isFinitePositive(value)) {
            continue;
        }
        maxValue = Math.max(maxValue, value);
    }

    return maxValue > 0 ? maxValue : null;
}
