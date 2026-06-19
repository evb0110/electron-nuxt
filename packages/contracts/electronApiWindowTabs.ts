import type { TPaneDirection } from '@contracts/editorPanes';
import type { TDocumentRef } from '@contracts/documentRef';
import type {
    IWindowTabIncomingTransfer,
    IWindowTabTargetWindow,
    IWindowTabTransferAck,
    IWindowTabTransferRequest,
    IWindowTabTransferResult,
    TWindowTabsAction,
} from '@contracts/windowTabs';
import type {
    TMenuEventCallback,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export interface IWindowTabsApi {
    transfer: (request: IWindowTabTransferRequest) => Promise<IWindowTabTransferResult>;
    transferAck: (ack: IWindowTabTransferAck) => Promise<boolean>;
    listTargetWindows: () => Promise<IWindowTabTargetWindow[]>;
    showContextMenu: (tabId: string) => Promise<void>;
    onIncomingTransfer: (callback: (transfer: IWindowTabIncomingTransfer) => void) => TMenuEventUnsubscribe;
    onWindowAction: (callback: (action: TWindowTabsAction) => void) => TMenuEventUnsubscribe;
}

export interface IWindowTabsCapability extends IWindowTabsApi {
    closeCurrentWindow: () => Promise<boolean>;
    notifyRendererReady: () => void;
    claimPendingExternalOpenPaths: () => Promise<TDocumentRef[]>;
    onMenuNewTab: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuCloseTab: (callback: TMenuEventCallback) => TMenuEventUnsubscribe;
    onMenuSplitEditor: (callback: (direction: TPaneDirection) => void) => TMenuEventUnsubscribe;
    onMenuFocusEditorPane: (callback: (direction: TPaneDirection) => void) => TMenuEventUnsubscribe;
    onMenuMoveTabToPane: (callback: (direction: TPaneDirection) => void) => TMenuEventUnsubscribe;
    onMenuCopyTabToPane: (callback: (direction: TPaneDirection) => void) => TMenuEventUnsubscribe;
}
