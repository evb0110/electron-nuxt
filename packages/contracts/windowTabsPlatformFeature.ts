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
import {
    decodeWindowTabIncomingTransfer,
    decodeWindowTabTargetWindows,
    decodeWindowTabTransferAck,
    decodeWindowTabTransferRequest,
    decodeWindowTabTransferResult,
    decodeWindowTabsAction,
} from '@contracts/windowTabsValidation';
import {
    decodeWorkspaceCheckpoint,
    type IWorkspaceCheckpoint,
} from '@contracts/workspaceCheckpoint';
import {
    defineForwardedPlatformEvent,
    defineForwardedPlatformMethod,
    definePlatformFeature,
    runtimeSchema as s,
    type TFeatureCapability,
    type TFeatureEventMap,
    type TFeatureInvokeMap,
} from '@contracts/platformFeature';

type TVoidResult = ReturnType<() => void>;

const noArgs = s.tuple([]);
const voidResult = s.declared<TVoidResult>()(s.undefined());
const documentRef = s.fromParser<TDocumentRef>((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('invalid document reference');
    }
    return value;
}, () => '/tmp/document.pdf');
const tabId = s.fromParser<string>((value) => {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('invalid tab id');
    }
    return value;
}, () => 'tab-1');
const paneDirection = s.fromParser<TPaneDirection>((value) => {
    if (value !== 'left' && value !== 'right' && value !== 'up' && value !== 'down') {
        throw new Error('invalid pane direction');
    }
    return value;
}, () => 'right');
const checkpointExample = (): IWorkspaceCheckpoint => ({
    version: 1,
    capturedAt: 1,
    activePaneId: null,
    activeTabId: null,
    layout: null,
    panes: [],
    tabs: [],
});
const workspaceCheckpoint = s.fromNullableDecoder(
    decodeWorkspaceCheckpoint,
    'workspace checkpoint',
    checkpointExample,
);
const nullableWorkspaceCheckpoint = s.fromParser<IWorkspaceCheckpoint | null>((value) => {
    if (value === null) {
        return null;
    }
    const decoded = decodeWorkspaceCheckpoint(value);
    if (!decoded) {
        throw new Error('invalid workspace checkpoint');
    }
    return decoded;
}, checkpointExample);
const transferRequestExample = (): IWindowTabTransferRequest => ({
    target: {
        kind: 'window',
        windowId: 2,
    },
    tab: {
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        isDirty: false,
        isDjvu: false,
    },
    payload: {
        kind: 'pdfSnapshot',
        fileName: 'sample.pdf',
        originalPath: '/tmp/sample.pdf',
        snapshotPath: '/tmp/snapshot.pdf',
        isDirty: false,
    },
});
const transferRequest = s.fromNullableDecoder(
    decodeWindowTabTransferRequest,
    'window tab transfer request',
    transferRequestExample,
);
const transferAck = s.fromNullableDecoder<IWindowTabTransferAck>(
    decodeWindowTabTransferAck,
    'window tab transfer acknowledgement',
    () => ({
        transferId: 'transfer-1',
        success: true,
    }),
);
const transferResult = s.fromNullableDecoder<IWindowTabTransferResult>(
    decodeWindowTabTransferResult,
    'window tab transfer result',
    () => ({
        transferId: 'transfer-1',
        success: true,
        targetWindowId: 2,
    }),
);
const targetWindows = s.fromNullableDecoder<IWindowTabTargetWindow[]>(
    decodeWindowTabTargetWindows,
    'window tab target windows',
    () => [{
        windowId: 2,
        label: 'Window 2',
    }],
);
const incomingTransfer = s.fromNullableDecoder<IWindowTabIncomingTransfer>(
    decodeWindowTabIncomingTransfer,
    'window tab incoming transfer',
    () => ({
        transferId: 'transfer-1',
        sourceWindowId: 1,
        targetWindowId: 2,
        tab: transferRequestExample().tab,
        payload: transferRequestExample().payload,
    }),
);
const windowTabsAction = s.fromNullableDecoder<TWindowTabsAction>(
    decodeWindowTabsAction,
    'window tabs action',
    () => ({kind: 'close-tab'}),
);

export const WINDOW_TABS_PLATFORM_FEATURE = definePlatformFeature({
    path: ['windowTabs'],
    required: {
        browser: true,
        electron: true,
    },
    manifestPath: ['windowTabs'],
    methods: {
        transfer: defineForwardedPlatformMethod({
            name: 'transfer',
            channel: 'tabs:transfer',
            args: s.tuple([transferRequest]),
            result: transferResult,
            main: 'requestWindowTabTransfer',
        }),
        transferAck: defineForwardedPlatformMethod({
            name: 'transferAck',
            channel: 'tabs:transferAck',
            args: s.tuple([transferAck]),
            result: s.boolean(),
            main: 'acknowledgeWindowTabTransfer',
        }),
        listTargetWindows: defineForwardedPlatformMethod({
            name: 'listTargetWindows',
            channel: 'tabs:listTargets',
            args: noArgs,
            result: targetWindows,
            main: 'listWindowTabTargets',
        }),
        showContextMenu: defineForwardedPlatformMethod({
            name: 'showContextMenu',
            channel: 'tabs:showContextMenu',
            args: s.tuple([tabId]),
            result: voidResult,
            main: 'showWindowTabContextMenu',
        }),
        closeCurrentWindow: defineForwardedPlatformMethod({
            name: 'closeCurrentWindow',
            channel: 'window:closeCurrent',
            args: noArgs,
            result: s.boolean(),
            main: 'closeCurrentWindow',
        }),
        claimPendingExternalOpenPaths: defineForwardedPlatformMethod({
            name: 'claimPendingExternalOpenPaths',
            channel: 'app:claimPendingExternalOpenPaths',
            args: noArgs,
            result: s.array(documentRef),
            main: 'claimPendingExternalOpenPaths',
        }),
        acknowledgePendingExternalOpenPaths: defineForwardedPlatformMethod({
            name: 'acknowledgePendingExternalOpenPaths',
            channel: 'app:acknowledgePendingExternalOpenPaths',
            args: s.tuple([s.array(documentRef)]),
            result: voidResult,
            main: 'acknowledgePendingExternalOpenPaths',
        }),
        saveWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'saveWorkspaceCheckpoint',
            channel: 'workspace:checkpointSave',
            args: s.tuple([workspaceCheckpoint]),
            result: voidResult,
            main: 'saveWorkspaceCheckpoint',
        }),
        claimWorkspaceCheckpoint: defineForwardedPlatformMethod({
            name: 'claimWorkspaceCheckpoint',
            channel: 'workspace:checkpointClaim',
            args: noArgs,
            result: nullableWorkspaceCheckpoint,
            main: 'claimWorkspaceCheckpoint',
        }),
    },
    events: {
        onIncomingTransfer: defineForwardedPlatformEvent({
            name: 'onIncomingTransfer',
            channel: 'tabs:incomingTransfer',
            payload: incomingTransfer,
        }),
        onWindowAction: defineForwardedPlatformEvent({
            name: 'onWindowAction',
            channel: 'menu:windowTabsAction',
            payload: windowTabsAction,
        }),
        onMenuNewTab: defineForwardedPlatformEvent({
            name: 'onMenuNewTab',
            channel: 'menu:newTab',
            payload: s.undefined(),
        }),
        onMenuCloseTab: defineForwardedPlatformEvent({
            name: 'onMenuCloseTab',
            channel: 'menu:closeTab',
            payload: s.undefined(),
        }),
        onMenuSplitEditor: defineForwardedPlatformEvent({
            name: 'onMenuSplitEditor',
            channel: 'menu:splitEditor',
            payload: paneDirection,
        }),
        onMenuFocusEditorPane: defineForwardedPlatformEvent({
            name: 'onMenuFocusEditorPane',
            channel: 'menu:focusEditorPane',
            payload: paneDirection,
        }),
        onMenuMoveTabToPane: defineForwardedPlatformEvent({
            name: 'onMenuMoveTabToPane',
            channel: 'menu:moveTabToPane',
            payload: paneDirection,
        }),
        onMenuCopyTabToPane: defineForwardedPlatformEvent({
            name: 'onMenuCopyTabToPane',
            channel: 'menu:copyTabToPane',
            payload: paneDirection,
        }),
    },
});

interface IWindowTabsLifecycleCapability {notifyRendererReady: () => void;}

export type IWindowTabsApi = Pick<
    TFeatureCapability<typeof WINDOW_TABS_PLATFORM_FEATURE>,
    | 'transfer'
    | 'transferAck'
    | 'listTargetWindows'
    | 'showContextMenu'
    | 'onIncomingTransfer'
    | 'onWindowAction'
>;
export type IWindowTabsCapability =
    TFeatureCapability<typeof WINDOW_TABS_PLATFORM_FEATURE> & IWindowTabsLifecycleCapability;
export type IWindowTabsInvokeMap = TFeatureInvokeMap<typeof WINDOW_TABS_PLATFORM_FEATURE>;
export type IWindowTabsEventMap = TFeatureEventMap<typeof WINDOW_TABS_PLATFORM_FEATURE>;
