import {
    createDiagnosticEventId,
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';

export function safeDiagnosticNow(now: () => number) {
    try {
        const value = now();
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

export function createDiagnosticFallbackEventId(
    nextCounter: () => number,
    normalizeTimestamp = false,
): DiagnosticEventId {
    let timestamp = 0;
    try {
        timestamp = Date.now();
    } catch {
        // Keep the fallback ID valid when the clock is unavailable.
    }
    const safeTimestamp = normalizeTimestamp && (
        !Number.isSafeInteger(timestamp) || timestamp < 0
    )
        ? 0
        : timestamp;
    const counter = nextCounter();
    const value = safeTimestamp.toString(16) + counter.toString(16);
    return value.slice(-32).padStart(32, '0') as DiagnosticEventId;
}

export function createSafeDiagnosticEventId(
    factory: () => DiagnosticEventId,
    fallbackFactory: () => DiagnosticEventId,
) {
    try {
        const eventId = factory();
        return isDiagnosticEventId(eventId) ? eventId : fallbackFactory();
    } catch {
        try {
            return createDiagnosticEventId();
        } catch {
            return fallbackFactory();
        }
    }
}
