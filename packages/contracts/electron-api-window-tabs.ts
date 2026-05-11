import type { TGroupDirection } from './editor-groups';
import type { TDocumentRef } from './document';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from './window-tabs';
import type {
    IMenuEventCallback,
    IMenuEventUnsubscribe,
} from './electron-api-common';

export interface IWindowTabsApi {
    transfer: (request: IWindowTabTransferRequest) => Promise<IWindowTabTransferResult>;
    transferAck: (ack: IWindowTabTransferAck) => Promise<boolean>;
    listTargetWindows: () => Promise<IWindowTabTargetWindow[]>;
    showContextMenu: (tabId: string) => Promise<void>;
    onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void) => IMenuEventUnsubscribe;
    onWindowAction: (callback: (action: TWindowTabsAction) => void) => IMenuEventUnsubscribe;
}

export interface IWindowTabsCapability extends IWindowTabsApi {
    closeCurrentWindow: () => Promise<boolean>;
    notifyRendererReady: () => void;
    claimPendingExternalOpenPaths: () => Promise<TDocumentRef[]>;
    onMenuNewTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuCloseTab: (callback: IMenuEventCallback) => IMenuEventUnsubscribe;
    onMenuSplitEditor: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuFocusEditorGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuMoveTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
    onMenuCopyTabToGroup: (callback: (direction: TGroupDirection) => void) => IMenuEventUnsubscribe;
}
