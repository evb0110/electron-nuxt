import type { TaggedUnion } from 'type-fest';
import type { TDocumentRef } from '@contracts/documentRef';

export interface IEmptySplitPayload {kind: 'empty';}

export interface IDjvuSplitPayload {
    kind: 'djvu';
    sourcePath: TDocumentRef;
    currentPage?: number;
    totalPages?: number;
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

export interface ITabMetadataCore {
    fileName: string | null;
    originalPath: TDocumentRef | null;
    isDirty: boolean;
    isDjvu: boolean;
}

export type ITransferredTabState = ITabMetadataCore;

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

export type TWindowTabsAction = TaggedUnion<'kind', {
    'close-tab': {tabId?: string;};
    'move-tab-to-new-window': {tabId?: string;};
    'move-tab-to-window': {
        targetWindowId: number;
        tabId?: string;
    };
    'merge-window-into': {targetWindowId: number;};
}>;
