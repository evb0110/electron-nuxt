import type {
    IDocumentsCapability,
    TDocumentRef,
} from '@contracts/platform-api';
import { isBrowserDocumentRef } from '@app/utils/document-ref';
import { getPlatformAPI } from '@app/utils/platform';

export function getDocumentsCapability(): IDocumentsCapability {
    return getPlatformAPI().documents;
}

export function getPageOpsCapability(): IDocumentsCapability['pageOps'] {
    return getDocumentsCapability().pageOps;
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
