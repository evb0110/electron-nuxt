import type {H3Event} from 'h3';
import type {
    DiagnosticCode,
    DiagnosticStackPolicy,
} from '@contracts/diagnostics/diagnosticCodes';
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
    LocalFailureDetail,
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
import {hasDiagnosticsServerObjection} from '@server/utils/diagnosticsObjection';
import {createSentryNitroAdapter} from '@server/utils/sentryNitroAdapter';

export type TServerDiagnosticsMode = 'disabled' | 'enabled';

export type TServerDiagnosticsDropReason =
    | 'policy-dropped'
    | 'duplicate'
    | 'burst-suppressed'
    | 'schema-dropped'
    | 'frameless-dropped'
    | 'transport-failed';

export interface IServerDiagnosticsHealthSnapshot {
    mode: TServerDiagnosticsMode;
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
    lastDropReason: TServerDiagnosticsDropReason | null;
}

export interface IServerDiagnosticsTransport {
    readonly isReady?: boolean | (() => boolean);
    readonly send?: (record: DiagnosticRecord, suppressedCount?: number) => unknown;
    readonly capture?: (record: DiagnosticRecord, suppressedCount?: number) => unknown;
}

export interface IServerFailureReporter {
    capture<C extends DiagnosticCode>(
        input: CaptureFailureInput<C>,
        event?: H3Event,
    ): FailureReceipt;
    captureUncaught(error: unknown, event?: H3Event): FailureReceipt | undefined;
    captureRecord(
        value: unknown,
        inheritedSuppressedCount?: unknown,
        event?: H3Event,
    ): FailureReceipt;
    getHealthSnapshot(): IServerDiagnosticsHealthSnapshot;
    isTransportReady(): boolean;
}

export interface IServerFailureReporterOptions {
    readonly adapter?: IServerDiagnosticsTransport;
    readonly burstLimit?: number;
    readonly burstWindowMs?: number;
    readonly createEventId?: () => DiagnosticEventId;
    readonly localSink?: (detail: LocalFailureDetail) => void;
    readonly now?: () => number;
    readonly recentIdWindowMs?: number;
    readonly transport?: IServerDiagnosticsTransport;
}

export const SERVER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT = DIAGNOSTICS_MAX_SUPPRESSED_COUNT;
export const SERVER_DIAGNOSTICS_DEFAULT_BURST_LIMIT = 20;
export const SERVER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS = 60_000;
export const SERVER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS = 10 * 60_000;

const SERVER_DIAGNOSTICS_RUNTIME: DiagnosticRuntime = 'viewer-nitro';
const SERVER_DIAGNOSTICS_MAX_RECENT_IDS = 4_096;
const SERVER_DIAGNOSTICS_MAX_BURST_KEYS = 1_024;
const SERVER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES = [
    'server/plugins/diagnostics.ts',
    'server/utils/diagnosticsObjection.ts',
    'server/utils/serverFailureReporter.ts',
    'server/utils/sentryNitroAdapter.ts',
] as const;

interface IBurstState {
    sentCount: number;
    startedAt: number;
    suppressedCount: number;
}

interface IHealthState extends IServerDiagnosticsHealthSnapshot {}

interface IProcessResult {
    readonly policyDropped: boolean;
    readonly receipt: FailureReceipt;
}

let fallbackEventIdCounter = 0;
let serverFailureReporter: IServerFailureReporter | null = null;

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
    return value >= Number.MAX_SAFE_INTEGER - amount
        ? Number.MAX_SAFE_INTEGER
        : value + amount;
}

function addSuppressedCounts(...counts: readonly number[]) {
    let total = 0;
    for (const count of counts) {
        total = Math.min(SERVER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT, total + count);
    }
    return total;
}

function nextFallbackEventIdCounter() {
    fallbackEventIdCounter = (fallbackEventIdCounter + 1) >>> 0;
    return fallbackEventIdCounter;
}

const createFallbackEventId = () => createDiagnosticFallbackEventId(nextFallbackEventIdCounter);

function buildServerDiagnosticRecord(
    input: CaptureFailureInput,
    eventId: DiagnosticEventId,
    occurredAt: number,
    stackPolicyOverride?: DiagnosticStackPolicy,
) {
    return buildDiagnosticRecord(input, eventId, occurredAt, {
        fallbackCode: 'UNCLASSIFIED_MAIN_ERROR',
        fallbackOperation: 'main-error',
        internalFrameSuffixes: SERVER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES,
        runtime: SERVER_DIAGNOSTICS_RUNTIME,
        stackPolicyOverride,
    });
}

function createHealthState(mode: TServerDiagnosticsMode): IHealthState {
    return {
        mode,
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

function serializeHealthState(state: IHealthState): IServerDiagnosticsHealthSnapshot {
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

function readStatusCode(value: unknown): number | undefined {
    if (typeof value !== 'object' || value === null) {
        return undefined;
    }
    try {
        const statusCode = (value as {readonly statusCode?: unknown}).statusCode;
        return typeof statusCode === 'number'
            && Number.isSafeInteger(statusCode)
            ? statusCode
            : undefined;
    } catch {
        return undefined;
    }
}

function isExpectedHttpOutcome(value: unknown) {
    const statusCode = readStatusCode(value);
    return statusCode !== undefined && statusCode >= 100 && statusCode < 500;
}

function readCauseObject(input: CaptureFailureInput): object | undefined {
    try {
        const cause = input.local.cause;
        return typeof cause === 'object' && cause !== null
            || typeof cause === 'function'
            ? cause
            : undefined;
    } catch {
        return undefined;
    }
}

function readObjection(event: H3Event | undefined) {
    if (event === undefined) {
        return false;
    }
    try {
        return hasDiagnosticsServerObjection(event);
    } catch {
        // An unavailable objection reader must fail closed.
        return true;
    }
}

function safeLocalSink(
    localSink: ((detail: LocalFailureDetail) => void) | undefined,
    input: CaptureFailureInput,
) {
    if (localSink === undefined) {
        return;
    }
    try {
        localSink(input.local);
    } catch {
        // Local diagnostics must not change the server response or reporter path.
    }
}

export function createServerFailureReporter(
    options: IServerFailureReporterOptions = {},
): IServerFailureReporter {
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const burstLimit = normalizePositiveInteger(
        options.burstLimit,
        SERVER_DIAGNOSTICS_DEFAULT_BURST_LIMIT,
    );
    const burstWindowMs = normalizePositiveInteger(
        options.burstWindowMs,
        SERVER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS,
    );
    const recentIdWindowMs = normalizePositiveInteger(
        options.recentIdWindowMs,
        SERVER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS,
    );
    const transport: IServerDiagnosticsTransport = options.transport
        ?? options.adapter
        ?? createSentryNitroAdapter();
    const health = createHealthState(readTransportReady(transport) ? 'enabled' : 'disabled');
    const recentIds = new Map<DiagnosticEventId, number>();
    const burstStates = new Map<string, IBurstState>();
    const ownedFailures = new WeakMap<object, FailureReceipt>();

    function setDropReason(reason: TServerDiagnosticsDropReason) {
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
        while (recentIds.size > SERVER_DIAGNOSTICS_MAX_RECENT_IDS) {
            const oldestEventId = recentIds.keys().next().value;
            if (oldestEventId === undefined) {
                break;
            }
            recentIds.delete(oldestEventId);
        }
    }

    function pruneBurstStates() {
        while (burstStates.size > SERVER_DIAGNOSTICS_MAX_BURST_KEYS) {
            const oldestKey = burstStates.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            burstStates.delete(oldestKey);
        }
    }

    function readLiveTransportReady() {
        return readTransportReady(transport);
    }

    function sendToTransport(record: DiagnosticRecord, suppressedCount: number): unknown {
        try {
            const sender = transport.send ?? transport.capture;
            if (sender === undefined) {
                return false;
            }
            return suppressedCount > 0
                ? sender(record, suppressedCount)
                : sender(record);
        } catch {
            return false;
        }
    }

    function reportTransportFailure() {
        health.transportFailed = increment(health.transportFailed);
        setDropReason('transport-failed');
    }

    function reportTransportResult(result: unknown) {
        try {
            if (
                result === null
                || (typeof result !== 'object' && typeof result !== 'function')
                || typeof (result as {readonly then?: unknown}).then !== 'function'
            ) {
                if (result === false) {
                    reportTransportFailure();
                } else {
                    health.accepted = increment(health.accepted);
                }
                return;
            }
            void Promise.resolve<unknown>(result).then(
                resolved => {
                    if (resolved === false) {
                        reportTransportFailure();
                    } else {
                        health.accepted = increment(health.accepted);
                    }
                },
                () => {
                    reportTransportFailure();
                },
            );
        } catch {
            reportTransportFailure();
        }
    }

    const decideBurst = createDiagnosticBurstDecider({
        burstStates,
        burstLimit,
        burstWindowMs,
        maxSuppressedCount: SERVER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
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

    function processRecord(
        record: DiagnosticRecord,
        inheritedSuppressedCount: number,
        objecting: boolean,
    ): IProcessResult {
        const receipt = createDiagnosticFailureReceipt(record);
        health.attempted = increment(health.attempted);

        // The objection check runs before recent-ID or burst admission.
        if (objecting || !readLiveTransportReady()) {
            health.policyDropped = increment(health.policyDropped);
            setDropReason('policy-dropped');
            return {
                policyDropped: true,
                receipt,
            };
        }

        const currentTime = safeDiagnosticNow(now);
        pruneRecentIds(currentTime);
        if (recentIds.has(record.eventId)) {
            health.duplicate = increment(health.duplicate);
            setDropReason('duplicate');
            return {
                policyDropped: false,
                receipt,
            };
        }

        const decision = decideBurst(record, currentTime, inheritedSuppressedCount);
        if (!decision.send) {
            return {
                policyDropped: false,
                receipt,
            };
        }

        const suppressedCount = addSuppressedCounts(
            decision.suppressedCount,
            inheritedSuppressedCount,
        );
        reserveAdmission(record, currentTime, decision);
        reportTransportResult(sendToTransport(record, suppressedCount));
        return {
            policyDropped: false,
            receipt,
        };
    }

    const createSchemaDroppedReceipt = createDiagnosticSchemaDroppedReceiptFactory(
        () => buildServerDiagnosticRecord(
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

    function captureInput(
        input: CaptureFailureInput,
        event: H3Event | undefined,
        stackPolicyOverride?: DiagnosticStackPolicy,
    ): FailureReceipt {
        const objecting = readObjection(event);
        const causeObject = readCauseObject(input);
        if (!objecting && causeObject !== undefined) {
            const existingReceipt = ownedFailures.get(causeObject);
            if (existingReceipt !== undefined) {
                return existingReceipt;
            }
        }

        safeLocalSink(options.localSink, input);
        let record: DiagnosticRecord;
        try {
            record = buildServerDiagnosticRecord(
                input,
                createSafeDiagnosticEventId(createEventId, createFallbackEventId),
                safeDiagnosticNow(now),
                stackPolicyOverride,
            );
        } catch {
            record = buildServerDiagnosticRecord(
                {} as CaptureFailureInput,
                createFallbackEventId(),
                safeDiagnosticNow(now),
                stackPolicyOverride,
            );
        }

        const result = processRecord(record, 0, objecting);
        if (!result.policyDropped && causeObject !== undefined) {
            ownedFailures.set(causeObject, result.receipt);
        }
        return result.receipt;
    }

    const reporter: IServerFailureReporter = {
        capture: (input, event) => {
            try {
                return captureInput(input, event);
            } catch {
                return captureInput({
                    code: 'UNCLASSIFIED_MAIN_ERROR',
                    context: {},
                    local: {
                        source: 'nitro-failure-reporter',
                        message: 'Unhandled Nitro server failure',
                    },
                }, event);
            }
        },
        captureUncaught: (error, event) => {
            if (isExpectedHttpOutcome(error)) {
                return undefined;
            }
            return captureInput({
                code: 'UNCLASSIFIED_MAIN_ERROR',
                context: {},
                local: {
                    source: 'nitro-error-hook',
                    message: 'Unhandled Nitro server error',
                    cause: error,
                },
            }, event, 'source');
        },
        captureRecord: (value, inheritedSuppressedCount, event) => {
            try {
                const record = decodeDiagnosticRecord(value);
                const decodedSuppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
                if (
                    record !== null
                    && record.runtime === SERVER_DIAGNOSTICS_RUNTIME
                    && decodedSuppressedCount !== null
                ) {
                    return processRecord(record, decodedSuppressedCount, readObjection(event)).receipt;
                }
                if (record !== null) {
                    return createSchemaDroppedReceipt(record);
                }
            } catch {
                // A malformed external record is counted below and never crosses transport.
            }

            return createSchemaDroppedReceipt(null);
        },
        getHealthSnapshot: () => serializeHealthState(health),
        isTransportReady: readLiveTransportReady,
    };

    return reporter;
}

export const createViewerNitroFailureReporter = createServerFailureReporter;

export function initializeServerFailureReporter(
    options: IServerFailureReporterOptions = {},
) {
    if (serverFailureReporter) {
        return serverFailureReporter;
    }
    serverFailureReporter = createServerFailureReporter(options);
    return serverFailureReporter;
}

export function getServerFailureReporter() {
    return serverFailureReporter;
}

export function captureServerFailure<C extends DiagnosticCode>(
    input: CaptureFailureInput<C>,
    event?: H3Event,
) {
    return serverFailureReporter?.capture(input, event);
}

function readTransportReady(transport: IServerDiagnosticsTransport) {
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
