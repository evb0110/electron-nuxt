import type { IScanCleanupPreviewResult } from '@contracts/electronApiScanCleanup';

export function isScanCleanupOutputMode(
    value: unknown,
): value is NonNullable<IScanCleanupPreviewResult['pageMetadata']['recommendedOutputMode']> {
    return value === 'bw' || value === 'mixed' || value === 'grayscale' || value === 'color';
}
