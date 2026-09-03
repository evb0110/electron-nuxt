/* eslint-disable @typescript-eslint/naming-convention */

import type {
    DiagnosticCode,
    DiagnosticContext,
    DiagnosticOperation,
} from '@contracts/diagnostics/diagnosticCodes';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import type {FailureSeverity} from '@contracts/diagnostics/diagnosticRecord';

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

export function getFailureReceipt(value: unknown): FailureReceipt | undefined {
    if (!value || typeof value !== 'object') {
        return undefined;
    }
    const candidate = (value as {failure?: unknown}).failure;
    if (!candidate || typeof candidate !== 'object') {
        return undefined;
    }
    const eventId = (candidate as {eventId?: unknown}).eventId;
    return typeof eventId === 'string' ? candidate as FailureReceipt : undefined;
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
