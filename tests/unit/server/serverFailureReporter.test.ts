import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import type {CaptureFailureInput} from '@contracts/diagnostics/failureReceipt';
import {
    createServerFailureReporter,
    SERVER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@server/utils/serverFailureReporter';

const mocks = vi.hoisted(() => ({hasObjection: vi.fn()}));

vi.mock('@server/utils/diagnosticsObjection', () => ({hasDiagnosticsServerObjection: mocks.hasObjection}));

const EVENT = {} as never;

function createIdFactory() {
    let nextId = 0;
    return () => {
        nextId += 1;
        return parseDiagnosticEventId(nextId.toString(16).padStart(32, '0'))!;
    };
}

function createInput(
    message = 'raw local document-secret.pdf',
    cause?: unknown,
): CaptureFailureInput<'UNCLASSIFIED_MAIN_ERROR'> {
    return {
        code: 'UNCLASSIFIED_MAIN_ERROR',
        context: {},
        local: {
            source: 'server-test',
            message,
            ...(cause === undefined ? {} : {cause}),
            data: {path: '/Users/example/Documents/document-secret.pdf'},
        },
    };
}

function createTransport(send: (record: DiagnosticRecord, suppressedCount?: number) => unknown) {
    return {
        isReady: true,
        send,
    };
}

describe('viewer Nitro server failure reporter', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.hasObjection.mockReturnValue(false);
    });

    it('builds a closed viewer-Nitro record and keeps local details local', () => {
        const send = vi.fn((record: DiagnosticRecord) => record.eventId);
        const localSink = vi.fn();
        const reporter = createServerFailureReporter({
            createEventId: createIdFactory(),
            localSink,
            transport: createTransport(send),
        });

        const receipt = reporter.capture(createInput(), EVENT);
        const record = send.mock.calls[0]?.[0];

        expect(receipt).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        });
        expect(record).toMatchObject({
            schemaVersion: 1,
            eventId: receipt.eventId,
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
            runtime: 'viewer-nitro',
            operation: 'main-error',
            context: {},
        });
        expect(record?.frames).toEqual([]);
        expect(JSON.stringify(record)).not.toContain('document-secret.pdf');
        expect(JSON.stringify(record)).not.toContain('raw local');
        expect('local' in (record ?? {})).toBe(false);
        expect(localSink).toHaveBeenCalledWith(expect.objectContaining({message: 'raw local document-secret.pdf'}));
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: 'enabled',
            attempted: 1,
            accepted: 1,
        });
    });

    it('captures an uncaught 500 once with canonical source frames', () => {
        const send = vi.fn((record: DiagnosticRecord) => record.eventId);
        const error = new Error('raw message document-secret.pdf');
        error.stack = 'Error: raw message document-secret.pdf\n'
            + '    at handler (server/api/documents.get.ts:42:3)';
        Object.assign(error, {statusCode: 500});
        const reporter = createServerFailureReporter({
            createEventId: createIdFactory(),
            transport: createTransport(send),
        });

        const receipt = reporter.captureUncaught(error, EVENT);
        const record = send.mock.calls[0]?.[0];

        expect(receipt).toBeDefined();
        expect(send).toHaveBeenCalledOnce();
        expect(record).toMatchObject({
            runtime: 'viewer-nitro',
            code: 'UNCLASSIFIED_MAIN_ERROR',
            frames: [{
                module: 'server/api/documents.get.ts',
                function: 'handler',
                line: 42,
                column: 3,
            }],
        });
        expect(JSON.stringify(record)).not.toContain('raw message');
        expect(JSON.stringify(record)).not.toContain('document-secret.pdf');
    });

    it('keeps expected HTTP outcomes out of the failure stream', () => {
        const send = vi.fn();
        const reporter = createServerFailureReporter({transport: createTransport(send)});

        for (const statusCode of [
            400,
            404,
            422,
            499,
        ]) {
            const error = Object.assign(new Error('expected local detail'), {statusCode});
            expect(reporter.captureUncaught(error, EVENT)).toBeUndefined();
        }
        expect(send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 0,
            accepted: 0,
        });
    });

    it('checks objection before ownership and transport admission', () => {
        const send = vi.fn();
        mocks.hasObjection.mockReturnValue(true);
        const reporter = createServerFailureReporter({
            createEventId: createIdFactory(),
            transport: createTransport(send),
        });
        const firstReceipt = reporter.capture(createInput(), EVENT);

        mocks.hasObjection.mockReturnValue(false);
        const secondReceipt = reporter.capture(createInput('second local detail'), EVENT);

        expect(send).toHaveBeenCalledOnce();
        expect(secondReceipt.eventId).not.toBe(firstReceipt.eventId);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            policyDropped: 1,
            accepted: 1,
        });
    });

    it('returns the same receipt when the explicit owner and Nitro hook see one Error', () => {
        const send = vi.fn((record: DiagnosticRecord) => record.eventId);
        const error = new Error('raw error detail');
        error.stack = 'Error\n    at handler (server/api/example.get.ts:9:2)';
        const reporter = createServerFailureReporter({
            createEventId: createIdFactory(),
            transport: createTransport(send),
        });

        const ownedReceipt = reporter.capture(createInput('explicit detail', error), EVENT);
        const hookReceipt = reporter.captureUncaught(error, EVENT);

        expect(hookReceipt).toEqual(ownedReceipt);
        expect(send).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
        });
    });

    it('suppresses a burst and emits the bounded count at the next window', () => {
        let now = 0;
        const send = vi.fn((record: DiagnosticRecord, suppressedCount?: number) => ({
            eventId: record.eventId,
            suppressedCount,
        }));
        const reporter = createServerFailureReporter({
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: createIdFactory(),
            now: () => now,
            transport: createTransport(send),
        });

        reporter.capture(createInput('first'));
        reporter.capture(createInput('suppressed'));
        now = 11;
        reporter.capture(createInput('summary'));

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[1]).toBe(1);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 2,
            burstSuppressed: 1,
        });
    });

    it('rejects duplicate event IDs and malformed records without transport activity', () => {
        const send = vi.fn();
        const duplicateId = () => parseDiagnosticEventId('a'.repeat(32))!;
        const reporter = createServerFailureReporter({
            createEventId: duplicateId,
            transport: createTransport(send),
        });
        reporter.capture(createInput());
        reporter.capture(createInput('same ID'));

        const wrongRuntime = {
            ...send.mock.calls[0]?.[0],
            runtime: 'electron-main',
        };
        reporter.captureRecord(wrongRuntime);

        expect(send).toHaveBeenCalledOnce();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            duplicate: 1,
            schemaDropped: 1,
        });
    });

    it('fails closed when the transport is not ready', () => {
        const send = vi.fn();
        const reporter = createServerFailureReporter({
            createEventId: createIdFactory(),
            transport: {
                isReady: false,
                send,
            },
        });

        reporter.capture(createInput());

        expect(send).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            mode: 'disabled',
            policyDropped: 1,
            accepted: 0,
            transportFailed: 0,
        });
    });

    it('exposes only the fixed local health keys', () => {
        const reporter = createServerFailureReporter({transport: createTransport(() => undefined)});
        expect(Object.keys(reporter.getHealthSnapshot())).toEqual([
            'mode',
            'initializationCount',
            'attempted',
            'accepted',
            'duplicate',
            'burstSuppressed',
            'policyDropped',
            'schemaDropped',
            'framelessDropped',
            'ownedProjection',
            'transportFailed',
            'lastDropReason',
        ]);
        expect(SERVER_DIAGNOSTICS_MAX_SUPPRESSED_COUNT).toBe(10_000);
    });
});
