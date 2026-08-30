import {
    describe,
    expect,
    it,
} from 'vitest';
import { shouldClearPreservedAnnotationSourceDirty } from '@app/modules/workspace-shell/annotations/shouldClearPreservedAnnotationSourceDirty';

describe('workspace preserved annotation source reconciliation', () => {
    it('clears shape-only dirty state while retaining real PDF.js editor changes', () => {
        expect(shouldClearPreservedAnnotationSourceDirty({
            isDirty: true,
            hasSavedPdfJsFingerprint: true,
            hasLivePdfJsChanges: false,
        })).toBe(true);

        expect(shouldClearPreservedAnnotationSourceDirty({
            isDirty: true,
            hasSavedPdfJsFingerprint: true,
            hasLivePdfJsChanges: true,
        })).toBe(false);

        expect(shouldClearPreservedAnnotationSourceDirty({
            isDirty: false,
            hasSavedPdfJsFingerprint: true,
            hasLivePdfJsChanges: false,
        })).toBe(false);

        expect(shouldClearPreservedAnnotationSourceDirty({
            isDirty: true,
            hasSavedPdfJsFingerprint: false,
            hasLivePdfJsChanges: false,
        })).toBe(false);
    });
});
