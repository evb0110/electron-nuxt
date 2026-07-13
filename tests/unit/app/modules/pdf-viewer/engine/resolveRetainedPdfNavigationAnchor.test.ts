import {
    describe,
    expect,
    it,
} from 'vitest';
import {resolveRetainedPdfNavigationAnchor} from '@app/modules/pdf-viewer/engine/pdf-navigation-anchor-retention/resolveRetainedPdfNavigationAnchor';

describe('resolveRetainedPdfNavigationAnchor', () => {
    it('replaces the retained row when a new navigation begins', () => {
        expect(resolveRetainedPdfNavigationAnchor({
            pendingTargetPage: 100,
            retainedTargetPage: 21,
            explicitCancel: false,
        })).toBe(100);
    });

    it('retains the destination after authority finishes navigation', () => {
        expect(resolveRetainedPdfNavigationAnchor({
            pendingTargetPage: null,
            retainedTargetPage: 100,
            explicitCancel: false,
        })).toBe(100);
    });

    it('clears the destination only for an explicit cancellation', () => {
        expect(resolveRetainedPdfNavigationAnchor({
            pendingTargetPage: null,
            retainedTargetPage: 100,
            explicitCancel: true,
        })).toBeNull();
    });
});
