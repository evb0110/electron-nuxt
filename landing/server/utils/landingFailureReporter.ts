import {
    DIAGNOSTIC_DEFINITIONS,
    type DiagnosticCode,
} from '@contracts/diagnostics/diagnosticCodes';
import {createDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import {
    DIAGNOSTIC_RECORD_SCHEMA_VERSION,
    type DiagnosticRecord,
    type FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';

export interface ILandingFailureAdapter { send(record: DiagnosticRecord): void }

export interface ILandingFailureReporter { capture<C extends DiagnosticCode>(input: CaptureFailureInput<C>): FailureReceipt }

export const landingNoopFailureAdapter: ILandingFailureAdapter = Object.freeze({send: () => undefined});

export function createLandingFailureReporter(
    adapter: ILandingFailureAdapter = landingNoopFailureAdapter,
): ILandingFailureReporter {
    const capture = <C extends DiagnosticCode>(input: CaptureFailureInput<C>): FailureReceipt => {
        const definition = DIAGNOSTIC_DEFINITIONS[input.code];
        const occurredAt = Date.now();
        const severity: FailureSeverity = input.severity ?? definition.defaultSeverity;
        const eventId = createDiagnosticEventId();
        const record: DiagnosticRecord<C> = {
            schemaVersion: DIAGNOSTIC_RECORD_SCHEMA_VERSION,
            eventId,
            code: input.code,
            severity,
            runtime: 'landing-nitro',
            operation: input.operation ?? definition.operation,
            occurredAt,
            frames: [],
            context: input.context,
        };

        try {
            adapter.send(record);
        } catch {
            // An adapter is best effort and must not affect the caller.
        }

        return {
            eventId,
            code: input.code,
            occurredAt,
            severity,
        };
    };

    return {capture};
}

export const landingFailureReporter = createLandingFailureReporter();
