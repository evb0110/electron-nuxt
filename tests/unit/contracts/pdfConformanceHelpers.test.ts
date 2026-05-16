import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    buildPdfSaveRestrictions as buildBrowserPdfSaveRestrictions,
    createDefaultPdfConformanceProfile as createBrowserDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText as detectBrowserPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText as hasBrowserPdfSignatureMarkersInPdfText,
} from '@app/platform/browser-api/browserPdfConformanceHelpers';
import {
    buildPdfSaveRestrictions as buildElectronPdfSaveRestrictions,
    createDefaultPdfConformanceProfile as createElectronDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText as detectElectronPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText as hasElectronPdfSignatureMarkersInPdfText,
} from '@electron/features/documents/main/pdfConformanceHelpers';

describe('PDF conformance contract helpers', () => {
    it('keeps browser and Electron default profiles aligned', () => {
        expect(createBrowserDefaultPdfConformanceProfile()).toEqual(createElectronDefaultPdfConformanceProfile());
        expect(createElectronDefaultPdfConformanceProfile()).toEqual({
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

    it('keeps browser and Electron save restriction policy aligned', () => {
        const restrictedProfile = {
            isSigned: true,
            isEncrypted: true,
            isTagged: true,
            pdfaLevel: 'PDF/A-2B',
            hasAcroForm: true,
            hasXfa: true,
            canIncrementalSave: false,
        };

        expect(buildBrowserPdfSaveRestrictions(restrictedProfile))
            .toEqual(buildElectronPdfSaveRestrictions(restrictedProfile));
        expect(buildElectronPdfSaveRestrictions(restrictedProfile)).toEqual([
            'signed_original_requires_save_as',
            'encrypted_document_requires_preservation',
            'xfa_forms_are_not_supported_for_rewrite',
            'tagged_pdf_requires_structure_preservation',
            'pdfa_preservation_required:PDF/A-2B',
            'incremental_save_not_supported',
        ]);
    });

    it('keeps browser and Electron PDF marker detection aligned', () => {
        const pdfaText = `
            <pdfaid:part>2</pdfaid:part>
            <pdfaid:conformance>b</pdfaid:conformance>
            /ByteRange [0 10 20 30]
        `;

        expect(detectBrowserPdfaLevelFromPdfText(pdfaText))
            .toBe(detectElectronPdfaLevelFromPdfText(pdfaText));
        expect(hasBrowserPdfSignatureMarkersInPdfText(pdfaText))
            .toBe(hasElectronPdfSignatureMarkersInPdfText(pdfaText));
    });
});
