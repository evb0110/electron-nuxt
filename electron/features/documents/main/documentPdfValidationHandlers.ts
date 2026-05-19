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

export async function handleAnalyzePdfConformance(
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IPdfConformanceProfile> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, event.sender?.id);
    return analyzePdfConformanceFile(resolvedPath);
}

export async function handleValidatePdfData(
    _event: Electron.IpcMainInvokeEvent,
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
    event: Electron.IpcMainInvokeEvent,
    filePath: unknown,
): Promise<IPdfValidationResult> {
    const resolvedPath = await resolveExistingReadablePdfPath(filePath, event.sender?.id);
    return validatePdfFile(resolvedPath);
}
