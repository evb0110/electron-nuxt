import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';

export const DIAGNOSTICS_MAX_SUPPRESSED_COUNT = 10_000;

/** Undefined is the legacy no-summary form. All supplied values are strict. */
export function decodeDiagnosticsSuppressedCount(value: unknown): number | null {
    if (value === undefined) {
        return 0;
    }
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= 0
        && value <= DIAGNOSTICS_MAX_SUPPRESSED_COUNT
        ? value
        : null;
}

/**
 * The only diagnostics operation available to renderer application code.
 * Preload owns the IPC channel and main owns transport admission.
 */
export interface IDiagnosticsRendererCapability {sendRecord: (record: DiagnosticRecord, suppressedCount?: number) => void;}
