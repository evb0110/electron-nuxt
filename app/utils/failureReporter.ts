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
    LocalFailureDetail,
} from '@contracts/diagnostics/failureReceipt';
import {
    normalizeCanonicalApplicationFrames,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/canonicalAppFrames';

export type TRendererDiagnosticsHost = 'electron' | 'hosted-browser';
export type TRendererDiagnosticsPreference = 'unknown' | 'granted' | 'denied';

export type TRendererDiagnosticsDropReason =
    | 'owned-projection'
    | 'policy-dropped'
    | 'duplicate'
    | 'burst-suppressed'
    | 'schema-dropped'
    | 'frameless-dropped'
    | 'transport-failed';

export interface IRendererDiagnosticsHealthSnapshot {
    mode: TRendererDiagnosticsPreference;
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
    lastDropReason: TRendererDiagnosticsDropReason | null;
}

/** The only Electron boundary this reporter knows. Preload wiring belongs to SEN-CORE-09. */
export type TRendererDiagnosticSender = (record: DiagnosticRecord, suppressedCount?: number) => unknown;

export interface IHostedDiagnosticsTransport {send: (record: DiagnosticRecord, suppressedCount?: number) => unknown;}

export interface IRendererFailureReporterOptions {
    host?: TRendererDiagnosticsHost;
    now?: () => number;
    createEventId?: () => DiagnosticEventId;
    burstLimit?: number;
    burstWindowMs?: number;
    recentIdWindowMs?: number;
    electronSender?: TRendererDiagnosticSender;
    readHostedPreference?: () => unknown;
    loadHostedTransport?: () => IHostedDiagnosticsTransport | Promise<IHostedDiagnosticsTransport>;
    localSink?: (detail: LocalFailureDetail, receipt: FailureReceipt) => void;
    rawWarningSink?: (message: string) => void;
}

export interface IRendererFailureReporter {
    capture<C extends DiagnosticCode>(input: CaptureFailureInput<C>): FailureReceipt;
    captureRecord(value: unknown): FailureReceipt;
    getHealthSnapshot(): IRendererDiagnosticsHealthSnapshot;
    withSuppressedCapture<T>(callback: () => T): T;
}

export const RENDERER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT = 10_000;
export const RENDERER_DIAGNOSTICS_DEFAULT_BURST_LIMIT = 20;
export const RENDERER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS = 60_000;
export const RENDERER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS = 10 * 60_000;

const RENDERER_DIAGNOSTICS_MAX_RECENT_IDS = 4_096;
const RENDERER_DIAGNOSTICS_MAX_BURST_KEYS = 1_024;
const RENDERER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES = ['app/utils/failureReporter.ts'] as const;
const MAX_TRANSPORT_WARNING_LENGTH = 512;

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

interface IHealthState extends IRendererDiagnosticsHealthSnapshot {}

let fallbackEventIdCounter = 0;

function normalizePreference(value: unknown): TRendererDiagnosticsPreference {
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
        // Keep the fallback receipt valid even if the system clock is unavailable.
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
    return frames.filter(frame => !RENDERER_DIAGNOSTICS_INTERNAL_FRAME_SUFFIXES.some(suffix => (
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
    runtime: DiagnosticRuntime,
    eventId: DiagnosticEventId,
    occurredAt: number,
): DiagnosticRecord {
    let code: DiagnosticCode = 'UNCLASSIFIED_RENDERER_ERROR';
    let severity: FailureSeverity = DIAGNOSTIC_DEFINITIONS.UNCLASSIFIED_RENDERER_ERROR.defaultSeverity;
    let operation: DiagnosticOperation = DIAGNOSTIC_DEFINITIONS.UNCLASSIFIED_RENDERER_ERROR.operation;
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
        // A reporter failure must reduce to the closed fallback record below.
    }

    const decoded = decodeDiagnosticRecord({
        schemaVersion: 1,
        eventId,
        code,
        severity,
        runtime,
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
        code: 'UNCLASSIFIED_RENDERER_ERROR',
        severity: 'error',
        runtime,
        operation: 'renderer-error',
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

function createHealthState(): IHealthState {
    return {
        mode: 'unknown',
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

function serializeHealthState(state: IHealthState): IRendererDiagnosticsHealthSnapshot {
    return Object.freeze({...state});
}

function resolveRuntime(host: TRendererDiagnosticsHost): DiagnosticRuntime {
    return host === 'electron' ? 'electron-renderer' : 'hosted-browser';
}

export function createRendererFailureReporter(
    options: IRendererFailureReporterOptions = {},
): IRendererFailureReporter {
    const host = options.host ?? 'hosted-browser';
    const now = options.now ?? Date.now;
    const createEventId = options.createEventId ?? createDiagnosticEventId;
    const burstLimit = normalizePositiveInteger(
        options.burstLimit,
        RENDERER_DIAGNOSTICS_DEFAULT_BURST_LIMIT,
    );
    const burstWindowMs = normalizePositiveInteger(
        options.burstWindowMs,
        RENDERER_DIAGNOSTICS_DEFAULT_BURST_WINDOW_MS,
    );
    const recentIdWindowMs = normalizePositiveInteger(
        options.recentIdWindowMs,
        RENDERER_DIAGNOSTICS_DEFAULT_RECENT_ID_WINDOW_MS,
    );
    const health = createHealthState();
    const recentIds = new Map<DiagnosticEventId, number>();
    const burstStates = new Map<string, IBurstState>();
    let hostedTransportLoad: Promise<IHostedDiagnosticsTransport> | null = null;
    let suppressionDepth = 0;
    let warningInProgress = false;

    function setDropReason(reason: TRendererDiagnosticsDropReason) {
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
        while (recentIds.size > RENDERER_DIAGNOSTICS_MAX_RECENT_IDS) {
            const oldestEventId = recentIds.keys().next().value;
            if (oldestEventId === undefined) {
                break;
            }
            recentIds.delete(oldestEventId);
        }
    }

    function pruneBurstStates() {
        while (burstStates.size > RENDERER_DIAGNOSTICS_MAX_BURST_KEYS) {
            const oldestKey = burstStates.keys().next().value;
            if (oldestKey === undefined) {
                break;
            }
            burstStates.delete(oldestKey);
        }
    }

    function writeRawTransportWarning(record: DiagnosticRecord) {
        if (warningInProgress || !options.rawWarningSink) {
            return;
        }
        warningInProgress = true;
        try {
            const message = `Diagnostics transport failed for ${record.code} (${record.eventId})`;
            options.rawWarningSink(message.slice(0, MAX_TRANSPORT_WARNING_LENGTH));
        } catch {
            // The raw sink is intentionally unobserved. It must not become another occurrence.
        } finally {
            warningInProgress = false;
        }
    }

    function recordLocalDetail(detail: LocalFailureDetail, receipt: FailureReceipt) {
        try {
            options.localSink?.(detail, receipt);
        } catch {
            // Local logging cannot break the originating failure owner.
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
                    RENDERER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
                ),
            };
        }

        if (previous.sentCount >= burstLimit) {
            previous.suppressedCount = Math.min(
                RENDERER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
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

    function reportTransportFailure(record: DiagnosticRecord) {
        health.transportFailed = increment(health.transportFailed);
        setDropReason('transport-failed');
        writeRawTransportWarning(record);
    }

    function reportTransportResult(result: unknown, record: DiagnosticRecord) {
        try {
            if (
                result === null
                || (typeof result !== 'object' && typeof result !== 'function')
                || typeof (result as {then?: unknown}).then !== 'function'
            ) {
                if (result === false) {
                    reportTransportFailure(record);
                }
                return;
            }
            const pending: Promise<unknown> = Promise.resolve(result);
            void pending.then(
                resolved => {
                    if (resolved === false) {
                        reportTransportFailure(record);
                    }
                },
                () => reportTransportFailure(record),
            );
        } catch {
            reportTransportFailure(record);
        }
    }

    function sendElectronRecord(record: DiagnosticRecord, suppressedCount: number) {
        try {
            if (!options.electronSender) {
                return false;
            }
            const result = suppressedCount > 0
                ? options.electronSender(record, suppressedCount)
                : options.electronSender(record);
            reportTransportResult(result, record);
            return true;
        } catch {
            return false;
        }
    }

    function sendHostedRecord(
        record: DiagnosticRecord,
        suppressedCount: number,
    ) {
        if (hostedTransportLoad === null) {
            try {
                const loaded = options.loadHostedTransport?.();
                if (!loaded) {
                    reportTransportFailure(record);
                    return;
                }
                hostedTransportLoad = Promise.resolve(loaded);
            } catch {
                reportTransportFailure(record);
                return;
            }
        }

        const transportLoad = hostedTransportLoad;
        void transportLoad.then((transport) => {
            try {
                const result = suppressedCount > 0
                    ? transport.send(record, suppressedCount)
                    : transport.send(record);
                reportTransportResult(result, record);
            } catch {
                reportTransportFailure(record);
            }
        }, () => {
            if (hostedTransportLoad === transportLoad) {
                hostedTransportLoad = null;
            }
            reportTransportFailure(record);
        });
    }

    function processRecord(record: DiagnosticRecord, detail: LocalFailureDetail): FailureReceipt {
        const receipt = createReceipt(record);
        if (suppressionDepth > 0) {
            health.ownedProjection = increment(health.ownedProjection);
            setDropReason('owned-projection');
            return receipt;
        }

        health.attempted = increment(health.attempted);
        recordLocalDetail(detail, receipt);

        const currentTime = safeNow(now);
        pruneRecentIds(currentTime);
        if (recentIds.has(record.eventId)) {
            health.duplicate = increment(health.duplicate);
            setDropReason('duplicate');
            return receipt;
        }

        if (host === 'hosted-browser') {
            health.mode = normalizePreference(options.readHostedPreference?.());
            if (health.mode !== 'granted') {
                health.policyDropped = increment(health.policyDropped);
                setDropReason('policy-dropped');
                return receipt;
            }
        }

        const decision = decideBurst(record, currentTime);
        if (!decision.send) {
            return receipt;
        }

        if (host === 'electron') {
            markAccepted(record, currentTime, decision);
            if (!sendElectronRecord(record, decision.suppressedCount)) {
                reportTransportFailure(record);
                return receipt;
            }
            return receipt;
        }

        markAccepted(record, currentTime, decision);
        sendHostedRecord(record, decision.suppressedCount);
        return receipt;
    }

    return {
        capture: <C extends DiagnosticCode>(input: CaptureFailureInput<C>) => {
            try {
                const record = buildClosedRecord(
                    input,
                    resolveRuntime(host),
                    createSafeEventId(createEventId),
                    safeNow(now),
                );
                return processRecord(record, input.local);
            } catch {
                const record = buildClosedRecord(
                    {} as CaptureFailureInput,
                    resolveRuntime(host),
                    createFallbackEventId(),
                    safeNow(now),
                );
                return processRecord(record, {
                    source: 'failure-reporter',
                    message: 'Renderer failure reporter fallback',
                });
            }
        },
        captureRecord: (value) => {
            try {
                const record = decodeDiagnosticRecord(value);
                if (record !== null && record.runtime === resolveRuntime(host)) {
                    return processRecord(record, {
                        source: 'failure-reporter',
                        message: 'Captured closed renderer record',
                    });
                }
            } catch {
                // Malformed external input is counted below and never reaches a transport.
            }

            health.attempted = increment(health.attempted);
            health.schemaDropped = increment(health.schemaDropped);
            setDropReason('schema-dropped');
            const record = buildClosedRecord(
                {} as CaptureFailureInput,
                resolveRuntime(host),
                createSafeEventId(createEventId),
                safeNow(now),
            );
            return createReceipt(record);
        },
        getHealthSnapshot: () => serializeHealthState(health),
        withSuppressedCapture: <T>(callback: () => T) => {
            suppressionDepth = increment(suppressionDepth);
            try {
                return callback();
            } finally {
                suppressionDepth = Math.max(0, suppressionDepth - 1);
            }
        },
    };
}
