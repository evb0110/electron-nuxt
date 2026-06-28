import type {
    IPdfConformanceProfile,
    IPdfValidationResult,
} from '@contracts/pdfConformance';
import {
    analyzePdfConformanceFile,
    validatePdfData as validatePdfBytes,
    validatePdfFile,
} from '@electron/features/documents/main/pdfConformance';
import { resolveExistingReadablePdfPath } from '@electron/features/documents/main/documentFilePathResolution';
import type { IDocumentsSenderIdContext } from '@electron/features/documents/documentsService';

export async function handleAnalyzePdfConformance(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfConformanceProfile> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    return analyzePdfConformanceFile(resolvedPath);
}

export async function handleValidatePdfData(
    data: unknown,
    fileName?: unknown,
): Promise<IPdfValidationResult> {
    if (!(data instanceof Uint8Array)) {
        throw new Error('Invalid data: must be a Uint8Array');
    }
    if (typeof fileName !== 'undefined' && typeof fileName !== 'string') {
        throw new Error('Invalid file name: must be a string');
    }

    return validatePdfBytes(data, fileName);
}

export async function handleValidatePdfPath(
    context: IDocumentsSenderIdContext,
    filePath: unknown,
): Promise<IPdfValidationResult> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, context.senderId);
    return validatePdfFile(resolvedPath);
}
