import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Transport} from '@sentry/core';
import {requireDiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import {createSentryNodeDiagnosticsTransport} from '@electron/features/diagnostics/sentryNodeAdapter';

const RECORD = requireDiagnosticRecord({
    schemaVersion: 1,
    eventId: '0123456789abcdef0123456789abcdef',
    code: 'MAIN_STARTUP_CRASH',
    severity: 'fatal',
    runtime: 'electron-main',
    operation: 'startup-crash',
    occurredAt: 1_735_689_600_000,
    frames: [{
        module: 'electron/main.ts',
        function: 'start',
        line: 42,
        column: 7,
    }],
    context: {},
});

function setup() {
    const envelopes: unknown[] = [];
    const send = vi.fn((envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve({statusCode: 200});
    });
    const flush = vi.fn(() => Promise.resolve(true));
    const makeTransport = vi.fn(() => ({
        send,
        flush,
    } as Transport));
    const adapter = createSentryNodeDiagnosticsTransport({
        dsn: 'https://publickey@o123.ingest.de.sentry.io/456',
        identity: {
            target: 'desktop',
            release: 'evb-viewer-desktop@0.1.449',
            dist: 'macos-arm64',
            environment: 'test',
        },
        appVersion: '0.1.449',
        platform: 'darwin',
        architecture: 'arm64',
        runtimeVersions: {
            electron: '39.2.6',
            chrome: '142.0.7444.175',
            node: '22.21.1',
        },
        makeTransport,
    });
    return {
        adapter,
        envelopes,
        send,
        flush,
        makeTransport,
    };
}

describe('Sentry Node diagnostics adapter', () => {
    it('creates no process hooks, queue, or initialization envelope', () => {
        const beforeListeners = process.listeners('beforeExit');
        const uncaughtListeners = process.listeners('uncaughtException');
        const setupResult = setup();

        expect(setupResult.envelopes).toEqual([]);
        expect(setupResult.flush).not.toHaveBeenCalled();
        expect(process.listeners('beforeExit')).toEqual(beforeListeners);
        expect(process.listeners('uncaughtException')).toEqual(uncaughtListeners);
    });

    it('sends exactly one closed event item without forbidden input', async () => {
        const {
            adapter,
            envelopes,
        } = setup();
        const value = await adapter.send?.(RECORD, 3);

        expect(value).toBe(true);
        expect(envelopes).toHaveLength(1);
        const serialized = JSON.stringify(envelopes[0]);
        expect(serialized).toContain('evb-diagnostic-v1');
        expect(serialized).toContain('MainStartupCrash');
        expect(serialized).toContain('electron/main.ts');
        expect(serialized).toContain('"suppressedCount":3');
        expect(serialized).not.toContain('client_report');
        expect(serialized).not.toContain('secret-document.pdf');
        const envelope = envelopes[0] as [unknown, unknown[]];
        expect(envelope[1]).toHaveLength(1);
        expect((envelope[1][0] as [{type: string}, unknown])[0]).toEqual({type: 'event'});
    });

    it('fails closed for non-EU, secret-bearing, and malformed DSNs', () => {
        for (const dsn of [
            'https://publickey@o123.ingest.us.sentry.io/456',
            'https://publickey:secret@o123.ingest.de.sentry.io/456',
            'not-a-dsn',
        ]) {
            expect(() => createSentryNodeDiagnosticsTransport({
                dsn,
                identity: {
                    target: 'desktop',
                    release: 'evb-viewer-desktop@0.1.449',
                    dist: 'macos-arm64',
                    environment: 'test',
                },
                appVersion: '0.1.449',
            })).toThrow();
        }
    });

    it('rejects malformed records before transport', () => {
        const {
            adapter,
            send,
        } = setup();
        expect(adapter.send?.({
            ...RECORD,
            request: {url: 'secret'},
        } as never)).toBe(false);
        expect(send).not.toHaveBeenCalled();
    });
});
