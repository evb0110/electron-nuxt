import {
    isDiagnosticCode,
    type DiagnosticCode,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import type {FailureSeverity} from '@contracts/diagnostics/diagnosticRecord';
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
 * ERROR entry. Reference-free ERROR entries remain valid during the migration
 * until issue #260 switches the compatibility gate to blocking and issue #265
 * removes the compatibility form.
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
// The ERROR branch keeps the migration-compatible ref-free shape, while the
// non-ERROR branch makes it impossible to attach a main failure identity.
export type IDebugLogEntry = IDebugLogEntryBase & (
    | {
        level?: Exclude<TDebugLogLevel, 'ERROR'>;
        failureRef?: never;
    }
    | {
        level: 'ERROR';
        /** Present only for main-owned ERROR entries. */
        failureRef?: IDebugLogFailureRef;
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

/**
 * Temporary migration switch for legacy main ERROR broadcasts. Issue #260
 * changes this to false once the blocking gate is ready; issue #265 removes
 * the switch and the ref-free branch after all legacy producers are gone.
 */
export const DEBUG_LOG_REF_FREE_ERROR_COMPATIBILITY = true;

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
 * The legacy ref-free ERROR form is intentionally accepted during migration.
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
            if (value.level === 'ERROR' && !DEBUG_LOG_REF_FREE_ERROR_COMPATIBILITY) {
                return null;
            }
            if (value.level === 'ERROR') {
                return {
                    source: value.source,
                    message: value.message,
                    timestamp: value.timestamp,
                    level: 'ERROR',
                };
            }
            return {
                source: value.source,
                message: value.message,
                timestamp: value.timestamp,
                ...(value.level === undefined ? {} : {level: value.level}),
            };
        }

        // A reference without an explicit ERROR level cannot be proven to be a
        // main-owned failure. Legacy ERROR entries without a ref remain valid.
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
}
