import * as Sentry from '@sentry/node';
import {
    getFilenameToDebugIdMap,
    type Transport,
} from '@sentry/core';
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
import {buildSentrySourceMapDebugImages} from '@contracts/diagnostics/sentryDebugImages';

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
    readonly runtimeMatchesBuild: boolean;
}

export interface ISentryNitroRuntimeConfig {readonly sentry?: {
    readonly nitroDsn?: unknown;
    readonly release?: unknown;
    readonly dist?: unknown;
    readonly environment?: unknown;
    readonly policy?: unknown;
};}

export interface ISentryNitroBuildConfiguration {
    readonly dsn: string;
    readonly identity: SentryBuildIdentity | null;
    readonly policy: ISentryNitroPolicyGates;
}

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
    /** Test seam for the build constant replaced by Nitro. */
    readonly buildConfiguration?: unknown;
    readonly clientFactory?: TSentryNitroClientFactory;
    readonly resolveFilenameDebugIds?: () => Readonly<Record<string, string>>;
}

export interface ISentryNitroAdapter {
    readonly isReady: () => boolean;
    readonly send: (record: DiagnosticRecord, suppressedCount?: number) => string | false;
    readonly sanitizeEvent: (event: unknown) => Sentry.ErrorEvent | null;
    readonly getConfiguration: () => ISentryNitroConfigurationSnapshot;
    readonly dispose: () => void;
}

const SENTRY_NITRO_RUNTIME = 'viewer-nitro' as const;
const SENTRY_NITRO_SCHEMA_MARKER = 'evb-diagnostic-v1';
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
declare const __EVB_SENTRY_NITRO_BUILD_CONFIGURATION__: unknown;

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

const SENTRY_NITRO_POLICY_KEYS = Object.freeze([
    'enabled',
    'legitimateInterestsApproved',
    'legalNoticePublished',
    'dpaExecuted',
    'accountHardened',
    'retentionReady',
    'objectionReady',
] as const satisfies ReadonlyArray<keyof ISentryNitroPolicyGates>);

const DISABLED_POLICY: ISentryNitroPolicyGates = Object.freeze({
    enabled: false,
    legitimateInterestsApproved: false,
    legalNoticePublished: false,
    dpaExecuted: false,
    accountHardened: false,
    retentionReady: false,
    objectionReady: false,
});

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
    try {
        return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
    } catch {
        return false;
    }
}

function decodePolicy(value: unknown): ISentryNitroPolicyGates | null {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, SENTRY_NITRO_POLICY_KEYS)) {
        return null;
    }
    if (SENTRY_NITRO_POLICY_KEYS.some(key => typeof value[key] !== 'boolean')) {
        return null;
    }
    return Object.freeze({
        enabled: value.enabled === true,
        legitimateInterestsApproved: value.legitimateInterestsApproved === true,
        legalNoticePublished: value.legalNoticePublished === true,
        dpaExecuted: value.dpaExecuted === true,
        accountHardened: value.accountHardened === true,
        retentionReady: value.retentionReady === true,
        objectionReady: value.objectionReady === true,
    });
}

function readBakedBuildConfiguration(): unknown {
    try {
        return __EVB_SENTRY_NITRO_BUILD_CONFIGURATION__;
    } catch {
        return null;
    }
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
            && /(?:^|\.)ingest\.de\.sentry\.io$/u.test(parsed.hostname)
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

function resolveIdentity(runtimeConfig: Record<string, unknown>): SentryBuildIdentity | null {
    const release = readString(runtimeConfig.release);
    const dist = readString(runtimeConfig.dist);
    const sentryEnvironment = readString(runtimeConfig.environment);
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

function decodeBuildConfiguration(value: unknown): ISentryNitroBuildConfiguration | null {
    if (!isPlainRecord(value) || !hasOnlyKeys(value, [
        'dsn',
        'identity',
        'policy',
    ])) {
        return null;
    }
    const policy = decodePolicy(value.policy);
    if (policy === null) {
        return null;
    }
    let identity: SentryBuildIdentity | null = null;
    if (value.identity !== null) {
        try {
            identity = assertSentryBuildIdentity(value.identity);
        } catch {
            return null;
        }
        if (identity.target !== 'web') {
            return null;
        }
    }
    return Object.freeze({
        dsn: readString(value.dsn),
        identity,
        policy,
    });
}

function sameIdentity(left: SentryBuildIdentity | null, right: SentryBuildIdentity | null) {
    return left === null || right === null
        ? left === right
        : left.target === right.target
            && left.release === right.release
            && left.dist === right.dist
            && left.environment === right.environment;
}

function runtimeMatchesBuild(
    runtimeConfig: Record<string, unknown>,
    buildConfiguration: ISentryNitroBuildConfiguration,
) {
    const runtimePolicy = decodePolicy(runtimeConfig.policy);
    const runtimeIdentity = resolveIdentity(runtimeConfig);
    return readString(runtimeConfig.nitroDsn) === buildConfiguration.dsn
        && sameIdentity(runtimeIdentity, buildConfiguration.identity)
        && runtimePolicy !== null
        && SENTRY_NITRO_POLICY_KEYS.every(key => runtimePolicy[key] === buildConfiguration.policy[key]);
}

interface IResolvedSentryNitroConfiguration {
    readonly dsn: string;
    readonly identity: SentryBuildIdentity | null;
    readonly policy: ISentryNitroPolicyGates;
    readonly snapshot: ISentryNitroConfigurationSnapshot;
}

function resolveConfiguration(options: ISentryNitroAdapterOptions): IResolvedSentryNitroConfiguration {
    const runtimeConfig = readSentryRuntimeConfig(options.runtimeConfig ?? readRuntimeConfig());
    const buildConfiguration = decodeBuildConfiguration(
        options.buildConfiguration ?? readBakedBuildConfiguration(),
    );
    const dsn = buildConfiguration?.dsn ?? '';
    const identity = buildConfiguration?.identity ?? null;
    const policy = buildConfiguration?.policy ?? DISABLED_POLICY;
    const matchesBuild = buildConfiguration !== null
        && runtimeMatchesBuild(runtimeConfig, buildConfiguration);
    const ready = isValidSentryDsn(dsn)
        && identity !== null
        && allPolicyGatesApproved(policy)
        && matchesBuild;

    return {
        dsn,
        identity,
        policy,
        snapshot: Object.freeze({
            ready,
            hasDsn: isValidSentryDsn(dsn),
            identity,
            policy,
            runtimeMatchesBuild: matchesBuild,
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

function readNodeMajorVersion() {
    const processValue = (globalThis as {readonly process?: {readonly versions?: {readonly node?: unknown};}}).process;
    const nodeVersion = processValue?.versions?.node;
    const match = typeof nodeVersion === 'string'
        ? nodeVersion.match(/^(\d+)/u)
        : null;
    return match?.[1] ?? 'unknown';
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
    resolveFilenameDebugIds = () => getFilenameToDebugIdMap(Sentry.defaultStackParser),
): Sentry.Event {
    const definition = DIAGNOSTIC_DEFINITIONS[record.code];
    const topFrame = record.frames[0];
    const boundedSuppressedCount = decodeDiagnosticsSuppressedCount(suppressedCount) ?? 0;
    const debugImages = buildSentrySourceMapDebugImages(
        record.frames,
        resolveFilenameDebugIds(),
    );
    const event: Sentry.Event = {
        event_id: record.eventId,
        timestamp: Math.floor(record.occurredAt / 1_000),
        level: record.severity,
        platform: 'javascript',
        release: identity.release,
        dist: identity.dist,
        environment: identity.environment,
        tags: {
            evb_schema: SENTRY_NITRO_SCHEMA_MARKER,
            diagnostic_runtime: record.runtime,
            diagnostic_code: record.code,
            ...(record.operation === undefined ? {} : {diagnostic_operation: record.operation}),
        },
        fingerprint: [
            record.runtime,
            record.code,
            topFrame?.module ?? 'no-application-frame',
        ],
        contexts: {
            [SENTRY_NITRO_DIAGNOSTICS_CONTEXT_KEY]: buildDiagnosticContext(
                record,
                boundedSuppressedCount,
            ),
            runtime: {
                name: 'node',
                version: readNodeMajorVersion(),
            },
        },
        exception: {values: [{
            type: definition.exceptionType,
            value: definition.exceptionValue,
            ...(record.frames.length === 0
                ? {}
                : {stacktrace: {frames: [...record.frames].reverse().map(toSentryStackFrame)}}),
        }]},
        ...(debugImages.length === 0 ? {} : {debug_meta: {images: debugImages}}),
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
    resolveFilenameDebugIds?: () => Readonly<Record<string, string>>,
): Sentry.Event {
    return buildSentryEventInternal(
        record,
        identity,
        suppressedCount,
        true,
        resolveFilenameDebugIds,
    );
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
    resolveFilenameDebugIds?: () => Readonly<Record<string, string>>,
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
        resolveFilenameDebugIds,
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
    resolveFilenameDebugIds: () => Readonly<Record<string, string>>,
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
        tracesSampleRate: 0,
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
            ? sanitizeSentryEvent(event, identity, resolveFilenameDebugIds)
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
    const resolveFilenameDebugIds = options.resolveFilenameDebugIds
        ?? (() => getFilenameToDebugIdMap(Sentry.defaultStackParser));
    let accepting = true;
    let disposed = false;
    let client: ISentryNitroClient | null = null;

    if (resolved.snapshot.ready && resolved.identity !== null) {
        try {
            client = clientFactory(createClientOptions(
                resolved.dsn,
                resolved.identity,
                () => accepting,
                resolveFilenameDebugIds,
            )) ?? null;
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
                    resolveFilenameDebugIds,
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
            : sanitizeSentryEvent(event, resolved.identity, resolveFilenameDebugIds),
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
