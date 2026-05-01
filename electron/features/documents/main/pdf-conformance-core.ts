import { readFile } from 'fs/promises';
import type { IPdfConformanceProfile } from '@contracts/electron-api';
import { createLogger } from '@electron/utils/logger';
import {
    PDFDict,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-pdf-conformance');

const PDFA_PART_PATTERN = /<pdfaid:part>\s*([^<\s]+)\s*<\/pdfaid:part>/iu;
const PDFA_CONFORMANCE_PATTERN = /<pdfaid:conformance>\s*([^<\s]+)\s*<\/pdfaid:conformance>/iu;
const SIGNATURE_PATTERN = /\/(?:ByteRange|FT\s*\/Sig|Type\s*\/Sig)\b/u;

export function getDefaultPdfConformanceProfile(): IPdfConformanceProfile {
    return {
        isSigned: false,
        isEncrypted: false,
        isTagged: false,
        pdfaLevel: null,
        hasAcroForm: false,
        hasXfa: false,
        canIncrementalSave: true,
        saveRestrictions: [],
    };
}

function decodePdfBytes(data: Uint8Array) {
    return Buffer.from(data).toString('latin1');
}

function detectPdfaLevel(data: Uint8Array) {
    const text = decodePdfBytes(data);
    const partMatch = text.match(PDFA_PART_PATTERN);
    if (!partMatch?.[1]) {
        return null;
    }

    const conformanceMatch = text.match(PDFA_CONFORMANCE_PATTERN);
    const conformance = conformanceMatch?.[1]?.trim().toUpperCase() ?? '';
    return `PDF/A-${partMatch[1].trim()}${conformance}`;
}

function detectSignatureMarkers(data: Uint8Array) {
    return SIGNATURE_PATTERN.test(decodePdfBytes(data));
}

function buildSaveRestrictions(profile: Omit<IPdfConformanceProfile, 'saveRestrictions'>) {
    const restrictions: string[] = [];

    if (profile.isSigned) {
        restrictions.push('signed_original_requires_save_as');
    }
    if (profile.isEncrypted) {
        restrictions.push('encrypted_document_requires_preservation');
    }
    if (profile.hasXfa) {
        restrictions.push('xfa_forms_are_not_supported_for_rewrite');
    }
    if (profile.isTagged) {
        restrictions.push('tagged_pdf_requires_structure_preservation');
    }
    if (profile.pdfaLevel) {
        restrictions.push(`pdfa_preservation_required:${profile.pdfaLevel}`);
    }
    if (!profile.canIncrementalSave) {
        restrictions.push('incremental_save_not_supported');
    }

    return restrictions;
}

async function analyzePdfConformanceData(
    data: Uint8Array,
): Promise<IPdfConformanceProfile> {
    const fallback = getDefaultPdfConformanceProfile();

    try {
        const doc = await PDFDocument.load(data, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const catalog = doc.catalog;
        const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
        const structTreeRoot = catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);

        const profileBase = {
            isSigned: detectSignatureMarkers(data),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot instanceof PDFDict,
            pdfaLevel: detectPdfaLevel(data),
            hasAcroForm: acroForm instanceof PDFDict,
            hasXfa: acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA')),
            canIncrementalSave: !doc.isEncrypted && !(acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA'))),
        };

        return {
            ...profileBase,
            saveRestrictions: buildSaveRestrictions(profileBase),
        };
    } catch (error) {
        logger.warn(`Failed to analyze PDF conformance: ${getErrorMessage(error)}`);
        return {
            ...fallback,
            isSigned: detectSignatureMarkers(data),
            pdfaLevel: detectPdfaLevel(data),
            saveRestrictions: buildSaveRestrictions({
                ...fallback,
                isSigned: detectSignatureMarkers(data),
                pdfaLevel: detectPdfaLevel(data),
            }),
        };
    }
}

export async function analyzePdfConformanceFileDirect(
    filePath: string,
): Promise<IPdfConformanceProfile> {
    const data = await readFile(filePath);
    return analyzePdfConformanceData(new Uint8Array(data));
}
