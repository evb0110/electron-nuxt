import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    clearPdfValidationRevisionCacheForTests,
    validatePdfRevision,
} from '@app/modules/workspace-shell/composables/document-session/pdfValidationRevisionCache';

const validResult = {
    isValid: true,
    tool: 'qpdf' as const,
    errors: [],
    warnings: [],
};

describe('PDF validation revision cache', () => {
    beforeEach(() => clearPdfValidationRevisionCacheForTests());

    it('hits unchanged source identity and misses after replacement', async () => {
        const validate = vi.fn(async () => validResult);
        const revision = {
            documentId: '/documents/dictionary.pdf',
            size: 170_496_793,
            modifiedAt: 1_724_000_000_000,
        };

        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'hit'});
        await expect(validatePdfRevision({
            ...revision,
            modifiedAt: revision.modifiedAt + 1,
        }, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision({
            ...revision,
            size: revision.size + 1,
        }, validate)).resolves.toMatchObject({cacheResult: 'miss'});

        expect(validate).toHaveBeenCalledTimes(3);
    });

    it('coalesces concurrent validation for the same revision', async () => {
        const gate = Promise.withResolvers<typeof validResult>();
        const validate = vi.fn(() => gate.promise);
        const revision = {
            documentId: '/documents/dictionary.pdf',
            size: 170_496_793,
            modifiedAt: 1_724_000_000_000,
        };

        const first = validatePdfRevision(revision, validate);
        const second = validatePdfRevision(revision, validate);
        gate.resolve(validResult);

        await expect(first).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(second).resolves.toMatchObject({cacheResult: 'coalesced'});
        expect(validate).toHaveBeenCalledOnce();
    });

    it('does not cache a failed validation', async () => {
        const invalidResult = {
            isValid: false,
            tool: 'qpdf' as const,
            errors: ['damaged xref table'],
            warnings: [],
        };
        const validate = vi.fn(async () => invalidResult);
        const revision = {
            documentId: '/documents/corrupt.pdf',
            size: 1_024,
            modifiedAt: 1_724_000_000_000,
        };

        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        await expect(validatePdfRevision(revision, validate)).resolves.toMatchObject({cacheResult: 'miss'});
        expect(validate).toHaveBeenCalledTimes(2);
    });
});
