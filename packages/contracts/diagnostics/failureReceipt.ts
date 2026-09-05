/* eslint-disable @typescript-eslint/naming-convention */

import {
    isDiagnosticCode,
    type DiagnosticCode,
    type DiagnosticContext,
    type DiagnosticOperation,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    FAILURE_SEVERITIES,
    type FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import {
    isEpochMs,
    type TEpochMs,
} from '@contracts/timestamps';

export interface LocalFailureDetail {
    source: string;
    message: string;
    cause?: unknown;
    data?: unknown;
}

export interface CaptureFailureInput<C extends DiagnosticCode = DiagnosticCode> {
    code: C;
    severity?: FailureSeverity;
    operation?: DiagnosticOperation;
    context: DiagnosticContext<C>;
    local: LocalFailureDetail;
}

export interface FailureReceipt {
    eventId: DiagnosticEventId;
    code: DiagnosticCode;
    occurredAt: TEpochMs;
    severity: FailureSeverity;
}

const FAILURE_RECEIPT_KEYS = [
    'eventId',
    'code',
    'occurredAt',
    'severity',
] as const;

function isFailureSeverity(value: unknown): value is FailureSeverity {
    return typeof value === 'string'
        && FAILURE_SEVERITIES.some(severity => severity === value);
}

export function decodeFailureReceipt(value: unknown): FailureReceipt | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    try {
        const keys = Reflect.ownKeys(value);
        if (
            keys.length !== FAILURE_RECEIPT_KEYS.length
            || !keys.every(key => typeof key === 'string' && FAILURE_RECEIPT_KEYS.some(allowedKey => allowedKey === key))
            || !isDiagnosticEventId(value.eventId)
            || !isDiagnosticCode(value.code)
            || !isEpochMs(value.occurredAt)
            || !isFailureSeverity(value.severity)
        ) {
            return null;
        }
        return {
            eventId: value.eventId,
            code: value.code,
            occurredAt: value.occurredAt,
            severity: value.severity,
        };
    } catch {
        return null;
    }
}

export function getFailureReceipt(value: unknown): FailureReceipt | undefined {
    if (typeof value !== 'object' || value === null || !('failure' in value)) {
        return undefined;
    }
    return decodeFailureReceipt(value.failure) ?? undefined;
}

export const EXPECTED_OUTCOME_CODES = [
    'canceled',
    'validation-rejected',
    'unsupported-input',
    'handled-absence',
    'temporarily-unavailable',
] as const;

export type ExpectedOutcomeCode = typeof EXPECTED_OUTCOME_CODES[number];

export interface ExpectedOutcome {
    kind: 'expected';
    code: ExpectedOutcomeCode;
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

export function isExpectedOutcome(value: unknown): value is ExpectedOutcome {
    if (!isPlainRecord(value)) {
        return false;
    }
    try {
        const keys = Reflect.ownKeys(value);
        return keys.length === 2
            && keys.every(key => key === 'kind' || key === 'code')
            && Object.hasOwn(value, 'kind')
            && Object.hasOwn(value, 'code')
            && value.kind === 'expected'
            && typeof value.code === 'string'
            && EXPECTED_OUTCOME_CODES.some(code => code === value.code);
    } catch {
        return false;
    }
}
