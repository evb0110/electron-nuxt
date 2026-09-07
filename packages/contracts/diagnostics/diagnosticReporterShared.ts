import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import type {FailureReceipt} from '@contracts/diagnostics/failureReceipt';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';

export interface IDiagnosticBurstState {
    sentCount: number;
    startedAt: number;
    suppressedCount: number;
}

export interface IDiagnosticBurstDecision {
    key: string;
    send: boolean;
    suppressedCount: number;
}

export interface IDiagnosticBurstDeciderOptions {
    burstStates: Map<string, IDiagnosticBurstState>;
    burstLimit: number;
    burstWindowMs: number;
    maxSuppressedCount: number;
    pruneBurstStates: () => void;
    onSuppressed: (count: number) => void;
}

export function createDiagnosticFailureReceipt(record: DiagnosticRecord): FailureReceipt {
    return {
        eventId: record.eventId,
        code: record.code,
        occurredAt: record.occurredAt,
        severity: record.severity,
    };
}

export function getDiagnosticTopFrameKey(record: DiagnosticRecord) {
    const frame = record.frames[0];
    if (!frame) {
        return '<none>';
    }
    return [
        frame.module,
        frame.function ?? '',
        frame.line === undefined ? '' : String(frame.line),
        frame.column === undefined ? '' : String(frame.column),
    ].join('|');
}

export function getDiagnosticBurstKey(record: DiagnosticRecord) {
    return `${record.code}|${getDiagnosticTopFrameKey(record)}`;
}

export function decideDiagnosticBurst({
    record,
    currentTime,
    burstStates,
    burstLimit,
    burstWindowMs,
    maxSuppressedCount,
    inheritedSuppressedCount = 0,
    pruneBurstStates,
    onSuppressed,
}: {
    record: DiagnosticRecord;
    currentTime: number;
    burstStates: Map<string, IDiagnosticBurstState>;
    burstLimit: number;
    burstWindowMs: number;
    maxSuppressedCount: number;
    inheritedSuppressedCount?: number;
    pruneBurstStates: () => void;
    onSuppressed: (count: number) => void;
}): IDiagnosticBurstDecision {
    const key = getDiagnosticBurstKey(record);
    const previous = burstStates.get(key);
    if (!previous || currentTime - previous.startedAt >= burstWindowMs) {
        burstStates.set(key, {
            sentCount: 0,
            startedAt: currentTime,
            suppressedCount: 0,
        });
        pruneBurstStates();
        return {
            key,
            send: true,
            suppressedCount: Math.min(previous?.suppressedCount ?? 0, maxSuppressedCount),
        };
    }

    if (previous.sentCount >= burstLimit) {
        const suppressedCount = Math.min(
            maxSuppressedCount,
            previous.suppressedCount + 1 + inheritedSuppressedCount,
        );
        previous.suppressedCount = suppressedCount;
        onSuppressed(1 + inheritedSuppressedCount);
        return {
            key,
            send: false,
            suppressedCount: 0,
        };
    }

    return {
        key,
        send: true,
        suppressedCount: 0,
    };
}

export function createDiagnosticBurstDecider(options: IDiagnosticBurstDeciderOptions) {
    return (
        record: DiagnosticRecord,
        currentTime: number,
        inheritedSuppressedCount = 0,
    ) => decideDiagnosticBurst({
        ...options,
        record,
        currentTime,
        inheritedSuppressedCount,
    });
}

export function reserveDiagnosticBurstAdmission({
    record,
    currentTime,
    decision,
    burstStates,
    recentIds,
    pruneRecentIds,
    increment,
}: {
    record: DiagnosticRecord;
    currentTime: number;
    decision: Pick<IDiagnosticBurstDecision, 'key'>;
    burstStates: Map<string, IDiagnosticBurstState>;
    recentIds: Map<DiagnosticEventId, number>;
    pruneRecentIds: (currentTime: number) => void;
    increment: (value: number) => number;
}) {
    const state = burstStates.get(decision.key);
    if (state) {
        state.sentCount = increment(state.sentCount);
        state.suppressedCount = 0;
    }
    recentIds.set(record.eventId, currentTime);
    pruneRecentIds(currentTime);
}

export function createDiagnosticBurstAdmissionReserver(options: {
    burstStates: Map<string, IDiagnosticBurstState>;
    recentIds: Map<DiagnosticEventId, number>;
    pruneRecentIds: (currentTime: number) => void;
    increment: (value: number) => number;
}) {
    return (record: DiagnosticRecord, currentTime: number, decision: Pick<IDiagnosticBurstDecision, 'key'>) => (
        reserveDiagnosticBurstAdmission({
            ...options,
            record,
            currentTime,
            decision,
        })
    );
}

export function createDiagnosticSchemaDroppedReceiptFactory(
    buildFallbackRecord: () => DiagnosticRecord,
    onDrop: () => void,
) {
    return (record: DiagnosticRecord | null) => {
        onDrop();
        return createDiagnosticFailureReceipt(record ?? buildFallbackRecord());
    };
}
