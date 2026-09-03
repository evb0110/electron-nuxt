import {
    createEventEnvelope,
    getEnvelopeEndpointWithUrlEncodedAuth,
    makeDsn,
    type Event,
    type Transport,
} from '@sentry/core/browser';
import {makeFetchTransport} from '@sentry/browser';
import {DIAGNOSTIC_DEFINITIONS} from '@contracts/diagnostics/diagnosticCodes';
import {
    decodeDiagnosticRecord,
    type DiagnosticRecord,
} from '@contracts/diagnostics/diagnosticRecord';
import {decodeDiagnosticsSuppressedCount} from '@contracts/diagnostics/diagnosticsCapability';
import {
    assertSentryBuildIdentity,
    type SentryBuildIdentity,
} from '@contracts/diagnostics/releaseIdentity.js';
import type {IHostedDiagnosticsTransport} from '@app/utils/failureReporter';

const EVB_DIAGNOSTIC_SCHEMA_MARKER = 'evb-diagnostic-v1';
const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;

type TSentryTransportFactory = (options: Parameters<typeof makeFetchTransport>[0]) => Transport;

export interface IBrowserDiagnosticsTransportOptions {
    dsn: string;
    identity: SentryBuildIdentity;
    makeTransport?: TSentryTransportFactory;
}

function requireEuDsn(value: string) {
    const candidate = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username.length === 0
        || parsed.password.length > 0
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(parsed.hostname)
        || !/^\/\d+\/?$/u.test(parsed.pathname)
    ) {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    const dsn = makeDsn(candidate);
    if (
        dsn === undefined
        || dsn.protocol !== 'https'
        || typeof dsn.publicKey !== 'string'
        || dsn.publicKey.length === 0
        || Boolean(dsn.pass)
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(dsn.host)
        || !/^\d+$/u.test(dsn.projectId)
    ) {
        throw new Error('Browser diagnostics require a valid EU Sentry DSN');
    }
    return dsn;
}

function buildClosedEvent(
    record: DiagnosticRecord,
    suppressedCount: number,
    identity: SentryBuildIdentity,
): Event {
    const definition = DIAGNOSTIC_DEFINITIONS[record.code];
    const topFrame = record.frames[0];
    return {
        event_id: record.eventId,
        timestamp: record.occurredAt / 1_000,
        level: record.severity,
        platform: 'javascript',
        logger: 'evb-viewer.diagnostics',
        release: identity.release,
        dist: identity.dist,
        environment: identity.environment,
        fingerprint: [
            record.runtime,
            record.code,
            topFrame?.module ?? 'no-application-frame',
        ],
        exception: {values: [{
            type: definition.exceptionType,
            value: definition.exceptionValue,
            stacktrace: {frames: [...record.frames].reverse().map(frame => ({
                filename: frame.module,
                module: frame.module,
                ...(frame.function === undefined ? {} : {function: frame.function}),
                ...(frame.line === undefined ? {} : {lineno: frame.line}),
                ...(frame.column === undefined ? {} : {colno: frame.column}),
                in_app: true,
            }))},
        }]},
        tags: {
            evb_schema: EVB_DIAGNOSTIC_SCHEMA_MARKER,
            diagnostic_code: record.code,
            diagnostic_runtime: record.runtime,
            ...(record.operation === undefined ? {} : {diagnostic_operation: record.operation}),
        },
        contexts: {evb_runtime: {target: 'hosted-browser'}},
        extra: {
            schemaVersion: record.schemaVersion,
            context: Object.fromEntries(Object.entries(record.context)),
            ...(suppressedCount === 0 ? {} : {suppressedCount}),
        },
    };
}

function isSuccessfulResponse(value: Awaited<ReturnType<Transport['send']>>) {
    return value.statusCode === undefined
        || value.statusCode >= 200 && value.statusCode < 300;
}

export function createBrowserDiagnosticsTransport(
    options: IBrowserDiagnosticsTransportOptions,
): IHostedDiagnosticsTransport {
    const identity = assertSentryBuildIdentity(options.identity);
    if (identity.target !== 'web') {
        throw new Error('Browser diagnostics require an exact web build identity');
    }
    const dsn = requireEuDsn(options.dsn);
    const makeTransport = options.makeTransport ?? makeFetchTransport;
    const transport = makeTransport({
        url: getEnvelopeEndpointWithUrlEncodedAuth(dsn),
        recordDroppedEvent: () => undefined,
    });

    return Object.freeze({send: (value: DiagnosticRecord, inheritedSuppressedCount = 0) => {
        const record = decodeDiagnosticRecord(value);
        const suppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
        if (record === null || suppressedCount === null) {
            return false;
        }
        const event = buildClosedEvent(record, suppressedCount, identity);
        const markedEvent = event.tags?.evb_schema === EVB_DIAGNOSTIC_SCHEMA_MARKER
            ? buildClosedEvent(record, suppressedCount, identity)
            : null;
        if (markedEvent === null) {
            return false;
        }
        try {
            return Promise.resolve(transport.send(createEventEnvelope(markedEvent, dsn)))
                .then(isSuccessfulResponse, () => false);
        } catch {
            return false;
        }
    }});
}

export function createConfiguredBrowserDiagnosticsTransport() {
    const publicConfig: unknown = useRuntimeConfig().public;
    const sentry = typeof publicConfig === 'object' && publicConfig !== null
        ? (publicConfig as Record<string, unknown>).sentry
        : null;
    const sentryRecord = typeof sentry === 'object' && sentry !== null
        ? sentry as Record<string, unknown>
        : {};
    const readString = (key: string) => {
        const value = sentryRecord[key];
        return typeof value === 'string' ? value : '';
    };
    return createBrowserDiagnosticsTransport({
        dsn: readString('dsn'),
        identity: {
            target: 'web',
            release: readString('release'),
            dist: readString('dist'),
            environment: readString('environment') as 'production' | 'preview' | 'development' | 'test',
        },
    });
}
