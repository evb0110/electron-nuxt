import {
    decodeDiagnosticContext,
    DIAGNOSTIC_DEFINITIONS,
    isDiagnosticCode,
    isDiagnosticOperation,
    type DiagnosticCode,
    type DiagnosticContext,
    type DiagnosticOperation,
    type DiagnosticStackPolicy,
} from '@contracts/diagnostics/diagnosticCodes';
import {
    createDiagnosticEventId,
    isDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
    type DiagnosticRuntime,
    type FailureSeverity,
} from '@contracts/diagnostics/diagnosticRecord';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {
    normalizeCanonicalApplicationFrames,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';

export type TMainDiagnosticsPreference = 'unknown' | 'granted' | 'denied';

export type TMainDiagnosticsDropReason =
    | 'policy-dropped'
    | 'duplicate'
    | 'burst-suppressed'
    | 'schema-dropped'
    | 'frameless-dropped'
    | 'transport-failed';

export interface IMainDiagnosticsHealthSnapshot {
    mode: TMainDiagnosticsPreference;
    initializationCount: number;
    attempted: number;
    accepted: number;
    duplicate: number;
    burstSuppressed: number;
    policyDropped: number;
    schemaDropped: number;
    framelessDropped: number;
    ownedProjection: number;
    transportFailed: number;
    lastDropReason: TMainDiagnosticsDropReason | null;
}

export interface IMainDiagnosticsTransport {
    isReady?: boolean | (() => boolean);
    send?: (record: DiagnosticRecord, suppressedCount?: number) => unknown;
    capture?: (record: DiagnosticRecord, suppressedCount?: number) => unknown;
}

export interface IMainFailureReporter {
    capture<C extends DiagnosticCode>(input: CaptureFailureInput<C>): FailureReceipt;
    captureRecord(value: unknown): FailureReceipt;
    getHealthSnapshot(): IMainDiagnosticsHealthSnapshot;
    getPreference(): TMainDiagnosticsPreference;
    isTransportReady(): boolean;
    setPreference(preference: unknown): void;
}

export interface IMainFailureReporterOptions {
    adapter?: IMainDiagnosticsTransport;
    burstLimit?: number;
    burstWindowMs?: number;
    createEventId?: () => DiagnosticEventId;
    now?: () => number;
    preference?: unknown;
    recentIdWindowMs?: number;
    transport?: IMainDiagnosticsTransport;
}

export const MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT = 10_000;
export const MAIN_DIAGNOSTICS_DEFAULT_BURST_LIMIT = 20;
export const MAIN_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS = 60_000;
export const MAIN_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS = 10 * 60_000;

const MAIN_DIAGNOSTICS_RUNTIME: DiagnosticRuntime = 'electron-main';
const MAIN_DIAGNOSTICS_MAX_RECENT_IDS = 4_096;
const MAIN_DIAGNOSTICS_MAX_BURST_KEYS = 1_024;
const MAIN_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES = [
    'electron/features/diagnostics/mainFailureReporter.ts',
    'electron/utils/createLogger.ts',
] as const;

const NOOP_MAIN_DIAGNOSTICS_TRANSPORT: IMainDiagnosticsTransport = Object.freeze({
    isReady: true,
    send: () => undefined,
});

interface IBurstState {
    sentCount: number;
    startedAt: number;
    suppressedCount: number;
}

interface IBurstDecision {
    key: string;
    send: boolean;
    suppressedCount: number;
}

interface IHealthState extends IMainDiagnosticsHealthSnapshot {}

let fallbackEventIdCounter = 0;
let mainFailureReporter: IMainFailureReporter | null = null;

function normalizePreference(value: unknown): TMainDiagnosticsPreference {
    return value === 'granted' || value === 'denied' ? value : 'unknown';
}

function normalizePositiveInteger(value: unknown, fallback: number) {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value > 0
        ? value
        : fallback;
}

function increment(value: number) {
    return value >= Number.MAX_SAFE_INTEGER
        ? Number.MAX_SAFE_INTEGER
        : value + 1;
}

function safeNow(now: () => number) {
    try {
        const value = now();
        return Number.isSafeInteger(value) && value >= 0 ? value : 0;
    } catch {
        return 0;
    }
}

function createFallbackEventId(): DiagnosticEventId {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    let timestamp = 0;
    try {
        timestamp = Date.now();
    } catch {
        // Keep the fallback ID valid even if the clock is unavailable.
    }
    const value = `${timestamp.toString(16)}${fallbackEventIdCounter.toString(16)}`;
    return value.slice(-32).padStart(32, '0') as DiagnosticEventId;
}

function createSafeEventId(factory: () => DiagnosticEventId) {
    try {
        const eventId = factory();
        return isDiagnosticEventId(eventId) ? eventId : createFallbackEventId();
    } catch {
        try {
            return createDiagnosticEventId();
        } catch {
            return createFallbackEventId();
        }
    }
}

function readStack(value: unknown): string | undefined {
    if (typeof value === 'string') {
        return value;
    }
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    try {
        const stack = (value as {stack?: unknown}).stack;
        return typeof stack === 'string' ? stack : undefined;
    } catch {
        return undefined;
    }
}

function captureCallSiteStack() {
    try {
        return new Error().stack ?? '';
    } catch {
        return '';
    }
}

function removeReporterFrames(frames: readonly CanonicalAppFrame[]) {
    return frames.filter(frame => !MAIN_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES.some(suffix => (
        frame.module === suffix || frame.module.endsWith(`/${suffix}`)
    )));
}

function buildFrames(input: CaptureFailureInput, stackPolicy: DiagnosticStackPolicy) {
    const stack = stackPolicy === 'source'
        ? readStack(input.local?.cause) ?? captureCallSiteStack()
        : captureCallSiteStack();

    try {
        return removeReporterFrames(normalizeCanonicalApplicationFrames(stack).frames);
    } catch {
        return [];
    }
}

function fallbackContext(code: DiagnosticCode): DiagnosticContext<DiagnosticCode> {
    return decodeDiagnosticContext(code, {}) ?? {};
}

function buildClosedRecord(
    input: CaptureFailureInput,
    eventId: DiagnosticEventId,
    occurredAt: number,
): DiagnosticRecord {
    let code: DiagnosticCode = 'UNCLASSIFIED_MAIN_ERROR';
    let severity: FailureSeverity = DIAGNOSTIC_DEFINITIONS.UNCLASSIFIED_MAIN_ERROR.defaultSeverity;
    let operation: DiagnosticOperation = DIAGNOSTIC_DEFINITIONS.UNCLASSIFIED_MAIN_ERROR.operation;
    let context: DiagnosticContext<DiagnosticCode> = fallbackContext(code);
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
        context = decodeDiagnosticContext(code, input.context) ?? fallbackContext(code);
        frames = buildFrames(input, definition.stackPolicy);
    } catch {
        // The logger is a last-resort failure path. The fallback below remains closed.
    }

    const decoded = decodeDiagnosticRecord({
        schemaVersion: 1,
        eventId,
        code,
        severity,
        runtime: MAIN_DIAGNOSTICS_RUNTIME,
        operation,
        occurredAt,
        frames,
        context,
    });
    if (decoded !== null) {
        return decoded;
    }

    return decodeDiagnosticRecord({
        schemaVersion: 1,
        eventId,
        code: 'UNCLASSIFIED_MAIN_ERROR',
        severity: 'error',
        runtime: MAIN_DIAGNOSTICS_RUNTIME,
        operation: 'main-error',
        occurredAt,
        frames: [],
        context: {},
    })!;
}

function createReceipt(record: DiagnosticRecord): FailureReceipt {
    return {
        eventId: record.eventId,
        code: record.code,
        occurredAt: record.occurredAt,
        severity: record.severity,
    };
}

function getTopFrameKey(record: DiagnosticRecord) {
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

function getBurstKey(record: DiagnosticRecord) {
    return `${record.code}|${getTopFrameKey(record)}`;
}

function createHealthState(preference: TMainDiagnosticsPreference): IHealthState {
    return {
        mode: preference,
        initializationCount: 1,
        attempted: 0,
        accepted: 0,
        duplicate: 0,
        burstSuppressed: 0,
        policyDropped: 0,
        schemaDropped: 0,
        framelessDropped: 0,
        ownedProjection: 0,
        transportFailed: 0,
        lastDropReason: null,
    };
}

function serializeHealthState(state: IHealthState): IMainDiagnosticsHealthSnapshot {
    return Object.freeze({
        mode: state.mode,
        initializationCount: state.initializationCount,
        attempted: state.attempted,
        accepted: state.accepted,
        duplicate: state.duplicate,
        burstSuppressed: state.burstSuppressed,
        policyDropped: state.policyDropped,
        schemaDropped: state.schemaDropped,
        framelessDropped: state.framelessDropped,
        ownedProjection: state.ownedProjection,
        transportFailed: state.transportFailed,
        lastDropReason: state.lastDropReason,
    });
}

export function createNoopMainDiagnosticsTransport() {
    return NOOP_MAIN_DIAGNOSTICS_TRANSPORT;
}

export function createMainFailureReporter(
    options: IMainFailureReporterOptions = {},
): IMainFailureReporter {
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const burstLimit = normalizePositiveInteger(
        options.burstLimit,
        MAIN_DIAGNOSTICS_DEFAULT_BURST_LIMIT,
    );
    const burstWindowMs = normalizePositiveInteger(
        options.burstWindowMs,
        MAIN_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS,
    );
    const recentIdWindowMs = normalizePositiveInteger(
        options.recentIdWindowMs,
        MAIN_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS,
    );
    const transport = options.transport ?? options.adapter ?? NOOP_MAIN_DIAGNOSTICS_TRANSPORT;
    let preference = normalizePreference(options.preference);
    const health = createHealthState(preference);
    const recentIds = new Map<DiagnosticEventId, number>();
    const burstStates = new Map<string, IBurstState>();

    function setDropReason(reason: TMainDiagnosticsDropReason) {
        health.lastDropReason = reason;
    }

    function pruneRecentIds(currentTime: number) {
        for (const [
            eventId,
            acceptedAt,
        ] of recentIds) {
            if (currentTime - acceptedAt >= recentIdWindowMs) {
                recentIds.delete(eventId);
            }
        }
        while (recentIds.size > MAIN_DIAGNOSTICS_MAX_RECENT_IDS) {
            const oldestEventId = recentIds.keys().next().value;
            if (oldestEventId === undefined) {
                break;
            }
            recentIds.delete(oldestEventId);
        }
    }

    function pruneBurstStates() {
        while (burstStates.size > MAIN_DIAGNOSTICS_MAX_BURST_KEYS) {
            const oldestKey = burstStates.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            burstStates.delete(oldestKey);
        }
    }

    function readTransportReady() {
        try {
            if (typeof transport.isReady === 'function') {
                return transport.isReady() === true;
            }
            if (typeof transport.isReady === 'boolean') {
                return transport.isReady;
            }
            return typeof transport.send === 'function' || typeof transport.capture === 'function';
        } catch {
            return false;
        }
    }

    function sendToTransport(record: DiagnosticRecord, suppressedCount: number) {
        try {
            const sender = transport.send ?? transport.capture;
            if (!sender) {
                return false;
            }
            const result = suppressedCount > 0
                ? sender(record, suppressedCount)
                : sender(record);
            return result !== false;
        } catch {
            return false;
        }
    }

    function decideBurst(record: DiagnosticRecord, currentTime: number): IBurstDecision {
        const key = getBurstKey(record);
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
                suppressedCount: Math.min(
                    previous?.suppressedCount ?? 0,
                    MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
                ),
            };
        }

        if (previous.sentCount >= burstLimit) {
            previous.suppressedCount = Math.min(
                MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
                increment(previous.suppressedCount),
            );
            health.burstSuppressed = increment(health.burstSuppressed);
            setDropReason('burst-suppressed');
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

    function markAccepted(record: DiagnosticRecord, currentTime: number, decision: IBurstDecision) {
        const state = burstStates.get(decision.key);
        if (state) {
            state.sentCount = increment(state.sentCount);
            state.suppressedCount = 0;
        }
        recentIds.set(record.eventId, currentTime);
        pruneRecentIds(currentTime);
        health.accepted = increment(health.accepted);
    }

    function processRecord(record: DiagnosticRecord): FailureReceipt {
        const receipt = createReceipt(record);
        health.attempted = increment(health.attempted);

        // Policy must run before either dedupe set is touched. A later grant may
        // retry this exact event ID once without losing the occurrence.
        if (preference !== 'granted') {
            health.policyDropped = increment(health.policyDropped);
            setDropReason('policy-dropped');
            return receipt;
        }

        const currentTime = safeNow(now);
        pruneRecentIds(currentTime);
        if (recentIds.has(record.eventId)) {
            health.duplicate = increment(health.duplicate);
            setDropReason('duplicate');
            return receipt;
        }

        if (!readTransportReady()) {
            health.transportFailed = increment(health.transportFailed);
            setDropReason('transport-failed');
            return receipt;
        }

        const decision = decideBurst(record, currentTime);
        if (!decision.send) {
            return receipt;
        }

        if (!sendToTransport(record, decision.suppressedCount)) {
            health.transportFailed = increment(health.transportFailed);
            setDropReason('transport-failed');
            return receipt;
        }

        markAccepted(record, currentTime, decision);
        return receipt;
    }

    const reporter: IMainFailureReporter = {
        capture: <C extends DiagnosticCode>(input: CaptureFailureInput<C>) => {
            try {
                const record = buildClosedRecord(
                    input,
                    createSafeEventId(createEventId),
                    safeNow(now),
                );
                return processRecord(record);
            } catch {
                const record = buildClosedRecord(
                    {} as CaptureFailureInput,
                    createFallbackEventId(),
                    safeNow(now),
                );
                return processRecord(record);
            }
        },
        captureRecord: (value) => {
            try {
                const record = decodeDiagnosticRecord(value);
                if (record !== null) {
                    return processRecord(record);
                }
            } catch {
                // A malformed external record is counted below and never crosses transport.
            }

            health.attempted = increment(health.attempted);
            health.schemaDropped = increment(health.schemaDropped);
            setDropReason('schema-dropped');
            const fallbackRecord = buildClosedRecord(
                {} as CaptureFailureInput,
                createSafeEventId(createEventId),
                safeNow(now),
            );
            return createReceipt(fallbackRecord);
        },
        getHealthSnapshot: () => serializeHealthState(health),
        getPreference: () => preference,
        isTransportReady: readTransportReady,
        setPreference: (value) => {
            preference = normalizePreference(value);
            health.mode = preference;
        },
    };

    return reporter;
}

export function initializeMainFailureReporter(
    options: IMainFailureReporterOptions = {},
) {
    if (mainFailureReporter) {
        return mainFailureReporter;
    }
    mainFailureReporter = createMainFailureReporter(options);
    return mainFailureReporter;
}

export function getMainFailureReporter() {
    return mainFailureReporter;
}

export function captureMainFailure<C extends DiagnosticCode>(input: CaptureFailureInput<C>) {
    return mainFailureReporter?.capture(input);
}

export function setMainDiagnosticsPreference(preference: unknown) {
    mainFailureReporter?.setPreference(preference);
}
