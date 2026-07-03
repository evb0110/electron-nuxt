import type {
    IDocumentsCapability,
    IDocumentsFileIoCapability,
    IDocumentsMenuCapability,
    IDocumentsOpenCapability,
    IDocumentsPdfCapability,
    IDocumentsPickerCapability,
    IDocumentsRecentFilesCapability,
    IDocumentsWindowCapability,
    IDocumentsWorkingCopyCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { getPlatformAPI } from '@app/utils/platform';
import { isBrowserFullReadTooLargeError } from '@app/platform/browser/browserDocumentReadError';

export function getDocumentsCapability(): IDocumentsCapability {
    return getPlatformAPI().documents;
}

export function getDocumentPickerCapability(): IDocumentsPickerCapability {
    const platform = getPlatformAPI();
    return platform.documentPicker ?? platform.documents;
}

export function getDocumentOpenCapability(): IDocumentsOpenCapability {
    const platform = getPlatformAPI();
    return platform.documentOpen ?? platform.documents;
}

export function getDocumentWorkingCopyCapability(): IDocumentsWorkingCopyCapability {
    const platform = getPlatformAPI();
    return platform.documentWorkingCopy ?? platform.documents;
}

export function getDocumentFilesCapability(): IDocumentsFileIoCapability {
    const platform = getPlatformAPI();
    return platform.documentFiles ?? platform.documents;
}

export function getDocumentPdfCapability(): IDocumentsPdfCapability {
    const platform = getPlatformAPI();
    return platform.documentPdf ?? platform.documents;
}

export function getDocumentRecentFilesCapability(): IDocumentsRecentFilesCapability {
    const platform = getPlatformAPI();
    return platform.documentRecentFiles ?? platform.documents;
}

export function getDocumentWindowCapability(): IDocumentsWindowCapability {
    const platform = getPlatformAPI();
    return platform.documentWindow ?? platform.documents;
}

export function getDocumentMenuCapability(): IDocumentsMenuCapability {
    const platform = getPlatformAPI();
    return platform.documentMenu ?? platform.documents;
}

export function getPageOpsCapability(): IPageOpsCapability {
    return getPlatformAPI().pageOps;
}

export function getImageExportCapability(): IImageExportCapability {
    return getPlatformAPI().imageExport;
}

const FULL_READ_FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;

export async function readDocumentFileFully(path: TDocumentRef) {
    const documents = getDocumentFilesCapability();
    try {
        return await documents.readFile(path);
    } catch (error) {
        if (!isBrowserFullReadTooLargeError(error)) {
            throw error;
        }
    }

    const { size } = await documents.statFile(path);
    const output = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
        const length = Math.min(FULL_READ_FALLBACK_CHUNK_SIZE, size - offset);
        const chunk = await documents.readFileRange(path, offset, length);
        if (chunk.byteLength === 0) {
            throw new Error(`Range read returned no bytes before EOF at offset ${offset} of ${size}`);
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
        if (offset < size) {
            await yieldToBrowser();
        }
    }
    return output;
}

interface INativePrintResult {
    success: boolean;
    canceled?: boolean;
    error?: string;
    unsupportedReason?: string;
}

export function isNativePrintCapabilityUnavailable(result: INativePrintResult) {
    return result.success !== true
        && result.canceled !== true
        && result.unsupportedReason === 'requires-native-backend';
}

export function shouldRefreshWorkingCopyAfterSaveAs(
    savedPath: TDocumentRef | null | undefined,
    previousWorkingPath: TDocumentRef | null | undefined,
) {
    return Boolean(
        savedPath
        && previousWorkingPath
        && savedPath !== previousWorkingPath
        && isBrowserDocumentRef(savedPath),
    );
}
