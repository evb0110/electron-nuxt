import {
    decodeDiagnosticContext,
    DIAGNOSTIC_DEFINITIONS,
    isDiagnosticCode,
    isDiagnosticOperation,
    type DiagnosticCode,
    type DiagnosticOperation,
    type DiagnosticStackPolicy,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
    type DiagnosticRuntime,
    type FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import type {CaptureFailureInput} from '@contracts/diagnostics/failureReceipt';
import type {CanonicalAppFrame} from '@contracts/diagnostics/canonicalAppFrames';
import {
    buildDiagnosticFrames,
    fallbackDiagnosticContext,
} from '@contracts/diagnostics/diagnosticReporterFrames';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';

export interface IBuildDiagnosticRecordOptions {
    fallbackCode: DiagnosticCode;
    fallbackOperation: DiagnosticOperation;
    internalFrameSuffixes: readonly string[];
    runtime: DiagnosticRuntime;
    stackPolicyOverride?: DiagnosticStackPolicy | undefined;
}

export function buildDiagnosticRecord(
    input: CaptureFailureInput,
    eventId: DiagnosticEventId,
    occurredAt: number,
    options: IBuildDiagnosticRecordOptions,
): DiagnosticRecord {
    let code: DiagnosticCode = options.fallbackCode;
    let severity: FailureSeverity = DIAGNOSTIC_DEFINITIONS[options.fallbackCode].defaultSeverity;
    let operation: DiagnosticOperation = DIAGNOSTIC_DEFINITIONS[options.fallbackCode].operation;
    let context = fallbackDiagnosticContext(code);
    let frames: readonly CanonicalAppFrame[] = [];

    try {
        if (isDiagnosticCode(input.code)) {
            code = input.code;
        }
        const definition = DIAGNOSTIC_DEFINITIONS[code];
        severity = input.severity === 'fatal' || input.severity === 'error'
            ? input.severity
            : definition.defaultSeverity;
        operation = isDiagnosticOperation(input.operation)
            ? input.operation
            : definition.operation;
        context = decodeDiagnosticContext(code, input.context) ?? fallbackDiagnosticContext(code);
        frames = buildDiagnosticFrames(
            input,
            options.stackPolicyOverride ?? definition.stackPolicy,
            options.internalFrameSuffixes,
        );
    } catch {
        // A failure reporter must reduce to a closed fallback record.
    }

    const decoded = decodeDiagnosticRecord({
        schemaVersion: 1,
        eventId,
        code,
        severity,
        runtime: options.runtime,
        operation,
        occurredAt,
        frames,
        context,
    });
    if (decoded !== null) {
        return decoded;
    }

    const fallback = decodeDiagnosticRecord({
        schemaVersion: 1,
        eventId,
        code: options.fallbackCode,
        severity: 'error',
        runtime: options.runtime,
        operation: options.fallbackOperation,
        occurredAt,
        frames: [],
        context: {},
    });
    if (fallback === null) {
        throw new Error(`Unable to create a ${options.fallbackCode} failure record`);
    }
    return fallback;
}
