import type { DiagnosticRecord } from '@contracts/diagnostics/diagnosticRecord';
import type {
    IDebugLogEntry,
    TMenuEventUnsubscribe,
} from '@contracts/electronApiCommon';

export const DIAGNOSTICS_MAX_SUPPRESSED_COUNT = 10_000;

export const DIAGNOSTICS_POLICY_HINTS = [
    'unknown',
    'granted',
    'denied',
] as const;

export type TDiagnosticsPolicyHint = typeof DIAGNOSTICS_POLICY_HINTS[number];

export interface IDiagnosticsStartupPolicy {mode: TDiagnosticsPolicyHint;}

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
 * The complete diagnostics capability available to renderer application code.
 * Preload owns the IPC channel and main owns transport admission.
 */
export interface IDiagnosticsRendererCapability {
    startupPolicy: Readonly<IDiagnosticsStartupPolicy>;
    sendRecord: (record: DiagnosticRecord, suppressedCount?: number) => void;
    onDebugLog: (callback: (entry: IDebugLogEntry) => void) => TMenuEventUnsubscribe;
}
