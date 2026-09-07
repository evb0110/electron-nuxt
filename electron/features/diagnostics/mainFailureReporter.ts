import type {DiagnosticCode} from '@contracts/diagnostics/diagnosticCodes';
import {
    createDiagnosticEventId,
    type DiagnosticEventId,
} from '@contracts/diagnostics/diagnosticEventId';
import {
    createDiagnosticFallbackEventId,
    createSafeDiagnosticEventId,
    safeDiagnosticNow,
} from '@contracts/diagnostics/diagnosticReporterIdentity';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
    type DiagnosticRuntime,
} from '@contracts/diagnostics/diagnosticRecord';
import type {
    CaptureFailureInput,
    FailureReceipt,
} from '@contracts/diagnostics/failureReceipt';
import {buildDiagnosticRecord} from '@contracts/diagnostics/buildDiagnosticRecord';
import {
    createDiagnosticBurstAdmissionReserver,
    createDiagnosticFailureReceipt,
    createDiagnosticBurstDecider,
    createDiagnosticSchemaDroppedReceiptFactory,
} from '@contracts/diagnostics/diagnosticReporterShared';
import {
    decodeDiagnosticsSuppressedCount,
    DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@contracts/diagnostics/diagnosticsCapability';

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
    captureRecord(value: unknown, inheritedSuppressedCount?: unknown): FailureReceipt;
    getHealthSnapshot(): IMainDiagnosticsHealthSnapshot;
    getPreference(): TMainDiagnosticsPreference;
    getGeneration(): number;
    isTransportReady(): boolean;
    setTransport(transport: IMainDiagnosticsTransport): void;
    setPreference(preference: unknown): void;
    waitForTransportReady(): Promise<void>;
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
    onPreferenceGranted?: () => void | Promise<void>;
}

export const MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT = DIAGNOSTICS_MAX_SUPPRESSED_COUNT;
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
const DROPPED_MAIN_DIAGNOSTICS_TRANSPORT: IMainDiagnosticsTransport = Object.freeze({
    isReady: false,
    send: () => false,
});

interface IBurstState {
    sentCount: number;
    startedAt: number;
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

function incrementBy(value: number, amount: number) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
        return value;
    }
    return value >= Number.MAX_SAFE_INTEGER - amount ? Number.MAX_SAFE_INTEGER : value + amount;
}

function addSuppressedCounts(...counts: readonly number[]) {
    let total = 0;
    for (const count of counts) {
        total = Math.min(MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT, total + count);
    }
    return total;
}

function nextFallbackEventIdCounter() {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    return fallbackEventIdCounter;
}

const createFallbackEventId = () => createDiagnosticFallbackEventId(nextFallbackEventIdCounter);

function buildMainDiagnosticRecord(
    input: CaptureFailureInput,
    eventId: DiagnosticEventId,
    occurredAt: number,
) {
    return buildDiagnosticRecord(input, eventId, occurredAt, {
        fallbackCode: 'UNCLASSIFIED_MAIN_ERROR',
        fallbackOperation: 'main-error',
        internalFrameSuffixes: MAIN_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES,
        runtime: MAIN_DIAGNOSTICS_RUNTIME,
    });
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
    let transport = options.transport ?? options.adapter ?? NOOP_MAIN_DIAGNOSTICS_TRANSPORT;
    let preference = normalizePreference(options.preference);
    const health = createHealthState(preference);
    let generation = 0;
    let liveTransport = preference === 'granted'
        ? transport
        : DROPPED_MAIN_DIAGNOSTICS_TRANSPORT;
    let transportReady = Promise.resolve();
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
            if (typeof liveTransport.isReady === 'function') {
                return liveTransport.isReady() === true;
            }
            if (typeof liveTransport.isReady === 'boolean') {
                return liveTransport.isReady;
            }
            return typeof liveTransport.send === 'function' || typeof liveTransport.capture === 'function';
        } catch {
            return false;
        }
    }

    function sendToTransport(record: DiagnosticRecord, suppressedCount: number): unknown {
        try {
            const sender = liveTransport.send ?? liveTransport.capture;
            if (!sender) {
                return false;
            }
            const result = suppressedCount > 0
                ? sender(record, suppressedCount)
                : sender(record);
            return result;
        } catch {
            return false;
        }
    }

    function reportTransportFailure() {
        health.transportFailed = increment(health.transportFailed);
        setDropReason('transport-failed');
    }

    function reportTransportResult(
        result: unknown,
        generationAtAdmission: number,
    ) {
        const isCurrent = () => generationAtAdmission === generation
            && preference === 'granted'
            && liveTransport !== DROPPED_MAIN_DIAGNOSTICS_TRANSPORT;
        try {
            if (
                result === null
                || (typeof result !== 'object' && typeof result !== 'function')
                || typeof (result as {then?: unknown}).then !== 'function'
            ) {
                if (!isCurrent()) {
                    return;
                }
                if (result === false) {
                    reportTransportFailure();
                } else {
                    health.accepted = increment(health.accepted);
                }
                return;
            }
            void Promise.resolve<unknown>(result).then(
                (resolved: unknown) => {
                    if (!isCurrent()) {
                        return;
                    }
                    if (resolved === false) {
                        reportTransportFailure();
                    } else {
                        health.accepted = increment(health.accepted);
                    }
                },
                () => {
                    if (isCurrent()) {
                        reportTransportFailure();
                    }
                },
            );
        } catch {
            if (isCurrent()) {
                reportTransportFailure();
            }
        }
    }

    const decideBurst = createDiagnosticBurstDecider({
        burstStates,
        burstLimit,
        burstWindowMs,
        maxSuppressedCount: MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
        pruneBurstStates,
        onSuppressed: count => {
            health.burstSuppressed = incrementBy(health.burstSuppressed, count);
            setDropReason('burst-suppressed');
        },
    });

    const reserveAdmission = createDiagnosticBurstAdmissionReserver({
        burstStates,
        recentIds,
        pruneRecentIds,
        increment,
    });

    function processRecord(record: DiagnosticRecord, inheritedSuppressedCount = 0): FailureReceipt {
        const receipt = createDiagnosticFailureReceipt(record);
        health.attempted = increment(health.attempted);

        // Policy must run before either dedupe set is touched. A later grant may
        // retry this exact event ID once without losing the occurrence.
        if (preference !== 'granted') {
            health.policyDropped = increment(health.policyDropped);
            setDropReason('policy-dropped');
            return receipt;
        }

        const currentTime = safeDiagnosticNow(now);
        pruneRecentIds(currentTime);
        if (recentIds.has(record.eventId)) {
            health.duplicate = increment(health.duplicate);
            setDropReason('duplicate');
            return receipt;
        }

        if (!readTransportReady()) {
            reportTransportFailure();
            return receipt;
        }

        const decision = decideBurst(record, currentTime, inheritedSuppressedCount);
        if (!decision.send) {
            return receipt;
        }

        const suppressedCount = addSuppressedCounts(
            decision.suppressedCount,
            inheritedSuppressedCount,
        );
        const generationAtAdmission = generation;
        reserveAdmission(record, currentTime, decision);
        reportTransportResult(
            sendToTransport(record, suppressedCount),
            generationAtAdmission,
        );
        return receipt;
    }

    const createSchemaDroppedReceipt = createDiagnosticSchemaDroppedReceiptFactory(
        () => buildMainDiagnosticRecord(
            {} as CaptureFailureInput,
            createSafeDiagnosticEventId(createEventId, createFallbackEventId),
            safeDiagnosticNow(now),
        ),
        () => {
            health.attempted = increment(health.attempted);
            health.schemaDropped = increment(health.schemaDropped);
            setDropReason('schema-dropped');
        },
    );

    function applyPreference(value: unknown) {
        const nextPreference = normalizePreference(value);
        if (nextPreference !== 'granted') {
            // The drop transport is installed before the generation changes so
            // no later asynchronous work can use the old live path.
            liveTransport = DROPPED_MAIN_DIAGNOSTICS_TRANSPORT;
            if (preference !== nextPreference) {
                generation = increment(generation);
            }
        } else {
            liveTransport = transport;
        }
        preference = nextPreference;
        health.mode = nextPreference;
    }

    const reporter: IMainFailureReporter = {
        capture: <C extends DiagnosticCode>(input: CaptureFailureInput<C>) => {
            try {
                const record = buildMainDiagnosticRecord(
                    input,
                    createSafeDiagnosticEventId(createEventId, createFallbackEventId),
                    safeDiagnosticNow(now),
                );
                return processRecord(record);
            } catch {
                const record = buildMainDiagnosticRecord(
                    {} as CaptureFailureInput,
                    createFallbackEventId(),
                    safeDiagnosticNow(now),
                );
                return processRecord(record);
            }
        },
        captureRecord: (value, inheritedSuppressedCount) => {
            try {
                const record = decodeDiagnosticRecord(value);
                const decodedSuppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
                if (record !== null && decodedSuppressedCount !== null) {
                    return processRecord(record, decodedSuppressedCount);
                }
                if (record !== null) {
                    health.attempted = increment(health.attempted);
                    health.schemaDropped = increment(health.schemaDropped);
                    setDropReason('schema-dropped');
                    return createSchemaDroppedReceipt(record);
                }
            } catch {
                // A malformed external record is counted below and never crosses transport.
            }

            return createSchemaDroppedReceipt(null);
        },
        getHealthSnapshot: () => serializeHealthState(health),
        getPreference: () => preference,
        getGeneration: () => generation,
        isTransportReady: readTransportReady,
        setTransport: (nextTransport) => {
            transport = nextTransport;
            if (preference === 'granted') {
                generation = increment(generation);
                liveTransport = nextTransport;
            }
        },
        setPreference: (value) => {
            const wasGranted = preference === 'granted';
            applyPreference(value);
            if (!wasGranted && preference === 'granted') {
                try {
                    transportReady = Promise.resolve(options.onPreferenceGranted?.()).then(() => {});
                } catch {
                    // Adapter loading is best effort and must not affect app state.
                    transportReady = Promise.resolve();
                }
            } else if (preference !== 'granted') {
                transportReady = Promise.resolve();
            }
        },
        waitForTransportReady: () => transportReady,
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

export function waitForMainDiagnosticsTransportReady() {
    return mainFailureReporter?.waitForTransportReady() ?? Promise.resolve();
}
