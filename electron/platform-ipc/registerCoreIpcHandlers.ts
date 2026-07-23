import { BrowserWindow } from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import type { IWindowTabTargetWindow } from '@contracts/windowTabs';
import {
    WINDOW_TABS_PLATFORM_FEATURE,
    type IWindowTabsInvokeMap,
} from '@contracts/windowTabsPlatformFeature';
import type { TFeatureMainBindings } from '@contracts/platformFeature';
import { te } from '@electron/te';
import {showTabContextMenu} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import { registerRendererLogBridge } from '@electron/platform-ipc/rendererLogBridge';
import { isTrustedWebContentsSender } from '@electron/platform-ipc/trustedIpcSender';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
    registerPlatformFeatureHandlers,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
} from '@electron/platform-ipc/coreContract';
import {
    claimWorkspaceCheckpoint,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';
import { allowOpenPaths } from '@electron/file-access/openPathCapabilities';

export interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (sender: Electron.WebContents) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (sender: Electron.WebContents, failedPaths: string[]) => void;
}

const CORE_RAW_EVENT_CHANNEL_SET = new Set<string>([
    CORE_IPC_CHANNELS.rendererReady,
    CORE_IPC_SEND_CHANNELS.rendererLog,
]);

function buildTabTransferTargetLabels(sourceWindowId: number): IWindowTabTargetWindow[] {
    const otherWindows = sortBy(
        getAllRegisteredAppWindows().filter(window => window.id !== sourceWindowId),
        [window => window.id],
    );
    const titleCountByLabel = countBy(otherWindows, window => (window.getTitle() || te('app.title')).trim() || te('app.title'));

    return otherWindows.map((window) => {
        const title = (window.getTitle() || te('app.title')).trim() || te('app.title');
        const duplicateCount = titleCountByLabel[title] ?? 0;
        return {
            windowId: window.id,
            label: duplicateCount > 1 ? `${title} (${window.id})` : title,
        };
    });
}

export function registerCoreIpcHandlers(
    ipcMain: Electron.IpcMain,
    options: ICoreIpcHandlerOptions,
) {
    const windowTabsRegistrar = createValidatedIpcMainRegistrar<IWindowTabsInvokeMap>(ipcMain, {
        allowedChannels: WINDOW_TABS_PLATFORM_FEATURE.invokeChannelSet,
        codecs: WINDOW_TABS_PLATFORM_FEATURE.ipcCodecs as never,
    });
    const eventRegistrar = createValidatedIpcMainEventRegistrar(ipcMain, {allowedChannels: CORE_RAW_EVENT_CHANNEL_SET});
    registerRendererLogBridge({
        isTrustedSender: isTrustedWebContentsSender,
        registerListener: (channel, handler) => {
            eventRegistrar.on(channel, (event, payload) => {
                handler(event, payload as Parameters<typeof handler>[1]);
            });
        },
    });
    eventRegistrar.on(CORE_IPC_CHANNELS.rendererReady, (event) => {
        options.onRendererReady?.(event);
    });

    const bindings: TFeatureMainBindings<
        typeof WINDOW_TABS_PLATFORM_FEATURE,
        Electron.IpcMainInvokeEvent
    > = {
        claimPendingExternalOpenPaths: ({sender}) =>
            options.claimPendingExternalOpenPaths?.(sender) ?? [],
        acknowledgePendingExternalOpenPaths: ({sender}, failedPaths) => {
            options.acknowledgePendingExternalOpenPaths?.(sender, failedPaths);
        },
        saveWorkspaceCheckpoint: async ({senderId}, checkpoint) => {
            await saveWorkspaceCheckpoint(checkpoint, senderId);
        },
        claimWorkspaceCheckpoint: async ({
            sender,
            senderId,
        }) => {
            const checkpoint = await claimWorkspaceCheckpoint(senderId);
            if (checkpoint) {
                allowOpenPaths(checkpoint.tabs.flatMap(tab => [
                    tab.sourceRef,
                    tab.workingCopyRef,
                ].filter((path): path is string => path !== null)), sender);
            }
            return checkpoint;
        },
        requestWindowTabTransfer: async ({sender}, request) => {
            const sourceWindow = BrowserWindow.fromWebContents(sender);
            if (!sourceWindow) {
                return {
                    transferId: '',
                    success: false,
                    targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
                    error: 'Source window is not available.',
                };
            }
            return requestWindowTabTransfer(sourceWindow.id, request);
        },
        acknowledgeWindowTabTransfer: ({sender}, ack) => {
            const window = BrowserWindow.fromWebContents(sender);
            return window ? acknowledgeWindowTabTransfer(window.id, ack) : false;
        },
        listWindowTabTargets: ({sender}): IWindowTabTargetWindow[] => {
            const sourceWindow = BrowserWindow.fromWebContents(sender);
            return sourceWindow ? buildTabTransferTargetLabels(sourceWindow.id) : [];
        },
        showWindowTabContextMenu: ({sender}, tabId) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (window) {
                showTabContextMenu(window, tabId);
            }
        },
        closeCurrentWindow: ({sender}) => {
            const window = BrowserWindow.fromWebContents(sender);
            if (!window || window.isDestroyed()) {
                return false;
            }
            window.close();
            return true;
        },
    };
    registerPlatformFeatureHandlers(
        windowTabsRegistrar as never,
        WINDOW_TABS_PLATFORM_FEATURE,
        bindings,
    );
}
