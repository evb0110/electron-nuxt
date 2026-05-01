import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
} from '@contracts/electron-api';

describe('PDF conformance contract helpers', () => {
    it('creates the unrestricted default profile', () => {
        expect(createDefaultPdfConformanceProfile()).toEqual({
            isSigned: false,
            isEncrypted: false,
            isTagged: false,
            pdfaLevel: null,
            hasAcroForm: false,
            hasXfa: false,
            canIncrementalSave: true,
            saveRestrictions: [],
        });
    });

    it('builds save restrictions in stable policy order', () => {
        expect(buildPdfSaveRestrictions({
            isSigned: true,
            isEncrypted: true,
            isTagged: true,
            pdfaLevel: 'PDF/A-2B',
            hasAcroForm: true,
            hasXfa: true,
            canIncrementalSave: false,
        })).toEqual([
            'signed_original_requires_save_as',
            'encrypted_document_requires_preservation',
            'xfa_forms_are_not_supported_for_rewrite',
            'tagged_pdf_requires_structure_preservation',
            'pdfa_preservation_required:PDF/A-2B',
            'incremental_save_not_supported',
        ]);
    });
});
