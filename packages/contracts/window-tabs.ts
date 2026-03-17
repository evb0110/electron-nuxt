import type { TDocumentRef } from './document';

export interface IEmptySplitPayload {kind: 'empty';}

export interface IDjvuSplitPayload {
    kind: 'djvu';
    sourcePath: TDocumentRef;
}

export interface IPdfSnapshotSplitPayload {
    kind: 'pdfSnapshot';
    fileName: string;
    originalPath: TDocumentRef | null;
    snapshotPath: TDocumentRef;
    isDirty: boolean;
    currentPage?: number;
    totalPages?: number;
}

export type TSplitPayload = IEmptySplitPayload | IDjvuSplitPayload | IPdfSnapshotSplitPayload;

export interface ITransferredTabState {
    fileName: string | null;
    originalPath: TDocumentRef | null;
    isDirty: boolean;
    isDjvu: boolean;
}

export type TWindowTabTransferTarget =
    | { kind: 'new-window'; }
    | {
        kind: 'window';
        windowId: number;
    };

export interface IWindowTabTransferRequest {
    target: TWindowTabTransferTarget;
    tab: ITransferredTabState;
    payload: TSplitPayload;
    timeoutMs?: number;
}

export interface IWindowTabIncomingTransfer {
    transferId: string;
    sourceWindowId: number;
    targetWindowId: number;
    tab: ITransferredTabState;
    payload: TSplitPayload;
}

export interface IWindowTabTransferAck {
    transferId: string;
    success: boolean;
    error?: string;
}

export interface IWindowTabTransferResult {
    transferId: string;
    success: boolean;
    targetWindowId: number;
    error?: string;
}

export interface IWindowTabTargetWindow {
    windowId: number;
    label: string;
}

export type TWindowTabsAction =
    | {
        kind: 'close-tab';
        tabId?: string;
    }
    | {
        kind: 'move-tab-to-new-window';
        tabId?: string;
    }
    | {
        kind: 'move-tab-to-window';
        targetWindowId: number;
        tabId?: string;
    }
    | {
        kind: 'merge-window-into';
        targetWindowId: number;
    };
