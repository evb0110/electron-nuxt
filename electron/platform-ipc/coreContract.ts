import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import {isRecord} from '@contracts/runtimeGuards';

export const CORE_IPC_CHANNELS = {rendererReady: 'app:rendererReady'} as const;

export const CORE_IPC_EVENT_CHANNELS = {
    menuCheckForUpdates: 'menu:checkForUpdates',
    debugLog: 'debug:log',
    shutdownSaveFlushRequest: 'shutdown:saveFlushRequest',
} as const;

export const CORE_IPC_SEND_CHANNELS = {
    rendererLog: 'renderer:log',
    shutdownSaveFlushResult: 'shutdown:saveFlushResult',
} as const;

export interface ICoreEventMap {
    [CORE_IPC_EVENT_CHANNELS.menuCheckForUpdates]: undefined;
    [CORE_IPC_EVENT_CHANNELS.debugLog]: IDebugLogEntry;
    [CORE_IPC_EVENT_CHANNELS.shutdownSaveFlushRequest]: IShutdownSaveFlushRequest;
}

export interface IShutdownSaveFlushRequest { requestId: string; }

export interface IShutdownSaveFlushResult {
    callbackCount: number;
    requestId: string;
    dirtyWorkingCopyPaths?: string[];
    error?: string;
    flushedWorkingCopyPaths?: string[];
}

function decodeShutdownPathList(value: unknown) {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 1_024) {
        return null;
    }
    const paths = value.filter((path): path is string => (
        typeof path === 'string'
        && path.trim().length > 0
        && path.length <= 16_384
    ));
    return paths.length === value.length ? paths : null;
}

export function decodeShutdownSaveFlushResult(value: unknown): IShutdownSaveFlushResult | null {
    if (!isRecord(value)
        || typeof value.requestId !== 'string'
        || value.requestId.length < 1
        || value.requestId.length > 256
        || !Number.isSafeInteger(value.callbackCount)
        || (value.callbackCount as number) < 0
        || (value.callbackCount as number) > 1_024
        || (value.error !== undefined && (typeof value.error !== 'string' || value.error.length > 16_384))) {
        return null;
    }
    const dirtyWorkingCopyPaths = decodeShutdownPathList(value.dirtyWorkingCopyPaths);
    const flushedWorkingCopyPaths = decodeShutdownPathList(value.flushedWorkingCopyPaths);
    if (dirtyWorkingCopyPaths === null || flushedWorkingCopyPaths === null) {
        return null;
    }
    return {
        callbackCount: value.callbackCount as number,
        requestId: value.requestId,
        ...(dirtyWorkingCopyPaths === undefined ? {} : {dirtyWorkingCopyPaths}),
        ...(flushedWorkingCopyPaths === undefined ? {} : {flushedWorkingCopyPaths}),
        ...(typeof value.error === 'string' ? {error: value.error} : {}),
    };
}
