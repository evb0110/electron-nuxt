import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from '@contracts/electron-api';
import {
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
} from '@contracts/ipc-assertions';
import type { TDocumentsEventChannels } from '@electron/features/documents/contract';

const MAX_IPC_FILE_NAME_LENGTH = 255;
const MAX_IPC_WRITE_BYTES = 512 * 1024 * 1024;

type IDocumentsEventMap = {
    [K in TDocumentsEventChannels['menuOpenPdf']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuInsertImageFromFile']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuPasteImageFromClipboard']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuSave']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuSaveAs']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuExportDocx']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuExportImages']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuExportMultiPageTiff']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuZoomIn']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuZoomOut']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuActualSize']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuFitWidth']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuFitHeight']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuViewModeSingle']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuViewModeFacing']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuViewModeFacingFirstSingle']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuUndo']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuRedo']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuDeletePages']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuExtractPages']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuRotateCw']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuRotateCcw']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuInsertPages']]: undefined;
} & {
    [K in TDocumentsEventChannels['menuOpenRecentFile']]: string;
} & {
    [K in TDocumentsEventChannels['menuOpenExternalPaths']]: string[];
} & {
    [K in TDocumentsEventChannels['menuClearRecentFiles']]: undefined;
} & {
    [K in TDocumentsEventChannels['openPdfDirectBatchProgress']]: {
        requestId: string;
        processed: number;
        total: number;
        percent: number;
        elapsedMs: number;
        estimatedRemainingMs: number | null;
    };
};

function assertWriteData(value: unknown, fieldName: string) {
    if (!(value instanceof Uint8Array)) {
        throw new Error(`${fieldName} must be a Uint8Array`);
    }
    if (value.byteLength === 0) {
        throw new Error(`${fieldName} must not be empty`);
    }
    if (value.byteLength > MAX_IPC_WRITE_BYTES) {
        throw new Error(`${fieldName} exceeds maximum size (${MAX_IPC_WRITE_BYTES} bytes)`);
    }
    return value;
}

function assertWorkingCopyFileName(value: unknown, fieldName: string) {
    const normalized = assertNonEmptyString(value, fieldName, MAX_IPC_FILE_NAME_LENGTH);
    if (normalized.includes('/') || normalized.includes('\\')) {
        throw new Error(`${fieldName} must be a file name, not a path`);
    }
    if (normalized === '.' || normalized === '..') {
        throw new Error(`${fieldName} is invalid`);
    }
    return normalized;
}

export {
    MAX_IPC_FILE_NAME_LENGTH,
    assertAbsolutePath,
    assertNonEmptyString,
    assertOptionalAbsolutePath,
    assertWriteData,
    assertWorkingCopyFileName,
};

export type {
    IDocumentsEventMap,
    IMenuEventCallback,
    IMenuEventUnsubscribe,
};
