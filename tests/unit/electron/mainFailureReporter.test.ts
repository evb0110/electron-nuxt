import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createMainFailureReporter,
    MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT,
} from '@electron/features/diagnostics/public';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';

const BASE_STACK = 'Error\n    at mainFailure (electron/main.ts:12:4)';

function createInput(message = 'local details contain secret-document.pdf') {
    return {
        code: 'UNCLASSIFIED_MAIN_ERROR' as const,
        context: {},
        local: {
            source: 'main-test',
            message,
            cause: BASE_STACK,
            data: {path: '/Users/example/Documents/secret-document.pdf'},
        },
    };
}

function createIdFactory() {
    let nextId = 0;
    return () => {
        nextId += 1;
        return parseDiagnosticEventId(nextId.toString(16).padStart(32, '0'))!;
    };
}

describe('Electron main failure reporter', () => {
    it('initializes after the user-data path and before normal bootstrap', () => {
        const source = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');
        const indexOfMarker = (marker: string) => {
            const index = source.indexOf(marker);
            expect(index, marker).toBeGreaterThanOrEqual(0);
            return index;
        };
        const userDataIndex = indexOfMarker('app.setPath(\'userData\'');
        const resetIndex = indexOfMarker('resetSettingsCacheAfterUserDataPathChange();');
        const reporterIndex = indexOfMarker('initializeMainFailureReporter(');
        const bootstrapIndex = indexOfMarker('void runInitSequence({');

        expect(reporterIndex).toBeGreaterThan(userDataIndex);
        expect(reporterIndex).toBeGreaterThan(resetIndex);
        expect(reporterIndex).toBeLessThan(bootstrapIndex);
    });

    it('builds one closed record and returns its receipt without local details', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {
                isReady: true,
                send,
            },
        });

        const receipt = reporter.capture(createInput());
        const record = send.mock.calls[0]?.[0] as DiagnosticRecord;

        expect(receipt).toMatchObject({
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
        });
        expect(send).toHaveBeenCalledTimes(1);
        expect(record).toEqual({
            schemaVersion: 1,
            eventId: receipt.eventId,
            code: 'UNCLASSIFIED_MAIN_ERROR',
            severity: 'error',
            runtime: 'electron-main',
            operation: 'main-error',
            occurredAt: expect.any(Number),
            frames: [],
            context: {},
        });
        expect(JSON.stringify(record)).not.toContain('secret-document.pdf');
        expect('local' in record).toBe(false);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
        });
    });

    it('uses the source stack only for source-policy diagnostic codes', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            preference: 'granted',
            transport: {send},
        });

        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'startup failed',
                cause: BASE_STACK,
            },
        });

        expect(send.mock.calls[0]?.[0]).toMatchObject({
            code: 'MAIN_STARTUP_CRASH',
            severity: 'fatal',
            operation: 'startup-crash',
            frames: [{
                module: 'electron/main.ts',
                function: 'mainFailure',
                line: 12,
                column: 4,
            }],
        });
    });

    it('never throws when event ID creation or transport readiness fails', () => {
        const reporter = createMainFailureReporter({
            createEventId: () => {
                throw new Error('random source unavailable');
            },
            preference: 'granted',
            transport: {isReady: () => {
                throw new Error('transport unavailable');
            }},
        });

        expect(() => reporter.capture(createInput())).not.toThrow();
        const receipt = reporter.capture(createInput('second failure'));

        expect(receipt.eventId).toMatch(/^[0-9a-f]{32}$/u);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 2,
            transportFailed: 2,
            lastDropReason: 'transport-failed',
        });
    });

    it('checks policy before recent-ID dedupe so a later grant can retry the same record', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            preference: 'unknown',
            transport: {send},
        });
        const firstReporter = createMainFailureReporter({
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {send},
        });
        const record = firstReporter.capture(createInput());
        const sentRecord = send.mock.calls[0]?.[0] as DiagnosticRecord;
        send.mockClear();

        reporter.captureRecord(sentRecord);
        reporter.setPreference('granted');
        reporter.captureRecord(sentRecord);
        reporter.captureRecord(sentRecord);

        expect(send).toHaveBeenCalledTimes(1);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 3,
            accepted: 1,
            duplicate: 1,
            policyDropped: 1,
        });
        expect(reporter.captureRecord(sentRecord)).toEqual(record);
    });

    it('suppresses a per-code and top-frame burst and emits one capped summary', () => {
        let now = 0;
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            burstLimit: 1,
            burstWindowMs: 10,
            createEventId: createIdFactory(),
            now: () => now,
            preference: 'granted',
            transport: {send},
        });

        reporter.capture(createInput());
        for (let index = 0; index < MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 1; index += 1) {
            reporter.capture(createInput(`failure ${index}`));
        }
        now = 11;
        reporter.capture(createInput('summary boundary'));

        expect(send).toHaveBeenCalledTimes(2);
        expect(send.mock.calls[1]?.[1]).toBe(MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 3,
            accepted: 2,
            burstSuppressed: MAIN_DIAGNOSTICS_MAX_SUPPRESSED_COUNT + 1,
        });
    });

    it('keeps different top frames in separate burst buckets', () => {
        const send = vi.fn();
        const reporter = createMainFailureReporter({
            burstLimit: 1,
            createEventId: createIdFactory(),
            preference: 'granted',
            transport: {send},
        });

        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'first frame',
                cause: BASE_STACK,
            },
        });
        reporter.capture({
            code: 'MAIN_STARTUP_CRASH',
            context: {},
            local: {
                source: 'main-test',
                message: 'different frame',
                cause: 'Error\n    at otherFailure (electron/window.ts:20:2)',
            },
        });

        expect(send).toHaveBeenCalledTimes(2);
        expect(reporter.getHealthSnapshot().burstSuppressed).toBe(0);
    });
});
