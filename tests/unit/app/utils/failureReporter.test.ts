import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createRendererFailureReporter,
    type IHostedDiagnosticsTransport,
    type TRendererDiagnosticSender,
} from '@app/utils/failureReporter';
import type {DiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';

function eventId(value: number) {
    return value.toString(16).padStart(32, '0') as DiagnosticEventId;
}

function createFailureInput(message = 'renderer failed') {
    const cause = new Error(message);
    cause.stack = `Error: ${message}\n    at renderDocument (app/modules/viewer/render.ts:12:4)`;
    return {
        code: 'UNCLASSIFIED_RENDERER_ERROR' as const,
        context: {},
        local: {
            source: 'failure-reporter-test',
            message,
            cause,
            data: {rawMessage: message},
        },
    };
}

function createElectronReporter(overrides: Parameters<typeof createRendererFailureReporter>[0] = {}) {
    const sends: Array<{
        record: Parameters<TRendererDiagnosticSender>[0];
        suppressedCount?: number;
    }> = [];
    const sender = vi.fn((record: Parameters<TRendererDiagnosticSender>[0]) => {
        sends.push({record});
    });
    let nextEventId = 1;
    const reporter = createRendererFailureReporter({
        host: 'electron',
        electronSender: sender,
        createEventId: () => eventId(nextEventId++),
        ...overrides,
    });
    return {
        reporter,
        sender,
        sends,
    };
}

describe('renderer failure reporter', () => {
    it('captures one closed Electron record synchronously and keeps raw details in the local sink', () => {
        const localSink = vi.fn();
        const {
            reporter,
            sender,
        } = createElectronReporter({localSink});

        const receipt = reporter.capture(createFailureInput('private local detail'));

        expect(sender).toHaveBeenCalledOnce();
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            runtime: 'electron-renderer',
            code: 'UNCLASSIFIED_RENDERER_ERROR',
            context: {},
        }));
        expect(sender.mock.calls[0]?.[0]).not.toHaveProperty('local');
        expect(JSON.stringify(sender.mock.calls[0]?.[0])).not.toContain('private local detail');
        expect(localSink).toHaveBeenCalledWith(expect.objectContaining({
            message: 'private local detail',
            cause: expect.any(Error),
        }), receipt);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
            duplicate: 0,
            transportFailed: 0,
        });
    });

    it('rejects a repeated event ID without a second local projection or send', () => {
        const localSink = vi.fn();
        const {
            reporter,
            sender,
        } = createElectronReporter({
            createEventId: () => eventId(1),
            localSink,
        });

        reporter.capture(createFailureInput());
        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledOnce();
        expect(localSink).toHaveBeenCalledTimes(2);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            accepted: 1,
            duplicate: 1,
            lastDropReason: 'duplicate',
        });
    });

    it('suppresses a burst and forwards one clamped summary when its window rolls over', () => {
        let currentTime = 0;
        const sent: Array<{suppressedCount?: number}> = [];
        const reporter = createRendererFailureReporter({
            host: 'electron',
            now: () => currentTime,
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: (() => {
                let value = 1;
                return () => eventId(value++);
            })(),
            electronSender: (_record, suppressedCount) => {
                sent.push(suppressedCount === undefined ? {} : {suppressedCount});
            },
        });

        reporter.capture(createFailureInput());
        reporter.capture(createFailureInput());
        currentTime = 10;
        reporter.capture(createFailureInput());

        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual({suppressedCount: 1});
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 2,
            burstSuppressed: 1,
        });
    });

    it('clamps a burst summary at 10,000 suppressed occurrences', () => {
        let currentTime = 0;
        const sender = vi.fn();
        const reporter = createRendererFailureReporter({
            host: 'electron',
            now: () => currentTime,
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: (() => {
                let value = 1;
                return () => eventId(value++);
            })(),
            electronSender: sender,
        });

        reporter.capture(createFailureInput());
        for (let index = 0; index < 10_001; index += 1) {
            reporter.capture(createFailureInput());
        }
        currentTime = 10;
        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledTimes(2);
        expect(sender.mock.calls[1]?.[1]).toBe(10_000);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            burstSuppressed: 10_001,
            accepted: 2,
        });
    });

    it('counts an owned projection without creating an occurrence', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter();

        const receipt = reporter.withSuppressedCapture(() => reporter.capture(createFailureInput()));

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(sender).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 0,
            ownedProjection: 1,
            lastDropReason: 'owned-projection',
        });
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('forwards Electron records despite the %s startup hint', (startupHint) => {
        const {
            reporter,
            sender,
        } = createElectronReporter({readHostedPreference: () => startupHint});

        reporter.capture(createFailureInput());

        expect(sender).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: 'unknown',
            policyDropped: 0,
            accepted: 1,
        });
    });

    it.each([
        'unknown',
        'denied',
    ] as const)('does not load or send a hosted transport while %s', async (preference) => {
        const transport: IHostedDiagnosticsTransport = {send: vi.fn()};
        const loadHostedTransport = vi.fn(async () => transport);
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            readHostedPreference: () => preference,
            loadHostedTransport,
            createEventId: () => eventId(1),
        });

        reporter.capture(createFailureInput());
        await Promise.resolve();

        expect(loadHostedTransport).not.toHaveBeenCalled();
        expect(transport.send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: preference,
            attempted: 1,
            policyDropped: 1,
            accepted: 0,
        });
    });

    it('uses the hosted runtime and transport after a local grant', async () => {
        const send = vi.fn();
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            readHostedPreference: () => 'granted',
            loadHostedTransport: () => ({send}),
            createEventId: () => eventId(1),
        });

        const receipt = reporter.capture(createFailureInput());
        await Promise.resolve();

        expect(send).toHaveBeenCalledWith(expect.objectContaining({
            runtime: 'hosted-browser',
            eventId: receipt.eventId,
        }));
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: 'granted',
            accepted: 1,
        });
    });

    it('reserves hosted recent-ID and burst slots before a deferred transport resolves', async () => {
        let resolveTransport!: (transport: IHostedDiagnosticsTransport) => void;
        const transport = {send: vi.fn()};
        const loadHostedTransport = vi.fn(() => new Promise<IHostedDiagnosticsTransport>((resolve) => {
            resolveTransport = resolve;
        }));
        const eventIds = [
            eventId(1),
            eventId(1),
            eventId(2),
        ];
        const reporter = createRendererFailureReporter({
            host: 'hosted-browser',
            burstLimit: 1,
            readHostedPreference: () => 'granted',
            loadHostedTransport,
            createEventId: () => eventIds.shift() ?? eventId(3),
        });

        reporter.capture(createFailureInput('first'));
        reporter.capture(createFailureInput('duplicate'));
        reporter.capture(createFailureInput('burst'));

        expect(loadHostedTransport).toHaveBeenCalledOnce();
        expect(transport.send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 1,
            duplicate: 1,
            burstSuppressed: 1,
        });

        resolveTransport(transport);
        await Promise.resolve();
        await Promise.resolve();

        expect(transport.send).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            accepted: 1,
            transportFailed: 0,
        });
    });

    it('contains transport failure warnings and never turns a warning into another occurrence', () => {
        const rawWarningSink = vi.fn((_message: string) => {
            throw new Error('raw warning failed');
        });
        const {reporter} = createElectronReporter({
            electronSender: () => {
                throw new Error('send failed');
            },
            rawWarningSink,
        });

        expect(() => reporter.capture(createFailureInput())).not.toThrow();

        expect(rawWarningSink).toHaveBeenCalledOnce();
        expect(rawWarningSink.mock.calls[0]?.[0].length).toBeLessThanOrEqual(512);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
            transportFailed: 1,
        });
    });

    it('counts malformed closed records as schema drops without sending them', () => {
        const {
            reporter,
            sender,
        } = createElectronReporter();

        const receipt = reporter.captureRecord({eventId: 'not-a-record'});

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(sender).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            schemaDropped: 1,
            lastDropReason: 'schema-dropped',
        });
    });
});
