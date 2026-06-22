import type { IpcRenderer } from 'electron';
import type {
    IDebugLogEntry,
    TDebugLogLevel,
} from '@contracts/electronApiCommon';
import { isRecord } from '@contracts/runtimeGuards';
import { pushDebugLogMessage } from '@electron/preload/debugLogBuffer';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';

const PRELOAD_DEBUG_LOG_LISTENER_FLAG = '__preloadDebugLogListenerInstalled';
const DEBUG_LOG_LEVELS = new Set<TDebugLogLevel>([
    'DEBUG',
    'INFO',
    'WARN',
    'ERROR',
]);

export function decodeDebugLogEntry(data: unknown): IDebugLogEntry | null {
    if (!isRecord(data)
        || typeof data.source !== 'string'
        || typeof data.message !== 'string'
        || typeof data.timestamp !== 'string'
    ) {
        return null;
    }

    if (data.level !== undefined && (typeof data.level !== 'string' || !DEBUG_LOG_LEVELS.has(data.level as TDebugLogLevel))) {
        return null;
    }

    return {
        source: data.source,
        message: data.message,
        timestamp: data.timestamp,
        ...(data.level === undefined ? {} : {level: data.level as TDebugLogLevel}),
    };
}

export function installDebugLogListener(ipcRenderer: Pick<IpcRenderer, 'on'>) {
    const preloadState = globalThis as Record<string, unknown>;
    if (preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] === true) {
        return;
    }

    preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] = true;
    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.debugLog, (_event, data: unknown) => {
        const entry = decodeDebugLogEntry(data);
        if (!entry) {
            return;
        }

        pushDebugLogMessage(entry);

        const level = entry.level ?? 'WARN';
        if (level === 'ERROR') {
            console.error(`[${entry.timestamp}] [${entry.source}] ${entry.message}`);
            return;
        }
        if (level === 'WARN') {
            console.warn(`[${entry.timestamp}] [${entry.source}] ${entry.message}`);
        }
    });
}
