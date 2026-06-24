import { isRecord } from '@contracts/runtimeGuards';
import type {
    ITransferredTabState,
    IWindowTabIncomingTransfer,
    IWindowTabTransferRequest,
    TSplitPayload,
    TWindowTabTransferTarget,
} from '@contracts/windowTabs';

function normalizeNonEmptyString(value: unknown) {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : null;
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isPositiveWindowId(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isOptionalPositiveInteger(value: unknown): value is number | undefined {
    return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
}

function decodeTransferredTabState(value: unknown): ITransferredTabState | null {
    if (
        !isRecord(value)
        || !isNullableString(value.fileName)
        || !isNullableString(value.originalPath)
        || typeof value.isDirty !== 'boolean'
        || typeof value.isDjvu !== 'boolean'
    ) {
        return null;
    }

    return {
        fileName: value.fileName,
        originalPath: value.originalPath,
        isDirty: value.isDirty,
        isDjvu: value.isDjvu,
    };
}

function decodeSplitPayload(value: unknown): TSplitPayload | null {
    if (!isRecord(value) || typeof value.kind !== 'string') {
        return null;
    }

    if (value.kind === 'empty') {
        return { kind: 'empty' };
    }

    if (value.kind === 'djvu') {
        if (
            typeof value.sourcePath !== 'string'
            || !isOptionalPositiveInteger(value.currentPage)
            || !isOptionalPositiveInteger(value.totalPages)
        ) {
            return null;
        }
        return {
            kind: 'djvu',
            sourcePath: value.sourcePath,
            ...(value.currentPage === undefined ? {} : { currentPage: value.currentPage }),
            ...(value.totalPages === undefined ? {} : { totalPages: value.totalPages }),
        };
    }

    if (
        value.kind !== 'pdfSnapshot'
        || typeof value.fileName !== 'string'
        || !isNullableString(value.originalPath)
        || typeof value.snapshotPath !== 'string'
        || typeof value.isDirty !== 'boolean'
        || !isOptionalPositiveInteger(value.currentPage)
        || !isOptionalPositiveInteger(value.totalPages)
    ) {
        return null;
    }

    return {
        kind: 'pdfSnapshot',
        fileName: value.fileName,
        originalPath: value.originalPath,
        snapshotPath: value.snapshotPath,
        isDirty: value.isDirty,
        ...(value.currentPage === undefined ? {} : { currentPage: value.currentPage }),
        ...(value.totalPages === undefined ? {} : { totalPages: value.totalPages }),
    };
}

function decodeTransferTarget(value: unknown): TWindowTabTransferTarget | null {
    if (!isRecord(value)) {
        return null;
    }
    if (value.kind === 'new-window') {
        return { kind: 'new-window' };
    }
    if (value.kind === 'window' && isPositiveWindowId(value.windowId)) {
        return {
            kind: 'window',
            windowId: value.windowId,
        };
    }
    return null;
}

export function decodeWindowTabTransferRequest(value: unknown): IWindowTabTransferRequest | null {
    if (!isRecord(value)) {
        return null;
    }

    const target = decodeTransferTarget(value.target);
    const tab = decodeTransferredTabState(value.tab);
    const payload = decodeSplitPayload(value.payload);
    if (
        target === null
        || tab === null
        || payload === null
        || (value.timeoutMs !== undefined && (
            typeof value.timeoutMs !== 'number'
            || !Number.isFinite(value.timeoutMs)
            || value.timeoutMs <= 0
        ))
    ) {
        return null;
    }

    return {
        target,
        tab,
        payload,
        ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }),
    };
}

export function decodeWindowTabIncomingTransfer(value: unknown): IWindowTabIncomingTransfer | null {
    if (!isRecord(value)) {
        return null;
    }

    const transferId = normalizeNonEmptyString(value.transferId);
    const tab = decodeTransferredTabState(value.tab);
    const payload = decodeSplitPayload(value.payload);
    if (
        transferId === null
        || !isPositiveWindowId(value.sourceWindowId)
        || !isPositiveWindowId(value.targetWindowId)
        || tab === null
        || payload === null
    ) {
        return null;
    }

    return {
        transferId,
        sourceWindowId: value.sourceWindowId,
        targetWindowId: value.targetWindowId,
        tab,
        payload,
    };
}
