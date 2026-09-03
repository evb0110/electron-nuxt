import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type {Transport} from '@sentry/core/browser';
import {requireDiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';
import {createBrowserDiagnosticsTransport} from '@app/utils/browserDiagnosticsTransport';

const RECORD = requireDiagnosticRecord({
    schemaVersion: 1,
    eventId: 'fedcba9876543210fedcba9876543210',
    code: 'UNCLASSIFIED_CONSOLE_ERROR',
    severity: 'error',
    runtime: 'hosted-browser',
    operation: 'console-error',
    occurredAt: 1_735_689_600_000,
    frames: [{
        module: 'app/utils/consoleErrorObserver.ts',
        function: 'observe',
        line: 24,
        column: 5,
    }],
    context: {phase: 'operation'},
});

function setup() {
    const envelopes: unknown[] = [];
    const send = vi.fn((envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve({statusCode: 200});
    });
    const flush = vi.fn(() => Promise.resolve(true));
    const adapter = createBrowserDiagnosticsTransport({
        dsn: 'https://browserkey@o123.ingest.de.sentry.io/456',
        identity: {
            target: 'web',
            release: 'evb-viewer-web@dpl-42',
            dist: 'production',
            environment: 'production',
        },
        makeTransport: () => ({
            send,
            flush,
        } as Transport),
    });
    return {
        adapter,
        envelopes,
        send,
        flush,
    };
}

describe('hosted browser diagnostics transport', () => {
    it('emits no initialization, visibility, flush, or client-report envelope', () => {
        const setupResult = setup();
        expect(setupResult.envelopes).toEqual([]);
        expect(setupResult.flush).not.toHaveBeenCalled();
    });

    it('sends one reconstructed event and no arbitrary fields', async () => {
        const {
            adapter,
            envelopes,
        } = setup();
        expect(await adapter.send(RECORD)).toBe(true);

        expect(envelopes).toHaveLength(1);
        const serialized = JSON.stringify(envelopes[0]);
        expect(serialized).toContain('evb-diagnostic-v1');
        expect(serialized).toContain('ConsoleDiagnosticError');
        expect(serialized).toContain('app/utils/consoleErrorObserver.ts');
        expect(serialized).not.toContain('client_report');
        expect(serialized).not.toContain('cookie');
        const envelope = envelopes[0] as [unknown, unknown[]];
        expect(envelope[1]).toHaveLength(1);
        expect((envelope[1][0] as [{type: string}, unknown])[0]).toEqual({type: 'event'});
    });

    it('rejects malformed records and non-EU DSNs', () => {
        const {
            adapter,
            send,
        } = setup();
        expect(adapter.send({
            ...RECORD,
            user: {email: 'private@example.test'},
        } as never)).toBe(false);
        expect(send).not.toHaveBeenCalled();

        expect(() => createBrowserDiagnosticsTransport({
            dsn: 'https://browserkey@o123.ingest.us.sentry.io/456',
            identity: {
                target: 'web',
                release: 'evb-viewer-web@dpl-42',
                dist: 'production',
                environment: 'production',
            },
        })).toThrow();
    });
});
