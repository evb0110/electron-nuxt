import {
    isDiagnosticCode,
    type DiagnosticCode,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import type {FailureSeverity} from '@contracts/diagnostics/diagnosticRecord';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import {
    isOneOf,
    isRecord,
} from '@contracts/runtimeGuards';

export type TMenuEventCallback = () => void;

export type TMenuEventUnsubscribe = () => void;

export type TDebugLogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
export type TRendererLogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * The only identity a main-process ERROR projection may carry.
 * `decodeDebugLogEntry` enforces that this closed object appears only on an
 * ERROR entry. Reference-free ERROR entries are rejected.
 */
export interface IDebugLogFailureRef {
    eventId: DiagnosticEventId;
    code: DiagnosticCode;
    severity: FailureSeverity;
}

interface IDebugLogEntryBase {
    source: string;
    message: string;
    timestamp: string;
}

// Main-process diagnostic logs use the native Electron/logger channel casing.
// The ERROR branch requires a main-owned failure identity. The non-ERROR branch
// makes it impossible to attach one.
export type IDebugLogEntry = IDebugLogEntryBase & (
    | {
        level?: Exclude<TDebugLogLevel, 'ERROR'>;
        failureRef?: never;
    }
    | {
        level: 'ERROR';
        failureRef: IDebugLogFailureRef;
    }
);

const DEBUG_LOG_LEVELS = [
    'DEBUG',
    'INFO',
    'WARN',
    'ERROR',
] as const satisfies readonly TDebugLogLevel[];

const DEBUG_LOG_ENTRY_KEYS = [
    'source',
    'message',
    'timestamp',
    'level',
    'failureRef',
] as const;

const DEBUG_LOG_FAILURE_REF_KEYS = [
    'eventId',
    'code',
    'severity',
] as const;

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
    try {
        return Reflect.ownKeys(value).every(key => (
            typeof key === 'string' && allowedKeys.includes(key)
        ));
    } catch {
        return false;
    }
}

function decodeDebugLogFailureRef(value: unknown): IDebugLogFailureRef | null {
    if (!isRecord(value) || !hasOnlyKeys(value, DEBUG_LOG_FAILURE_REF_KEYS)
        || !Object.hasOwn(value, 'eventId')
        || !Object.hasOwn(value, 'code')
        || !Object.hasOwn(value, 'severity')
        || !isDiagnosticEventId(value.eventId)
        || !isDiagnosticCode(value.code)
        || (value.severity !== 'error' && value.severity !== 'fatal')) {
        return null;
    }

    return {
        eventId: value.eventId,
        code: value.code,
        severity: value.severity,
    };
}

/**
 * Decodes the one closed debug-log envelope used by settings and diagnostics.
 * Reference-free ERROR entries are rejected because the renderer must never
 * reinterpret a main-process error as a new occurrence.
 */
export function decodeDebugLogEntry(value: unknown): IDebugLogEntry | null {
    try {
        if (!isRecord(value)
            || !hasOnlyKeys(value, DEBUG_LOG_ENTRY_KEYS)
            || typeof value.source !== 'string'
            || typeof value.message !== 'string'
            || typeof value.timestamp !== 'string'
            || (value.level !== undefined && !isOneOf(DEBUG_LOG_LEVELS, value.level))) {
            return null;
        }

        if (value.failureRef === undefined) {
            if (value.level === 'ERROR') {
                return null;
            }
            return {
                source: value.source,
                message: value.message,
                timestamp: value.timestamp,
                ...(value.level === undefined ? {} : {level: value.level}),
            };
        }

        // A reference without an explicit ERROR level cannot be proven to be a
        // main-owned failure.
        if (value.level !== 'ERROR') {
            return null;
        }
        const failureRef = decodeDebugLogFailureRef(value.failureRef);
        if (failureRef === null) {
            return null;
        }

        return {
            source: value.source,
            message: value.message,
            timestamp: value.timestamp,
            level: 'ERROR',
            failureRef,
        };
    } catch {
        return null;
    }
}

export interface IRendererLogEntry {
    // Renderer logs mirror BrowserLogger casing before they are bridged to main.
    level: TRendererLogLevel;
    section: string;
    message: string;
    timestamp: string;
    data?: unknown;
    failureRef?: FailureReceipt;
}
