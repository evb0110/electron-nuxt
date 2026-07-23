import type { IDebugLogEntry } from '@contracts/electronApiCommon';

export const CORE_IPC_CHANNELS = {rendererReady: 'app:rendererReady'} as const;

export const CORE_IPC_EVENT_CHANNELS = {
    menuOpenSettings: 'menu:openSettings',
    menuCheckForUpdates: 'menu:checkForUpdates',
    debugLog: 'debug:log',
    shutdownSaveFlushRequest: 'shutdown:saveFlushRequest',
} as const;

export const CORE_IPC_SEND_CHANNELS = {
    rendererLog: 'renderer:log',
    shutdownSaveFlushResult: 'shutdown:saveFlushResult',
} as const;

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuOpenSettings]: undefined;
    [CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates]: undefined;
    [CORE_IPC_EVENT_CHANNELS.debugLog]: IDebugLogEntry;
    [CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest]: IShutdownSaveFlushRequest;
}

export interface IShutdownSaveFlushRequest { requestId: string; }

export interface IShutdownSaveFlushResult {
    requestId: string;
    dirtyWorkingCopyPaths?: string[];
    error?: string;
    flushedWorkingCopyPaths?: string[];
}
