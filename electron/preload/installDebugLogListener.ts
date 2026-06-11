import type { IpcRenderer } from 'electron';
import type { IDebugLogEntry } from '@contracts/electronApiCommon';
import { pushDebugLogMessage } from '@electron/preload/debugLogBuffer';
import { CORE_IPC_EVENT_CHANNELS } from '@electron/platform-ipc/coreContract';

const PRELOAD_DEBUG_LOG_LISTENER_FLAG = '__preloadDebugLogListenerInstalled';

export function installDebugLogListener(ipcRenderer: Pick<IpcRenderer, 'on'>) {
    const preloadState = globalThis as Record<string, unknown>;
    if (preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] === true) {
        return;
    }

    preloadState[PRELOAD_DEBUG_LOG_LISTENER_FLAG] = true;
    ipcRenderer.on(CORE_IPC_EVENT_CHANNELS.debugLog, (_event, data: IDebugLogEntry) => {
        pushDebugLogMessage(data);
        console.log(`[${data.timestamp}] [${data.source}] ${data.message}`);
    });
}
