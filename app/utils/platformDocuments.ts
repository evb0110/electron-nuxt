import type {
    IDocumentsCapability,
    IImageExportCapability,
} from '@contracts/electronApiDocuments';
import type { TDocumentRef } from '@contracts/documentRef';
import type { IPageOpsCapability } from '@contracts/electronApiPageOps';
import { isBrowserDocumentRef } from '@app/utils/documentRef';
import { yieldToBrowser } from '@app/utils/yieldToBrowser';
import { getPlatformAPI } from '@app/utils/platform';

export function getDocumentsCapability(): IDocumentsCapability {
    return getPlatformAPI().documents;
}

export function getPageOpsCapability(): IPageOpsCapability {
    return getPlatformAPI().pageOps;
}

export function getImageExportCapability(): IImageExportCapability {
    return getPlatformAPI().imageExport;
}

export function getDocumentPathForFile(file: File) {
    return getDocumentsCapability().getPathForFile(file);
}

export function readDocumentRange(
    path: TDocumentRef,
    offset: number,
    length: number,
) {
    return getDocumentsCapability().readFileRange(path, offset, length);
}

const FULL_READ_FALLBACK_CHUNK_SIZE = 4 * 1024 * 1024;

function isBrowserFullReadLimitError(error: unknown) {
    return error instanceof Error
        && error.message.includes('too large to load fully into memory');
}

export async function readDocumentFileFully(path: TDocumentRef) {
    const documents = getDocumentsCapability();
    try {
        return await documents.readFile(path);
    } catch (error) {
        if (!isBrowserFullReadLimitError(error)) {
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
}

const NATIVE_PRINT_UNAVAILABLE_ERROR = 'Printing via the native desktop dialog is unavailable in the browser capability';

export function isNativePrintCapabilityUnavailable(result: INativePrintResult) {
    return result.success !== true
        && result.canceled !== true
        && result.error === NATIVE_PRINT_UNAVAILABLE_ERROR;
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
