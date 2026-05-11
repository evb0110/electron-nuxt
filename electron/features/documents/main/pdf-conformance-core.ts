import { readFile } from 'fs/promises';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@electron/features/documents/main/pdf-conformance-helpers';
import type { IPdfConformanceProfile } from '@contracts/pdf-conformance';
import { createLogger } from '@electron/utils/logger';
import { loadPdfStructure } from '@contracts/pdf-conformance-load';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-pdf-conformance');

function decodePdfBytes(data: Uint8Array) {
    return Buffer.from(data).toString('latin1');
}

async function analyzePdfConformanceData(
    data: Uint8Array,
): Promise<IPdfConformanceProfile> {
    const fallback = createDefaultPdfConformanceProfile();

    try {
        const {
            doc,
            acroForm,
            structTreeRoot,
            hasXfa,
        } = await loadPdfStructure(data);

        const profileBase = {
            isSigned: hasPdfSignatureMarkersInPdfText(decodePdfBytes(data)),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot !== null,
            pdfaLevel: detectPdfaLevelFromPdfText(decodePdfBytes(data)),
            hasAcroForm: acroForm !== null,
            hasXfa,
            canIncrementalSave: !doc.isEncrypted && !hasXfa,
        };

        return {
            ...profileBase,
            saveRestrictions: buildPdfSaveRestrictions(profileBase),
        };
    } catch (error) {
        logger.warn(`Failed to analyze PDF conformance: ${getErrorMessage(error)}`);
        return {
            ...fallback,
            isSigned: hasPdfSignatureMarkersInPdfText(decodePdfBytes(data)),
            pdfaLevel: detectPdfaLevelFromPdfText(decodePdfBytes(data)),
            saveRestrictions: buildPdfSaveRestrictions({
                ...fallback,
                isSigned: hasPdfSignatureMarkersInPdfText(decodePdfBytes(data)),
                pdfaLevel: detectPdfaLevelFromPdfText(decodePdfBytes(data)),
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
