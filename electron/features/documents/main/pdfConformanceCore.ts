import { readFile } from 'fs/promises';
import {
    buildPdfSaveRestrictions,
    createConservativePdfConformanceFallbackProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@pdf-core/pdfConformanceHelpers';
import type { IPdfConformanceProfile } from '@contracts/pdfConformance';
import { createLogger } from '@electron/utils/logger';
import { loadPdfStructure } from '@pdf-core/pdfConformanceLoad';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-pdfConformance');

function decodePdfBytes(data: Uint8Array) {
    return Buffer.from(data).toString('latin1');
}

async function analyzePdfConformanceData(
    data: Uint8Array,
): Promise<IPdfConformanceProfile> {
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
        const decodedBytes = decodePdfBytes(data);
        return createConservativePdfConformanceFallbackProfile({
            isSigned: hasPdfSignatureMarkersInPdfText(decodedBytes),
            isEncrypted: hasPdfEncryptMarkersInPdfText(decodedBytes),
            pdfaLevel: detectPdfaLevelFromPdfText(decodedBytes),
        });
    }
}

export async function analyzePdfConformanceFileDirect(
    filePath: string,
): Promise<IPdfConformanceProfile> {
    const data = await readFile(filePath);
    return analyzePdfConformanceData(new Uint8Array(data));
}
