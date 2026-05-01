import { readFile } from 'fs/promises';
import {
    buildPdfSaveRestrictions,
    createDefaultPdfConformanceProfile,
    detectPdfaLevelFromPdfText,
    hasPdfSignatureMarkersInPdfText,
} from '@contracts/electron-api';
import type { IPdfConformanceProfile } from '@contracts/electron-api';
import { createLogger } from '@electron/utils/logger';
import {
    PDFDict,
    PDFDocument,
    PDFName,
} from 'pdf-lib';
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
        const doc = await PDFDocument.load(data, {
            ignoreEncryption: true,
            updateMetadata: false,
        });
        const catalog = doc.catalog;
        const acroForm = catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
        const structTreeRoot = catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict);

        const profileBase = {
            isSigned: hasPdfSignatureMarkersInPdfText(decodePdfBytes(data)),
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot instanceof PDFDict,
            pdfaLevel: detectPdfaLevelFromPdfText(decodePdfBytes(data)),
            hasAcroForm: acroForm instanceof PDFDict,
            hasXfa: acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA')),
            canIncrementalSave: !doc.isEncrypted && !(acroForm instanceof PDFDict && acroForm.has(PDFName.of('XFA'))),
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
