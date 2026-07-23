import { BrowserWindow } from 'electron';
import {
    countBy,
    sortBy,
} from 'es-toolkit/array';
import type { IWindowTabTargetWindow } from '@contracts/windowTabs';
import { te } from '@electron/te';
import {showTabContextMenu} from '@electron/menu';
import {
    acknowledgeWindowTabTransfer,
    requestWindowTabTransfer,
} from '@electron/windowTabTransfer';
import { getAllRegisteredAppWindows } from '@electron/window/registry';
import {
    deferDownloadedUpdate,
    downloadAvailableUpdate,
    getUpdateStatus,
    installDownloadedUpdate,
    skipUpdateVersion,
    triggerManualUpdateCheck,
} from '@electron/updates';
import { registerRendererLogBridge } from '@electron/platform-ipc/rendererLogBridge';
import { isTrustedWebContentsSender } from '@electron/platform-ipc/trustedIpcSender';
import {
    createValidatedIpcMainEventRegistrar,
    createValidatedIpcMainRegistrar,
} from '@electron/platform-ipc/validatedIpcRegistrar';
import { CORE_IPC_CODECS } from '@electron/platform-ipc/coreIpcCodecs';
import {
    setHostZenModeForWindow,
    snapshotHostEnvironmentForWindow,
    snapshotHostZenModeForWindow,
} from '@electron/hostEnvironment';
import {
    CORE_IPC_CHANNELS,
    CORE_IPC_SEND_CHANNELS,
    type ICoreInvokeMap,
} from '@electron/platform-ipc/coreContract';
import {
    claimWorkspaceCheckpoint,
    saveWorkspaceCheckpoint,
} from '@electron/workspaceCheckpointStore';
import { allowOpenPaths } from '@electron/file-access/openPathCapabilities';

export interface ICoreIpcHandlerOptions {
    onRendererReady?: (event: Electron.IpcMainEvent) => void;
    claimPendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent) => Promise<string[]>;
    acknowledgePendingExternalOpenPaths?: (event: Electron.IpcMainInvokeEvent, failedPaths: string[]) => void;
}

const CORE_INVOKE_CHANNEL_SET = new Set<string>(Object.keys(CORE_IPC_CODECS));
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
    const registrar = createValidatedIpcMainRegistrar<ICoreInvokeMap>(ipcMain, {
        allowedChannels: CORE_INVOKE_CHANNEL_SET,
        codecs: CORE_IPC_CODECS,
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

    registrar.handle(CORE_IPC_CHANNELS.claimPendingExternalOpenPaths, (event) =>
        options.claimPendingExternalOpenPaths?.(event) ?? [],
    );

    registrar.handle(CORE_IPC_CHANNELS.acknowledgePendingExternalOpenPaths, (event, failedPaths) => {
        options.acknowledgePendingExternalOpenPaths?.(event, failedPaths);
    });

    registrar.handle(CORE_IPC_CHANNELS.workspaceCheckpointSave, async (event, checkpoint) => {
        await saveWorkspaceCheckpoint(checkpoint, event.sender.id);
    });

    registrar.handle(CORE_IPC_CHANNELS.workspaceCheckpointClaim, async (event) => {
        const checkpoint = await claimWorkspaceCheckpoint(event.sender.id);
        if (checkpoint) {
            allowOpenPaths(checkpoint.tabs.flatMap(tab => [
                tab.sourceRef,
                tab.workingCopyRef,
            ].filter((path): path is string => path !== null)), event.sender);
        }
        return checkpoint;
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsTransfer, async (event, request) => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return {
                transferId: '',
                success: false,
                targetWindowId: request.target.kind === 'window' ? request.target.windowId : -1,
                error: 'Source window is not available.',
            };
        }

        return requestWindowTabTransfer(sourceWindow.id, request);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsTransferAck, (event, ack) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return false;
        }

        return acknowledgeWindowTabTransfer(window.id, ack);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsListTargets, (event): IWindowTabTargetWindow[] => {
        const sourceWindow = BrowserWindow.fromWebContents(event.sender);
        if (!sourceWindow) {
            return [];
        }

        return buildTabTransferTargetLabels(sourceWindow.id);
    });

    registrar.handle(CORE_IPC_CHANNELS.tabsShowContextMenu, (event, tabId) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window) {
            return;
        }

        showTabContextMenu(window, tabId);
    });

    registrar.handle(CORE_IPC_CHANNELS.windowCloseCurrent, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        if (!window || window.isDestroyed()) {
            return false;
        }

        window.close();
        return true;
    });

    registrar.handle(CORE_IPC_CHANNELS.updatesGetState, () => getUpdateStatus());
    registrar.handle(CORE_IPC_CHANNELS.updatesCheck, () => triggerManualUpdateCheck());
    registrar.handle(CORE_IPC_CHANNELS.updatesDownload, () => downloadAvailableUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesInstall, () => installDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesDefer, () => deferDownloadedUpdate());
    registrar.handle(CORE_IPC_CHANNELS.updatesSkipVersion, (_event, version) => skipUpdateVersion(version));

    registrar.handle(CORE_IPC_CHANNELS.hostGetEnvironment, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostEnvironmentForWindow(window);
    });

    registrar.handle(CORE_IPC_CHANNELS.hostGetZenModeState, (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return snapshotHostZenModeForWindow(window);
    });

    registrar.handle(CORE_IPC_CHANNELS.hostSetZenMode, (event, active) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return setHostZenModeForWindow(window, active === true);
    });
}
