import { STORAGE_KEYS } from '@app/constants/storageKeys';
import type { IRendererLogEntry } from '@contracts/electronApiCommon';

type TBrowserLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
type TEmitLogLevel = Exclude<TBrowserLogLevel, 'silent'>;
type TLazyValue = unknown | (() => unknown);

const LOG_LEVELS: Record<TBrowserLogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
    silent: 50,
};

function normalizeLogLevel(value: unknown): TBrowserLogLevel | null {
    if (typeof value !== 'string') {
        return null;
    }

    const normalized = value.trim().toLowerCase();
    if (
        normalized === 'debug'
        || normalized === 'info'
        || normalized === 'warn'
        || normalized === 'error'
        || normalized === 'silent'
    ) {
        return normalized;
    }

    return null;
}

const DEFAULT_LOG_LEVEL: TBrowserLogLevel = 'warn';
const THROTTLED_LOG_STATE = new Map<string, {
    lastAtMs: number;
    suppressedCount: number;
}>();
const MAX_THROTTLED_LOG_STATE_ENTRIES = 512;

const configuredLogLevel = (() => {
    if (typeof window === 'undefined') {
        return DEFAULT_LOG_LEVEL;
    }

    try {
        const fromStorage = normalizeLogLevel(window.localStorage.getItem(STORAGE_KEYS.LOG_LEVEL));
        if (fromStorage) {
            return fromStorage;
        }
    } catch {
        // Ignore localStorage errors (privacy mode / disabled storage)
    }

    const maybeGlobal = normalizeLogLevel(window.__logLevel);
    if (maybeGlobal) {
        return maybeGlobal;
    }

    return DEFAULT_LOG_LEVEL;
})();

function shouldLog(level: TBrowserLogLevel) {
    return LOG_LEVELS[level] >= LOG_LEVELS[configuredLogLevel];
}

function isDiagnosticWarnForced() {
    if (typeof window === 'undefined') {
        return false;
    }

    const forceWarningMode = (window as Window & {__diagnosticWarnAsWarn?: boolean;}).__diagnosticWarnAsWarn;
    return forceWarningMode === true;
}

function serializeForRendererLog(value: unknown) {
    if (value === undefined) {
        return undefined;
    }

    try {
        const serialized = JSON.stringify(value, (_key, currentValue) => {
            if (currentValue instanceof Error) {
                return {
                    name: currentValue.name,
                    message: currentValue.message,
                    stack: currentValue.stack,
                };
            }

            if (typeof currentValue === 'bigint') {
                return currentValue.toString();
            }

            const normalizedValue: unknown = currentValue;
            return normalizedValue;
        });
        const parsed: unknown = JSON.parse(serialized);
        return parsed;
    } catch {
        return String(value);
    }
}

function forwardToMain(entry: IRendererLogEntry) {
    if (typeof window === 'undefined') {
        return;
    }

    try {
        const electronAPI = (window as Window & {electronAPI?: {settings?: {rendererLog?: (payload: IRendererLogEntry) => void;};};}).electronAPI;
        const rendererLog = electronAPI?.settings?.rendererLog;
        if (typeof rendererLog === 'function') {
            rendererLog(entry);
        }
    } catch {
        // Ignore IPC bridge failures in browser logger
    }
}

function resolveLazyValue(value: TLazyValue | undefined) {
    return typeof value === 'function'
        ? (value as () => unknown)()
        : value;
}

function takeThrottledLogSuppressionCount(
    section: string,
    key: string,
    intervalMs: number,
) {
    const compositeKey = `${section}:${key}`;
    const nowMs = Date.now();
    const state = THROTTLED_LOG_STATE.get(compositeKey);
    if (!state) {
        THROTTLED_LOG_STATE.set(compositeKey, {
            lastAtMs: nowMs,
            suppressedCount: 0,
        });
        if (THROTTLED_LOG_STATE.size > MAX_THROTTLED_LOG_STATE_ENTRIES) {
            let deleted = 0;
            for (const [mapKey] of THROTTLED_LOG_STATE) {
                THROTTLED_LOG_STATE.delete(mapKey);
                deleted += 1;
                if (deleted >= 64) {
                    break;
                }
            }
        }
        return {
            allowed: true,
            suppressedCount: 0,
            compositeKey,
        };
    }

    if (nowMs - state.lastAtMs < Math.max(1, intervalMs)) {
        state.suppressedCount += 1;
        THROTTLED_LOG_STATE.set(compositeKey, state);
        return {
            allowed: false,
            suppressedCount: state.suppressedCount,
            compositeKey,
        };
    }

    const suppressedCount = state.suppressedCount;
    state.lastAtMs = nowMs;
    state.suppressedCount = 0;
    THROTTLED_LOG_STATE.set(compositeKey, state);
    return {
        allowed: true,
        suppressedCount,
        compositeKey,
    };
}

function enrichThrottledPayload(
    resolved: unknown,
    suppressedCount: number,
    intervalMs: number,
    key: string,
) {
    if (suppressedCount <= 0) {
        return resolved;
    }

    if (
        typeof resolved === 'object'
        && resolved !== null
        && !Array.isArray(resolved)
    ) {
        return {
            ...resolved,
            throttledSuppressedCount: suppressedCount,
            throttledIntervalMs: intervalMs,
            throttledKey: key,
        };
    }

    return {
        value: resolved,
        throttledSuppressedCount: suppressedCount,
        throttledIntervalMs: intervalMs,
        throttledKey: key,
    };
}

function writeToConsole(level: TEmitLogLevel, line: string, resolved: unknown) {
    if (level === 'error') {
        if (resolved !== undefined) {
            console.error(line, resolved);
        } else {
            console.error(line);
        }
        return;
    }

    if (level === 'warn') {
        if (resolved !== undefined) {
            console.warn(line, resolved);
        } else {
            console.warn(line);
        }
        return;
    }

    if (level === 'info') {
        if (resolved !== undefined) {
            console.info(line, resolved);
        } else {
            console.info(line);
        }
        return;
    }

    if (resolved !== undefined) {
        console.log(line, resolved);
    } else {
        console.log(line);
    }
}

function emitLog(
    level: TEmitLogLevel,
    section: string,
    message: string,
    data?: TLazyValue,
) {
    if (!shouldLog(level)) {
        return;
    }

    const timestamp = new Date().toISOString();
    const resolved = resolveLazyValue(data);
    writeToConsole(level, `[${timestamp}] [${section}] ${message}`, resolved);

    forwardToMain({
        level,
        section,
        message,
        timestamp,
        data: serializeForRendererLog(resolved),
    });
}

function emitThrottled(
    level: TEmitLogLevel,
    section: string,
    key: string,
    intervalMs: number,
    message: string,
    data?: TLazyValue,
) {
    const throttle = takeThrottledLogSuppressionCount(section, key, intervalMs);
    if (!throttle.allowed) {
        return;
    }

    const resolved = resolveLazyValue(data);
    const enriched = enrichThrottledPayload(
        resolved,
        throttle.suppressedCount,
        intervalMs,
        key,
    );
    emitLog(level, section, message, enriched);
}

export const BrowserLogger = {
    debug: (section: string, message: string, data?: TLazyValue) => {
        emitLog('debug', section, message, data);
    },

    info: (section: string, message: string, data?: TLazyValue) => {
        emitLog('info', section, message, data);
    },

    warn: (section: string, message: string, data?: TLazyValue) => {
        emitLog('warn', section, message, data);
    },

    warnThrottled: (
        section: string,
        key: string,
        intervalMs: number,
        message: string,
        data?: TLazyValue,
    ) => {
        emitThrottled('warn', section, key, intervalMs, message, data);
    },

    diagnostic: (section: string, message: string, data?: TLazyValue) => {
        emitLog(isDiagnosticWarnForced() ? 'warn' : 'debug', section, message, data);
    },

    diagnosticThrottled: (
        section: string,
        key: string,
        intervalMs: number,
        message: string,
        data?: TLazyValue,
    ) => {
        emitThrottled(
            isDiagnosticWarnForced() ? 'warn' : 'debug',
            section,
            key,
            intervalMs,
            message,
            data,
        );
    },

    error: (section: string, message: string, error?: TLazyValue) => {
        emitLog('error', section, message, error);
    },
};
