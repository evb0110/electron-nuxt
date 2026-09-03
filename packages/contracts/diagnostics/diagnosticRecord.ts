/* eslint-disable @typescript-eslint/naming-convention */

import {
    decodeDiagnosticContext,
    isDiagnosticCode,
    isDiagnosticOperation,
    type DiagnosticCode,
    type DiagnosticContext,
    type DiagnosticOperation,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    decodeCanonicalAppFrame,
    MAX_CANONICAL_APP_FRAMES,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';

export type {CanonicalAppFrame} from '@contracts/diagnostics/canonicalAppFrames';
export type {
    DiagnosticCode,
    DiagnosticContext,
    DiagnosticOperation,
} from '@contracts/diagnostics/diagnosticCodes';
export type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';

export const DIAGNOSTIC_RECORD_SCHEMA_VERSION = 1;
export const MAX_DIAGNOSTIC_RECORD_FRAMES = MAX_CANONICAL_APP_FRAMES;

export type FailureSeverity = 'error' | 'fatal';

export const FAILURE_SEVERITIES = [
    'error',
    'fatal',
] as const;

export type DiagnosticRuntime =
    | 'electron-main'
    | 'electron-renderer'
    | 'hosted-browser'
    | 'viewer-nitro'
    | 'landing-nitro'
    | 'browser-worker-parent'
    | 'electron-worker-parent'
    | 'electron-utility-parent';

export const DIAGNOSTIC_RUNTIMES = [
    'electron-main',
    'electron-renderer',
    'hosted-browser',
    'viewer-nitro',
    'landing-nitro',
    'browser-worker-parent',
    'electron-worker-parent',
    'electron-utility-parent',
] as const satisfies readonly DiagnosticRuntime[];

export interface DiagnosticRecord<C extends DiagnosticCode = DiagnosticCode> {
    schemaVersion: typeof DIAGNOSTIC_RECORD_SCHEMA_VERSION;
    eventId: DiagnosticEventId;
    code: C;
    severity: FailureSeverity;
    runtime: DiagnosticRuntime;
    operation?: DiagnosticOperation;
    occurredAt: number;
    frames: readonly CanonicalAppFrame[];
    context: DiagnosticContext<C>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function hasOnlyArrayIndices(value: readonly unknown[]) {
    try {
        return Reflect.ownKeys(value).every(key => (
            key === 'length'
            || typeof key === 'string'
            && /^(?:0|[1-9][0-9]*)$/u.test(key)
            && Number(key) < value.length
        ));
    } catch {
        return false;
    }
}

function hasOnlyKeys(value: Record<string, unknown>, allowedKeys: readonly string[]) {
    const allowed = new Set(allowedKeys);
    try {
        return Reflect.ownKeys(value).every(key => typeof key === 'string' && allowed.has(key));
    } catch {
        return false;
    }
}

function hasRequiredKeys(value: Record<string, unknown>, requiredKeys: readonly string[]) {
    return requiredKeys.every(key => Object.hasOwn(value, key));
}

function isFiniteSafeTimestamp(value: unknown): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0;
}

function isFailureSeverity(value: unknown): value is FailureSeverity {
    return typeof value === 'string'
        && FAILURE_SEVERITIES.includes(value as FailureSeverity);
}

function isDiagnosticRuntime(value: unknown): value is DiagnosticRuntime {
    return typeof value === 'string'
        && DIAGNOSTIC_RUNTIMES.includes(value as DiagnosticRuntime);
}

export function decodeDiagnosticRecord(value: unknown): DiagnosticRecord | null {
    if (
        !isPlainRecord(value)
        || !hasRequiredKeys(value, [
            'schemaVersion',
            'eventId',
            'code',
            'severity',
            'runtime',
            'occurredAt',
            'frames',
            'context',
        ])
        || !hasOnlyKeys(value, [
            'schemaVersion',
            'eventId',
            'code',
            'severity',
            'runtime',
            'operation',
            'occurredAt',
            'frames',
            'context',
        ])
    ) {
        return null;
    }

    try {
        if (
            value.schemaVersion !== DIAGNOSTIC_RECORD_SCHEMA_VERSION
            || !isDiagnosticEventId(value.eventId)
            || !isDiagnosticCode(value.code)
            || !isFailureSeverity(value.severity)
            || !isDiagnosticRuntime(value.runtime)
            || !isFiniteSafeTimestamp(value.occurredAt)
            || !isUnknownArray(value.frames)
            || value.frames.length > MAX_DIAGNOSTIC_RECORD_FRAMES
            || !hasOnlyArrayIndices(value.frames)
        ) {
            return null;
        }

        const operation = Object.hasOwn(value, 'operation')
            ? value.operation
            : undefined;
        if ((Object.hasOwn(value, 'operation') && operation === undefined)
            || (operation !== undefined && !isDiagnosticOperation(operation))) {
            return null;
        }

        const frames: CanonicalAppFrame[] = [];
        for (let index = 0; index < value.frames.length; index += 1) {
            if (!Object.hasOwn(value.frames, index)) {
                return null;
            }
            const frame = decodeCanonicalAppFrame(value.frames[index]);
            if (frame === null) {
                return null;
            }
            frames.push(frame);
        }

        const code = value.code;
        const context = decodeDiagnosticContext(code, value.context);
        if (context === null) {
            return null;
        }

        const record: DiagnosticRecord = {
            schemaVersion: DIAGNOSTIC_RECORD_SCHEMA_VERSION,
            eventId: value.eventId,
            code,
            severity: value.severity,
            runtime: value.runtime,
            ...(operation === undefined ? {} : {operation}),
            occurredAt: value.occurredAt,
            frames,
            context,
        };
        return record;
    } catch {
        return null;
    }
}

export function isDiagnosticRecord(value: unknown): value is DiagnosticRecord {
    return decodeDiagnosticRecord(value) !== null;
}

export function requireDiagnosticRecord(value: unknown): DiagnosticRecord {
    const decoded = decodeDiagnosticRecord(value);
    if (decoded === null) {
        throw new TypeError('Invalid diagnostic record');
    }
    return decoded;
}
