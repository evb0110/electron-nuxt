import { STORAGE_KEYS } from '@app/constants/storageKeys';
import type { IRendererLogEntry } from '@contracts/platformApi';

type TBrowserLogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
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
const DIAGNOSTIC_WARNING_SECTIONS = new Set([
    'pdf-nav',
    'pdf-thumbnails',
    'note-placement',
    'loader',
    'pdf-zoom-debug',
    'toolbar-transition',
]);
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

function shouldDemoteWarning(section: string) {
    if (typeof window !== 'undefined') {
        const forceWarningMode = (window as Window & {__diagnosticWarnAsWarn?: boolean;}).__diagnosticWarnAsWarn;
        if (forceWarningMode === true) {
            return false;
        }
    }
    return DIAGNOSTIC_WARNING_SECTIONS.has(section);
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

export const BrowserLogger = {
    debug: (section: string, message: string, data?: TLazyValue) => {
        if (!shouldLog('debug')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = resolveLazyValue(data);

        if (resolved !== undefined) {
            console.log(`${prefix} ${message}`, resolved);
        } else {
            console.log(`${prefix} ${message}`);
        }

        forwardToMain({
            level: 'debug',
            section,
            message,
            timestamp,
            data: serializeForRendererLog(resolved),
        });
    },

    info: (section: string, message: string, data?: TLazyValue) => {
        if (!shouldLog('info')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = resolveLazyValue(data);

        if (resolved !== undefined) {
            console.info(`${prefix} ${message}`, resolved);
        } else {
            console.info(`${prefix} ${message}`);
        }

        forwardToMain({
            level: 'info',
            section,
            message,
            timestamp,
            data: serializeForRendererLog(resolved),
        });
    },

    warn: (section: string, message: string, data?: TLazyValue) => {
        if (shouldDemoteWarning(section)) {
            BrowserLogger.debug(section, message, data);
            return;
        }

        if (!shouldLog('warn')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = resolveLazyValue(data);

        if (resolved !== undefined) {
            console.warn(`${prefix} ${message}`, resolved);
        } else {
            console.warn(`${prefix} ${message}`);
        }

        forwardToMain({
            level: 'warn',
            section,
            message,
            timestamp,
            data: serializeForRendererLog(resolved),
        });
    },

    warnThrottled: (
        section: string,
        key: string,
        intervalMs: number,
        message: string,
        data?: TLazyValue,
    ) => {
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
        BrowserLogger.warn(section, message, enriched);
    },

    error: (section: string, message: string, error?: TLazyValue) => {
        if (!shouldLog('error')) {
            return;
        }

        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${section}]`;

        const resolved = resolveLazyValue(error);

        if (resolved !== undefined) {
            console.error(`${prefix} ${message}`, resolved);
        } else {
            console.error(`${prefix} ${message}`);
        }

        forwardToMain({
            level: 'error',
            section,
            message,
            timestamp,
            data: serializeForRendererLog(resolved),
        });
    },
};
