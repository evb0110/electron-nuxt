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
    occurredAt: number;
    severity: FailureSeverity;
}

const FAILURE_RECEIPT_KEYS = [
    'eventId',
    'code',
    'occurredAt',
    'severity',
] as const;

export function decodeFailureReceipt(value: unknown): FailureReceipt | null {
    if (!isPlainRecord(value)) {
        return null;
    }
    try {
        const keys = Reflect.ownKeys(value);
        if (
            keys.length !== FAILURE_RECEIPT_KEYS.length
            || !keys.every(key => typeof key === 'string' && FAILURE_RECEIPT_KEYS.includes(
                key as typeof FAILURE_RECEIPT_KEYS[number],
            ))
            || !isDiagnosticEventId(value.eventId)
            || !isDiagnosticCode(value.code)
            || !Number.isSafeInteger(value.occurredAt)
            || (value.occurredAt as number) < 0
            || !FAILURE_SEVERITIES.includes(value.severity as FailureSeverity)
        ) {
            return null;
        }
        return {
            eventId: value.eventId,
            code: value.code,
            occurredAt: value.occurredAt as number,
            severity: value.severity as FailureSeverity,
        };
    } catch {
        return null;
    }
}

export function getFailureReceipt(value: unknown): FailureReceipt | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    return decodeFailureReceipt((value as {failure?: unknown}).failure) ?? undefined;
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
            && EXPECTED_OUTCOME_CODES.includes(value.code as ExpectedOutcomeCode);
    } catch {
        return false;
    }
}
