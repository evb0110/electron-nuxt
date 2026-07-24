import type {IScanCleanupPreviewResult} from '@contracts/scan-cleanup/ipc';
import type {TScanCleanupOutputModeRecommendationReason} from '@contracts/scan-cleanup/domain';

export function isScanCleanupOutputMode(
    value: unknown,
): value is NonNullable<IScanCleanupPreviewResult['pageMetadata']['recommendedOutputMode']> {
    return value === 'bw' || value === 'mixed' || value === 'grayscale' || value === 'color';
}

export function isScanCleanupOutputModeRecommendationReason(
    value: unknown,
): value is TScanCleanupOutputModeRecommendationReason {
    return value === 'blank'
        || value === 'color-chroma'
        || value === 'text-with-pictures'
        || value === 'continuous-tone'
        || value === 'bimodal-text'
        || value === 'uncertain-tonal';
}
