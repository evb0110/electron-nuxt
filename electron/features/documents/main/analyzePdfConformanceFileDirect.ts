import { readFile } from 'fs/promises';
import {
    buildPdfSaveRestrictions,
    createConservativePdfConformanceFallbackProfile,
    detectPdfaLevelFromPdfText,
    hasPdfEncryptMarkersInPdfText,
    hasPdfSignatureMarkersInPdfText,
    loadPdfStructure,
} from '@pdf-core';
import type { IPdfConformanceProfile } from '@contracts/pdfConformance';
import { createLogger } from '@electron/utils/createLogger';
import { getErrorMessage } from '@electron/utils/error';

const logger = createLogger('documents-pdfConformance');

const PDF_MARKER_SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const PDF_MARKER_SCAN_OVERLAP_BYTES = 4 * 1024;

interface IPdfMarkerEvidence {
    isSigned: boolean;
    isEncrypted: boolean;
    pdfaLevel: ReturnType<typeof detectPdfaLevelFromPdfText>;
}

/**
 * Conformance markers are ASCII tokens. Decode bounded, overlapping windows
 * instead of turning an arbitrarily large PDF into one V8 string: a cleaned
 * raster document can legally exceed V8's maximum string length even though
 * pdf-lib can still inspect its byte array.
 */
function scanPdfMarkerEvidence(data: Uint8Array): IPdfMarkerEvidence {
    let isSigned = false;
    let isEncrypted = false;
    let pdfaLevel: IPdfMarkerEvidence['pdfaLevel'] = null;

    for (let offset = 0; offset < data.byteLength;) {
        const end = Math.min(data.byteLength, offset + PDF_MARKER_SCAN_CHUNK_BYTES);
        const text = Buffer.from(data.buffer, data.byteOffset + offset, end - offset)
            .toString('latin1');
        isSigned ||= hasPdfSignatureMarkersInPdfText(text);
        isEncrypted ||= hasPdfEncryptMarkersInPdfText(text);
        pdfaLevel ??= detectPdfaLevelFromPdfText(text);
        if (end === data.byteLength) break;
        offset = Math.max(offset + 1, end - PDF_MARKER_SCAN_OVERLAP_BYTES);
    }

    return {
        isSigned,
        isEncrypted,
        pdfaLevel,
    };
}

async function analyzePdfConformanceData(
    data: Uint8Array,
): Promise<IPdfConformanceProfile> {
    const markerEvidence = scanPdfMarkerEvidence(data);
    try {
        const {
            doc,
            acroForm,
            structTreeRoot,
            hasXfa,
        } = await loadPdfStructure(data);

        const profileBase = {
            isSigned: markerEvidence.isSigned,
            isEncrypted: doc.isEncrypted,
            isTagged: structTreeRoot !== null,
            pdfaLevel: markerEvidence.pdfaLevel,
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
        return createConservativePdfConformanceFallbackProfile({...markerEvidence});
    }
}

export async function analyzePdfConformanceFileDirect(
    filePath: string,
): Promise<IPdfConformanceProfile> {
    const data = await readFile(filePath);
    return analyzePdfConformanceData(new Uint8Array(data));
}
