/* eslint-disable custom/file-naming */

import {
    createTransport,
    createEventEnvelope,
    getEnvelopeEndpointWithUrlEncodedAuth,
    makeDsn,
    type Event,
    type Transport,
} from '@sentry/core';
import {request as requestHttps} from 'node:https';
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
import type {IMainDiagnosticsTransport} from '@electron/features/diagnostics/mainFailureReporter';

const EVB_DIAGNOSTIC_SCHEMA_MARKER = 'evb-diagnostic-v1';
const EU_SENTRY_INGEST_HOST_PATTERN = /(?:^|\.)ingest\.de\.sentry\.io$/u;

interface INodeEnvelopeTransportOptions {
    readonly url: string;
    readonly recordDroppedEvent: () => void;
}

type TSentryTransportFactory = (options: INodeEnvelopeTransportOptions) => Transport;

export interface ISentryNodeAdapterOptions {
    dsn: string;
    identity: SentryBuildIdentity;
    appVersion: string;
    platform?: string;
    architecture?: string;
    runtimeVersions?: {
        electron?: string;
        chrome?: string;
        node?: string;
    };
    makeTransport?: TSentryTransportFactory;
}

function majorVersion(value: string | undefined) {
    const match = value?.match(/^(\d+)/u);
    return match?.[1];
}

function requireEuDsn(value: string) {
    const candidate = value.trim();
    let parsed: URL;
    try {
        parsed = new URL(candidate);
    } catch {
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
    }
    if (
        parsed.protocol !== 'https:'
        || parsed.username.length === 0
        || parsed.password.length > 0
        || !EU_SENTRY_INGEST_HOST_PATTERN.test(parsed.hostname)
        || !/^\/\d+\/?$/u.test(parsed.pathname)
    ) {
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
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
        throw new Error('Desktop diagnostics require a valid EU Sentry DSN');
    }
    return dsn;
}

function closedContext(value: DiagnosticRecord['context']) {
    return Object.fromEntries(Object.entries(value));
}

function buildClosedEvent(
    record: DiagnosticRecord,
    suppressedCount: number,
    identity: SentryBuildIdentity,
    options: ISentryNodeAdapterOptions,
): Event {
    const definition = DIAGNOSTIC_DEFINITIONS[record.code];
    const topFrame = record.frames[0];
    const electronMajor = majorVersion(options.runtimeVersions?.electron);
    const chromiumMajor = majorVersion(options.runtimeVersions?.chrome);
    const nodeMajor = majorVersion(options.runtimeVersions?.node);
    const runtimeContext = {
        app_version: options.appVersion,
        platform: options.platform ?? 'unknown',
        architecture: options.architecture ?? 'unknown',
        ...(electronMajor === undefined ? {} : {electron_major: electronMajor}),
        ...(chromiumMajor === undefined ? {} : {chromium_major: chromiumMajor}),
        ...(nodeMajor === undefined ? {} : {node_major: nodeMajor}),
    };

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
        contexts: {evb_runtime: runtimeContext},
        extra: {
            schemaVersion: record.schemaVersion,
            context: closedContext(record.context),
            ...(suppressedCount === 0 ? {} : {suppressedCount}),
        },
    };
}

function isSuccessfulResponse(value: Awaited<ReturnType<Transport['send']>>) {
    return value.statusCode === undefined
        || value.statusCode >= 200 && value.statusCode < 300;
}

function createNodeEnvelopeTransport(options: INodeEnvelopeTransportOptions) {
    return createTransport({
        bufferSize: 16,
        recordDroppedEvent: options.recordDroppedEvent,
    }, request => new Promise((resolve, reject) => {
        const body = request.body;
        const outgoing = requestHttps(options.url, {
            method: 'POST',
            headers: {
                'content-type': 'application/x-sentry-envelope',
                'content-length': String(typeof body === 'string'
                    ? Buffer.byteLength(body)
                    : body.byteLength),
            },
        }, response => {
            response.resume();
            response.once('end', () => {
                resolve({
                    ...(response.statusCode === undefined ? {} : {statusCode: response.statusCode}),
                    headers: {
                        'retry-after': typeof response.headers['retry-after'] === 'string'
                            ? response.headers['retry-after']
                            : null,
                        'x-sentry-rate-limits': typeof response.headers['x-sentry-rate-limits'] === 'string'
                            ? response.headers['x-sentry-rate-limits']
                            : null,
                    },
                });
            });
        });
        outgoing.once('error', reject);
        outgoing.end(body);
    }));
}

export function createSentryNodeDiagnosticsTransport(
    options: ISentryNodeAdapterOptions,
): IMainDiagnosticsTransport {
    const identity = assertSentryBuildIdentity(options.identity);
    const appVersion = options.appVersion.trim();
    const platform = options.platform ?? 'unknown';
    const architecture = options.architecture ?? 'unknown';
    if (
        identity.target !== 'desktop'
        || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(appVersion)
        || identity.release !== `evb-viewer-desktop@${appVersion}`
        || ![
            'darwin',
            'linux',
            'win32',
            'unknown',
        ].includes(platform)
        || ![
            'arm64',
            'x64',
            'unknown',
        ].includes(architecture)
    ) {
        throw new Error('Desktop diagnostics require an exact desktop build identity');
    }
    const dsn = requireEuDsn(options.dsn);
    const makeTransport = options.makeTransport ?? createNodeEnvelopeTransport;
    const transport = makeTransport({
        url: getEnvelopeEndpointWithUrlEncodedAuth(dsn),
        recordDroppedEvent: () => undefined,
    });

    return Object.freeze({
        isReady: true,
        send: (value: DiagnosticRecord, inheritedSuppressedCount = 0) => {
            const record = decodeDiagnosticRecord(value);
            const suppressedCount = decodeDiagnosticsSuppressedCount(inheritedSuppressedCount);
            if (record === null || suppressedCount === null) {
                return false;
            }
            const event = buildClosedEvent(record, suppressedCount, identity, options);
            const markedEvent = event.tags?.evb_schema === EVB_DIAGNOSTIC_SCHEMA_MARKER
                ? buildClosedEvent(record, suppressedCount, identity, options)
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
        },
    });
}
