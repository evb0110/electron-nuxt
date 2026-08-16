import {
    describe,
    expect,
    it,
} from 'vitest';
import {formatScanCleanupErrorMessage} from '@app/modules/scan-cleanup/runtime/formatScanCleanupErrorMessage';

describe('formatScanCleanupErrorMessage', () => {
    it('keeps the localized fallback as the main message and appends raw detail', () => {
        expect(formatScanCleanupErrorMessage(
            'scanCleanup.failed',
            new Error('native bridge failed'),
        )).toBe('scanCleanup.failed (native bridge failed)');
    });

    it('does not duplicate an already-localized detail', () => {
        expect(formatScanCleanupErrorMessage('Page detection failed.', 'Page detection failed.'))
            .toBe('Page detection failed.');
    });

    it('bounds opaque technical detail', () => {
        const detail = 'x'.repeat(300);
        expect(formatScanCleanupErrorMessage('scanCleanup.failed', detail))
            .toBe(`scanCleanup.failed (${`${'x'.repeat(237)}...`})`);
    });
});
