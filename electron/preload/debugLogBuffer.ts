import type {IDebugLogEntry} from '@contracts/electronApiCommon';

const MAX_DEBUG_LOG_ENTRIES = 2000;
const debugLogBuffer: IDebugLogEntry[] = [];

export function pushDebugLogMessage(message: IDebugLogEntry) {
    debugLogBuffer.push(message);

    if (debugLogBuffer.length <= MAX_DEBUG_LOG_ENTRIES) {
        return;
    }

    debugLogBuffer.splice(0, debugLogBuffer.length - MAX_DEBUG_LOG_ENTRIES);
}

export function getDebugLogMessages() {
    return debugLogBuffer.slice();
}
