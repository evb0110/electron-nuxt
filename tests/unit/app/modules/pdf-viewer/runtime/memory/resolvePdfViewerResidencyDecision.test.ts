import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    resolvePdfViewerResidencyDecision,
    resolvePostReclaimResidencyState,
} from '@app/modules/pdf-viewer/runtime/memory/resolvePdfViewerResidencyDecision';

describe('PDF viewer residency state', () => {
    it('keeps active viewers active and not reclaimable', () => {
        expect(resolvePdfViewerResidencyDecision({
            isActive: true,
            isAnySaving: false,
            hasReclaimableDocumentCaches: true,
        })).toEqual({
            state: 'active',
            shouldCleanupDocumentCaches: false,
        });
    });

    it('marks inactive non-saving PDF caches as hibernating reclaim work', () => {
        const decision = resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: false,
            hasReclaimableDocumentCaches: true,
            previousState: 'active',
        });

        expect(decision).toEqual({
            state: 'hibernating',
            shouldCleanupDocumentCaches: true,
        });
        expect(resolvePostReclaimResidencyState(decision.state)).toBe('hibernated');
    });

    it('keeps inactive saving viewers warm until save-sensitive cleanup is allowed', () => {
        expect(resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: true,
            hasReclaimableDocumentCaches: true,
            previousState: 'active',
        })).toEqual({
            state: 'warm',
            shouldCleanupDocumentCaches: false,
        });
    });

    it('treats inactive viewers without reclaimable document caches as already hibernated', () => {
        expect(resolvePdfViewerResidencyDecision({
            isActive: false,
            isAnySaving: false,
            hasReclaimableDocumentCaches: false,
            previousState: 'warm',
        })).toEqual({
            state: 'hibernated',
            shouldCleanupDocumentCaches: false,
        });
    });
});
