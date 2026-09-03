import * as Sentry from '@sentry/node';
import type {Transport} from '@sentry/core';
import {
    assertSentryBuildIdentity,
    type SentryBuildIdentity,
} from '@contracts/diagnostics/releaseIdentity.js';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
    type CanonicalAppFrame,
} from '@contracts/diagnostics/diagnosticRecord';
import {DIAGNOSTIC_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import {decodeDiagnosticsSuppressedCount} from '@contracts/diagnostics/diagnosticsCapability';
import {getRuntimeEnv} from '@server/utils/getRuntimeEnv';

export const SENTRY_NITRO_POLICY_GATE_ENV_KEYS = Object.freeze({
    enabled: 'EVB_SENTRY_NITRO_ENABLED',
    legitimateInterestsApproved: 'EVB_SENTRY_NITRO_LIA_APPROVED',
    legalNoticePublished: 'EVB_SENTRY_NITRO_NOTICE_PUBLISHED',
    dpaExecuted: 'EVB_SENTRY_NITRO_DPA_EXECUTED',
    accountHardened: 'EVB_SENTRY_NITRO_ACCOUNT_HARDENED',
    retentionReady: 'EVB_SENTRY_NITRO_RETENTION_READY',
    objectionReady: 'EVB_SENTRY_NITRO_OBJECTION_READY',
});

export interface ISentryNitroPolicyGates {
    readonly enabled: boolean;
    readonly legitimateInterestsApproved: boolean;
    readonly legalNoticePublished: boolean;
    readonly dpaExecuted: boolean;
    readonly accountHardened: boolean;
    readonly retentionReady: boolean;
    readonly objectionReady: boolean;
}

export interface ISentryNitroConfigurationSnapshot {
    readonly ready: boolean;
    readonly hasDsn: boolean;
    readonly identity: SentryBuildIdentity | null;
    readonly policy: ISentryNitroPolicyGates;
}

export interface ISentryNitroRuntimeConfig {readonly sentry?: {
    readonly nitroDsn?: unknown;
    readonly release?: unknown;
    readonly dist?: unknown;
    readonly environment?: unknown;
};}

export interface ISentryNitroClient {
    captureEvent: (
        event: Sentry.Event,
        hint?: Sentry.EventHint,
        currentScope?: Sentry.Scope,
    ) => string | undefined;
    close?: (timeout?: number) => PromiseLike<boolean>;
}

export type TSentryNitroClientFactory = (options: Sentry.NodeOptions) => ISentryNitroClient | undefined;

export interface ISentryNitroAdapterOptions {
    readonly runtimeConfig?: unknown;
    readonly environment?: Record<string, string | undefined>;
    readonly policy?: Partial<ISentryNitroPolicyGates>;
    readonly clientFactory?: TSentryNitroClientFactory;
}

export interface ISentryNitroAdapter {
    readonly isReady: () => boolean;
    readonly send: (record: DiagnosticRecord, suppressedCount?: number) => string | false;
    readonly sanitizeEvent: (event: unknown) => Sentry.ErrorEvent | null;
    readonly getConfiguration: () => ISentryNitroConfigurationSnapshot;
    readonly dispose: () => void;
}

const SENTRY_NITRO_RUNTIME = 'viewer-nitro' as const;
const SENTRY_NITRO_MARKER_KEY = '__evb_diagnostic_record';
const SENTRY_NITRO_SUPPRESSED_COUNT_KEY = '__evb_diagnostic_suppressed_count';
const SENTRY_NITRO_DIAGNOSTICS_CONTEXT_KEY = 'diagnostics';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    try {
        const prototype = Reflect.getPrototypeOf(value);
        return prototype === Object.prototype || prototype === null;
    } catch {
        return false;
    }
}

function readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

// Nitro injects this auto-import into the server bundle. Keep the standalone
// server project typecheck independent of generated Nitro declarations.
declare function useRuntimeConfig(): unknown;

function readRuntimeConfig(): unknown {
    try {
        return useRuntimeConfig();
    } catch {
        return {};
    }
}

function readSentryRuntimeConfig(value: unknown): Record<string, unknown> {
    if (!isPlainRecord(value) || !isPlainRecord(value.sentry)) {
        return {};
    }
    return value.sentry;
}

function isTruthyGate(value: unknown): boolean {
    return value === '1';
}

function resolvePolicy(
    environment: Record<string, string | undefined>,
    configured: Partial<ISentryNitroPolicyGates> | undefined,
): ISentryNitroPolicyGates {
    const resolveGate = (
        key: keyof ISentryNitroPolicyGates,
        environmentKey: string,
    ) => Object.hasOwn(configured ?? {}, key)
        ? configured?.[key] === true
        : isTruthyGate(environment[environmentKey]);

    return Object.freeze({
        enabled: resolveGate('enabled', SENTRY_NITRO_POLICY_GATE_ENV_KEYS.enabled),
        legitimateInterestsApproved: resolveGate(
            'legitimateInterestsApproved',
            SENTRY_NITRO_POLICY_GATE_ENV_KEYS.legitimateInterestsApproved,
        ),
        legalNoticePublished: resolveGate(
            'legalNoticePublished',
            SENTRY_NITRO_POLICY_GATE_ENV_KEYS.legalNoticePublished,
        ),
        dpaExecuted: resolveGate('dpaExecuted', SENTRY_NITRO_POLICY_GATE_ENV_KEYS.dpaExecuted),
        accountHardened: resolveGate('accountHardened', SENTRY_NITRO_POLICY_GATE_ENV_KEYS.accountHardened),
        retentionReady: resolveGate('retentionReady', SENTRY_NITRO_POLICY_GATE_ENV_KEYS.retentionReady),
        objectionReady: resolveGate('objectionReady', SENTRY_NITRO_POLICY_GATE_ENV_KEYS.objectionReady),
    });
}

function isValidSentryDsn(value: string): boolean {
    if (!value) {
        return false;
    }
    try {
        const parsed = new URL(value);
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const projectId = pathSegments.at(-1);
        return parsed.protocol === 'https:'
            && parsed.username.length > 0
            && parsed.password.length === 0
            && (parsed.hostname === 'sentry.io' || parsed.hostname.endsWith('.sentry.io'))
            && parsed.search.length === 0
            && parsed.hash.length === 0
            && projectId !== undefined
            && /^\d+$/u.test(projectId);
    } catch {
        return false;
    }
}

function allPolicyGatesApproved(policy: ISentryNitroPolicyGates): boolean {
    return Object.values(policy).every(value => value === true);
}

function resolveIdentity(
    runtimeConfig: Record<string, unknown>,
    environment: Record<string, string | undefined>,
): SentryBuildIdentity | null {
    const release = readString(runtimeConfig.release) || readString(environment.EVB_SENTRY_RELEASE);
    const dist = readString(runtimeConfig.dist) || readString(environment.EVB_SENTRY_DIST);
    const sentryEnvironment = readString(runtimeConfig.environment)
        || readString(environment.EVB_SENTRY_ENVIRONMENT);
    if (!release || !dist || !sentryEnvironment) {
        return null;
    }

    try {
        return assertSentryBuildIdentity({
            target: 'web',
            release,
            dist,
            environment: sentryEnvironment,
        });
    } catch {
        return null;
    }
}

interface IResolvedSentryNitroConfiguration {
    readonly dsn: string;
    readonly identity: SentryBuildIdentity | null;
    readonly policy: ISentryNitroPolicyGates;
    readonly snapshot: ISentryNitroConfigurationSnapshot;
}

function resolveConfiguration(options: ISentryNitroAdapterOptions): IResolvedSentryNitroConfiguration {
    const environment = options.environment ?? getRuntimeEnv();
    const runtimeConfig = readSentryRuntimeConfig(options.runtimeConfig ?? readRuntimeConfig());
    const dsn = readString(runtimeConfig.nitroDsn) || readString(environment.SENTRY_NITRO_DSN);
    const identity = resolveIdentity(runtimeConfig, environment);
    const policy = resolvePolicy(environment, options.policy);
    const ready = isValidSentryDsn(dsn)
        && identity !== null
        && allPolicyGatesApproved(policy);

    return {
        dsn,
        identity,
        policy,
        snapshot: Object.freeze({
            ready,
            hasDsn: isValidSentryDsn(dsn),
            identity,
            policy,
        }),
    };
}

export function resolveSentryNitroConfiguration(
    options: Omit<ISentryNitroAdapterOptions, 'clientFactory'> = {},
): ISentryNitroConfigurationSnapshot {
    return resolveConfiguration(options).snapshot;
}

function toSentryStackFrame(frame: CanonicalAppFrame): Sentry.StackFrame {
    return {
        filename: frame.module,
        ...(frame.function === undefined ? {} : {function: frame.function}),
        ...(frame.line === undefined ? {} : {lineno: frame.line}),
        ...(frame.column === undefined ? {} : {colno: frame.column}),
        in_app: true,
    };
}

function buildDiagnosticContext(record: DiagnosticRecord, suppressedCount: number) {
    const context: Record<string, string | number | boolean> = {
        schemaVersion: record.schemaVersion,
        code: record.code,
        runtime: record.runtime,
    };
    if (record.operation !== undefined) {
        context.operation = record.operation;
    }
    for (const [
        key,
        value,
    ] of Object.entries(record.context)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            context[key] = value;
        }
    }
    if (suppressedCount > 0) {
        context.suppressedCount = suppressedCount;
    }
    return context;
}

function buildSentryEventInternal(
    record: DiagnosticRecord,
    identity: SentryBuildIdentity,
    suppressedCount = 0,
    includeMarker = true,
): Sentry.Event {
    const definition = DIAGNOSTIC_DEFINITIONS[record.code];
    const boundedSuppressedCount = decodeDiagnosticsSuppressedCount(suppressedCount) ?? 0;
    const event: Sentry.Event = {
        event_id: record.eventId,
        timestamp: Math.floor(record.occurredAt / 1_000),
        level: record.severity,
        platform: 'node',
        release: identity.release,
        dist: identity.dist,
        environment: identity.environment,
        tags: {
            runtime: record.runtime,
            code: record.code,
            ...(record.operation === undefined ? {} : {operation: record.operation}),
        },
        contexts: {[SENTRY_NITRO_DIAGNOSTICS_CONTEXT_KEY]: buildDiagnosticContext(
            record,
            boundedSuppressedCount,
        )},
        exception: {values: [{
            type: definition.exceptionType,
            value: definition.exceptionValue,
            ...(record.frames.length === 0
                ? {}
                : {stacktrace: {frames: record.frames.map(toSentryStackFrame)}}),
        }]},
    };
    if (includeMarker) {
        event.extra = {
            [SENTRY_NITRO_MARKER_KEY]: record,
            ...(boundedSuppressedCount === 0
                ? {}
                : {[SENTRY_NITRO_SUPPRESSED_COUNT_KEY]: boundedSuppressedCount}),
        };
    }
    return event;
}

export function buildSentryEvent(
    record: DiagnosticRecord,
    identity: SentryBuildIdentity,
    suppressedCount = 0,
): Sentry.Event {
    return buildSentryEventInternal(record, identity, suppressedCount);
}

function readMarkedRecord(event: unknown): {
    readonly record: DiagnosticRecord;
    readonly suppressedCount: number;
} | null {
    if (!isPlainRecord(event) || !isPlainRecord(event.extra)) {
        return null;
    }
    const record = decodeDiagnosticRecord(event.extra[SENTRY_NITRO_MARKER_KEY]);
    if (record === null || record.runtime !== SENTRY_NITRO_RUNTIME) {
        return null;
    }
    const suppressedCount = decodeDiagnosticsSuppressedCount(
        event.extra[SENTRY_NITRO_SUPPRESSED_COUNT_KEY],
    );
    return suppressedCount === null ? null : {
        record,
        suppressedCount,
    };
}

export function sanitizeSentryEvent(
    event: unknown,
    identity: SentryBuildIdentity,
): Sentry.ErrorEvent | null {
    try {
        assertSentryBuildIdentity(identity);
    } catch {
        return null;
    }
    const marked = readMarkedRecord(event);
    if (marked === null) {
        return null;
    }
    return buildSentryEventInternal(
        marked.record,
        identity,
        marked.suppressedCount,
        false,
    ) as Sentry.ErrorEvent;
}

function createNonPersistingTransport(accepting: () => boolean) {
    return (transportOptions: Parameters<typeof Sentry.makeNodeTransport>[0]): Transport => {
        const delegate = Sentry.makeNodeTransport(transportOptions);
        return {
            send: request => accepting()
                ? delegate.send(request)
                : Promise.resolve({}),
            flush: timeout => accepting()
                ? delegate.flush(timeout)
                : Promise.resolve(true),
        };
    };
}

function createClientOptions(
    dsn: string,
    identity: SentryBuildIdentity,
    accepting: () => boolean,
): Sentry.NodeOptions {
    return {
        dsn,
        release: identity.release,
        dist: identity.dist,
        environment: identity.environment,
        defaultIntegrations: false,
        integrations: [],
        stackParser: Sentry.defaultStackParser,
        transport: createNonPersistingTransport(accepting),
        transportOptions: {bufferSize: 16},
        skipOpenTelemetrySetup: true,
        sendClientReports: false,
        sendDefaultPii: false,
        includeServerName: false,
        includeLocalVariables: false,
        registerEsmLoaderHooks: false,
        disableInstrumentationWarnings: true,
        attachStacktrace: false,
        maxBreadcrumbs: 0,
        beforeBreadcrumb: () => null,
        sampleRate: 1,
        tracePropagationTargets: [],
        propagateTraceparent: false,
        streamGenAiSpans: false,
        enableLogs: false,
        enableMetrics: false,
        profilesSampleRate: 0,
        profileSessionSampleRate: 0,
        initialScope: {},
        dataCollection: {
            userInfo: false,
            cookies: false,
            httpHeaders: {
                request: false,
                response: false,
            },
            httpBodies: [],
            queryParams: false,
            urlQueryParams: false,
            graphQL: {
                document: false,
                variables: false,
            },
            genAI: {
                inputs: false,
                outputs: false,
            },
            databaseQueryData: false,
            stackFrameVariables: false,
            frameContextLines: 0,
        },
        beforeSend: event => accepting()
            ? sanitizeSentryEvent(event, identity)
            : null,
    };
}

const defaultClientFactory: TSentryNitroClientFactory = options => (
    Sentry.initWithoutDefaultIntegrations(options)
);

export function createSentryNitroAdapter(
    options: ISentryNitroAdapterOptions = {},
): ISentryNitroAdapter {
    const resolved = resolveConfiguration(options);
    const clientFactory = options.clientFactory ?? defaultClientFactory;
    let accepting = true;
    let disposed = false;
    let client: ISentryNitroClient | null = null;

    if (resolved.snapshot.ready && resolved.identity !== null) {
        try {
            client = clientFactory(createClientOptions(resolved.dsn, resolved.identity, () => accepting)) ?? null;
        } catch {
            client = null;
        }
    }

    const adapter: ISentryNitroAdapter = {
        isReady: () => !disposed && resolved.snapshot.ready && client !== null,
        send: (record, suppressedCount) => {
            if (disposed || !resolved.snapshot.ready || resolved.identity === null || client === null) {
                return false;
            }
            const decodedRecord = decodeDiagnosticRecord(record);
            const boundedSuppressedCount = decodeDiagnosticsSuppressedCount(suppressedCount);
            if (decodedRecord === null
                || decodedRecord.runtime !== SENTRY_NITRO_RUNTIME
                || boundedSuppressedCount === null) {
                return false;
            }
            try {
                const event = buildSentryEvent(
                    decodedRecord,
                    resolved.identity,
                    boundedSuppressedCount,
                );
                const eventId = client.captureEvent(
                    event,
                    {event_id: decodedRecord.eventId},
                    new Sentry.Scope(),
                );
                return eventId ?? decodedRecord.eventId;
            } catch {
                return false;
            }
        },
        sanitizeEvent: event => resolved.identity === null
            ? null
            : sanitizeSentryEvent(event, resolved.identity),
        getConfiguration: () => resolved.snapshot,
        dispose: () => {
            if (disposed) {
                return;
            }
            accepting = false;
            disposed = true;
            const clientToClose = client;
            client = null;
            if (clientToClose?.close) {
                void Promise.resolve(clientToClose.close(0)).catch(() => undefined);
            }
        },
    };

    return adapter;
}
