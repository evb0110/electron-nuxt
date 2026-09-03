import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import {
    buildSentryEvent,
    createSentryNitroAdapter,
    type ISentryNitroAdapterOptions,
    type TSentryNitroClientFactory,
} from '@server/utils/sentryNitroAdapter';

const POLICY = {
    enabled: true,
    legitimateInterestsApproved: true,
    legalNoticePublished: true,
    dpaExecuted: true,
    accountHardened: true,
    retentionReady: true,
    objectionReady: true,
} as const;

const RUNTIME_CONFIG = {sentry: {
    nitroDsn: 'https://public@o123.ingest.sentry.io/42',
    release: 'evb-viewer-web@1.2.3',
    dist: 'production',
    environment: 'production',
}} as const;

function createRecord(eventId = '00000000000000000000000000000001'): DiagnosticRecord {
    return {
        schemaVersion: 1,
        eventId: parseDiagnosticEventId(eventId)!,
        code: 'UNCLASSIFIED_MAIN_ERROR',
        severity: 'error',
        runtime: 'viewer-nitro',
        operation: 'main-error',
        occurredAt: 1_725_000_000_000,
        frames: [{
            module: 'server/api/example.ts',
            function: 'handleRequest',
            line: 12,
            column: 4,
        }],
        context: {},
    };
}

function createAdapterFixture() {
    const capturedEvents: unknown[] = [];
    let capturedOptions: Parameters<TSentryNitroClientFactory>[0] | undefined;
    const close = vi.fn(async () => true);
    const clientFactory: TSentryNitroClientFactory = options => {
        capturedOptions = options;
        return {
            captureEvent: event => {
                capturedEvents.push(event);
                return event.event_id;
            },
            close,
        };
    };
    const adapter = createSentryNitroAdapter({
        clientFactory,
        policy: POLICY,
        runtimeConfig: RUNTIME_CONFIG,
    });
    return {
        adapter,
        capturedEvents,
        capturedOptions: () => capturedOptions,
        close,
    };
}

describe('viewer Nitro Sentry adapter', () => {
    it('requires every policy gate, immutable web identity, and a valid DSN', () => {
        const clientFactory = vi.fn<TSentryNitroClientFactory>(() => undefined);
        const base: ISentryNitroAdapterOptions = {
            clientFactory,
            policy: {
                ...POLICY,
                enabled: false,
            },
            runtimeConfig: RUNTIME_CONFIG,
        };

        expect(createSentryNitroAdapter(base).isReady()).toBe(false);
        expect(clientFactory).not.toHaveBeenCalled();

        const missingGate = createSentryNitroAdapter({
            ...base,
            policy: {
                ...POLICY,
                objectionReady: false,
            },
        });
        expect(missingGate.isReady()).toBe(false);

        const invalidDsn = createSentryNitroAdapter({
            ...base,
            runtimeConfig: {
                ...RUNTIME_CONFIG,
                sentry: {
                    ...RUNTIME_CONFIG.sentry,
                    nitroDsn: 'https://public@o123.ingest.sentry.io/42?secret=query',
                },
            },
        });
        expect(invalidDsn.isReady()).toBe(false);

        const missingIdentity = createSentryNitroAdapter({
            ...base,
            runtimeConfig: {sentry: {nitroDsn: RUNTIME_CONFIG.sentry.nitroDsn}},
        });
        expect(missingIdentity.isReady()).toBe(false);
        expect(clientFactory).not.toHaveBeenCalled();
    });

    it('passes release, dist, environment, and no-client-report privacy options', () => {
        const fixture = createAdapterFixture();
        expect(fixture.adapter.isReady()).toBe(true);
        expect(fixture.adapter.getConfiguration()).toEqual({
            ready: true,
            hasDsn: true,
            identity: {
                target: 'web',
                release: 'evb-viewer-web@1.2.3',
                dist: 'production',
                environment: 'production',
            },
            policy: POLICY,
        });

        const options = fixture.capturedOptions();
        expect(options).toMatchObject({
            dsn: RUNTIME_CONFIG.sentry.nitroDsn,
            release: RUNTIME_CONFIG.sentry.release,
            dist: RUNTIME_CONFIG.sentry.dist,
            environment: RUNTIME_CONFIG.sentry.environment,
            defaultIntegrations: false,
            integrations: [],
            skipOpenTelemetrySetup: true,
            sendClientReports: false,
            sendDefaultPii: false,
            maxBreadcrumbs: 0,
            enableLogs: false,
            enableMetrics: false,
            profilesSampleRate: 0,
            profileSessionSampleRate: 0,
            tracePropagationTargets: [],
            dataCollection: {
                userInfo: false,
                cookies: false,
                queryParams: false,
                urlQueryParams: false,
                databaseQueryData: false,
                stackFrameVariables: false,
                frameContextLines: 0,
            },
        });
        expect(options?.transportOptions).toEqual({bufferSize: 16});
        expect(options?.transport).toBeTypeOf('function');
    });

    it('sends one closed event and applies the final sanitizer before SDK send', () => {
        const fixture = createAdapterFixture();
        const record = createRecord();
        expect(fixture.adapter.send(record, 4)).toBe(record.eventId);
        expect(fixture.capturedEvents).toHaveLength(1);

        const event = fixture.capturedEvents[0] as Record<string, unknown>;
        expect(event).toMatchObject({
            event_id: record.eventId,
            release: RUNTIME_CONFIG.sentry.release,
            dist: RUNTIME_CONFIG.sentry.dist,
            environment: RUNTIME_CONFIG.sentry.environment,
            tags: {
                runtime: 'viewer-nitro',
                code: 'UNCLASSIFIED_MAIN_ERROR',
                operation: 'main-error',
            },
        });
        const finalEvent = fixture.adapter.sanitizeEvent(event);
        expect(finalEvent).not.toBeNull();
        expect(finalEvent).not.toHaveProperty('extra');
        expect(finalEvent).not.toHaveProperty('request');
        expect(finalEvent).not.toHaveProperty('user');
        expect(finalEvent).not.toHaveProperty('breadcrumbs');
        expect(finalEvent).not.toHaveProperty('transaction');
        expect(JSON.stringify(finalEvent)).not.toContain('document-secret.pdf');
        expect(JSON.stringify(finalEvent)).not.toContain('https://private.example');
        expect(JSON.stringify(finalEvent)).toContain('suppressedCount');
    });

    it('reconstructs only marked records and drops arbitrary or unmarked events', () => {
        const fixture = createAdapterFixture();
        const identity = fixture.adapter.getConfiguration().identity;
        expect(identity).not.toBeNull();
        if (identity === null) {
            return;
        }
        const record = createRecord();
        const marked = buildSentryEvent(record, identity, 2) as Record<string, unknown>;
        const polluted = {
            ...marked,
            message: 'raw server error: document-secret.pdf',
            request: {
                body: 'private document bytes',
                headers: {cookie: 'session=secret'},
                url: 'https://private.example/view?token=secret',
            },
            user: {
                id: 'user-secret',
                ip_address: '192.0.2.1',
            },
            breadcrumbs: [{message: 'raw breadcrumb'}],
            transaction: '/view?document=secret',
            spans: [{description: 'database query'}],
            extra: {
                ...(marked.extra as Record<string, unknown>),
                raw: 'do-not-forward',
            },
        };
        const sanitized = fixture.adapter.sanitizeEvent(polluted);
        expect(sanitized).not.toBeNull();
        expect(sanitized).not.toHaveProperty('message');
        expect(sanitized).not.toHaveProperty('request');
        expect(sanitized).not.toHaveProperty('user');
        expect(sanitized).not.toHaveProperty('breadcrumbs');
        expect(sanitized).not.toHaveProperty('transaction');
        expect(sanitized).not.toHaveProperty('spans');
        expect(sanitized).not.toHaveProperty('extra');
        expect(JSON.stringify(sanitized)).not.toContain('do-not-forward');
        expect(fixture.adapter.sanitizeEvent({message: 'unmarked'})).toBeNull();
    });

    it('stops accepting events before closing and never queues a report', () => {
        const fixture = createAdapterFixture();
        fixture.adapter.dispose();
        expect(fixture.adapter.isReady()).toBe(false);
        expect(fixture.adapter.send(createRecord())).toBe(false);
        expect(fixture.close).toHaveBeenCalledWith(0);
        expect(fixture.capturedEvents).toHaveLength(0);
    });
});
