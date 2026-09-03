import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createRendererFailureReporter,
    type IRendererFailureReporter,
} from '@app/utils/failureReporter';
import {
    installConsoleErrorObserver,
    type IConsoleErrorTarget,
} from '@app/utils/consoleErrorObserver';
import {parseDiagnosticEventId} from '@contracts/diagnostics/diagnosticEventId';
import type {DiagnosticRecord} from '@contracts/diagnostics/diagnosticRecord';

const SENTINEL = 'console-error-forbidden-sentinel';
const APP_STACK = [
    'Error',
    '    at observedConsoleError (app/utils/consoleErrorObserver.ts:120:9)',
    '    at renderDocument (app/modules/viewer/render.ts:12:4)',
].join('\n');

const cleanups: Array<() => void> = [];

function eventId(value: number) {
    return parseDiagnosticEventId(value.toString(16).padStart(32, '0'))!;
}

function createTarget(rawError: (...args: unknown[]) => unknown = vi.fn()) {
    return {
        rawError,
        target: {error: rawError} satisfies IConsoleErrorTarget,
    };
}

function createReporter(
    sender: (record: DiagnosticRecord) => unknown,
    overrides: Partial<Parameters<typeof createRendererFailureReporter>[0]> = {},
) {
    return createRendererFailureReporter({
        host: 'electron',
        preference: 'granted',
        electronSender: sender,
        createEventId: () => eventId(1),
        ...overrides,
    });
}

function installForTest(
    target: IConsoleErrorTarget,
    reporter: IRendererFailureReporter,
    stack = APP_STACK,
) {
    const handle = installConsoleErrorObserver({
        target,
        reporter,
        runtime: 'electron-renderer',
        captureStack: () => stack,
    });
    cleanups.push(handle.cleanup);
    return handle;
}

afterEach(() => {
    while (cleanups.length > 0) {
        cleanups.pop()?.();
    }
});
describe('console error observer', () => {
    it('forwards console behavior but sends only the code and canonical app frames', () => {
        const rawError = vi.fn();
        const {target} = createTarget(rawError);
        const sent: DiagnosticRecord[] = [];
        const localDetails: unknown[] = [];
        const reporter = createReporter(
            record => sent.push(record),
            {localSink: detail => localDetails.push(detail)},
        );
        installForTest(target, reporter);

        const forbiddenArgument = Object.create(null) as Record<string, unknown>;
        Object.defineProperty(forbiddenArgument, 'message', {get() {
            throw new Error('console argument was inspected');
        }});
        Object.defineProperty(forbiddenArgument, 'toJSON', {get() {
            throw new Error('console argument was formatted');
        }});

        target.error(SENTINEL, forbiddenArgument);

        expect(rawError).toHaveBeenCalledOnce();
        expect(sent).toHaveLength(1);
        expect(sent[0]).toEqual(expect.objectContaining({
            code: 'UNCLASSIFIED_CONSOLE_ERROR',
            operation: 'console-error',
            runtime: 'electron-renderer',
            context: {},
        }));
        expect(sent[0]?.frames).toEqual([{
            module: 'app/modules/viewer/render.ts',
            function: 'renderDocument',
            line: 12,
            column: 4,
        }]);
        expect(JSON.stringify(sent[0])).not.toContain(SENTINEL);
        expect(JSON.stringify(localDetails)).not.toContain(SENTINEL);
    });

    it.each([
        [
            'extension',
            'Error\n    at injected (chrome-extension://abcdef/content.js:1:1)',
        ],
        [
            'DevTools',
            'Error\n    at inspector (devtools://devtools/bundled/inspector.js:2:3)',
        ],
        [
            'vendor-only',
            'Error\n    at thirdParty (https://cdn.example.invalid/vendor.js:4:5)',
        ],
    ])('drops a %s-only stack and increments frameless-dropped', (_name, stack) => {
        const {target} = createTarget();
        const sender = vi.fn();
        const reporter = createReporter(sender);
        const observer = installForTest(target, reporter, stack);

        target.error(SENTINEL);

        expect(sender).not.toHaveBeenCalled();
        expect(observer.getHealthSnapshot()).toEqual({framelessDropped: 1});
        expect(reporter.getHealthSnapshot()).toMatchObject({attempted: 0});
    });

    it('does not create a second occurrence when transport code calls console.error', () => {
        const rawError = vi.fn();
        const {target} = createTarget(rawError);
        const sender = vi.fn(() => {
            target.error('transport failure should stay outside the observer');
        });
        const reporter = createReporter(sender);
        installForTest(target, reporter);

        target.error('outer console failure');

        expect(sender).toHaveBeenCalledOnce();
        expect(rawError).toHaveBeenCalledTimes(2);
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            accepted: 1,
        });
    });

    it('lets the shared reporter count a suppression-scope call as owned-projection', () => {
        const {target} = createTarget();
        const sender = vi.fn();
        const reporter = createReporter(sender);
        installForTest(target, reporter);

        reporter.withSuppressedCapture(() => target.error('inherited projection'));

        expect(sender).not.toHaveBeenCalled();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 0,
            ownedProjection: 1,
            lastDropReason: 'owned-projection',
        });
    });

    it('never throws when either the original sink or reporter fails', () => {
        const rawError = vi.fn(() => {
            throw new Error('raw console sink failed');
        });
        const {target} = createTarget(rawError);
        const reporter = createReporter(() => {
            throw new Error('diagnostics transport failed');
        });
        installForTest(target, reporter);

        expect(() => target.error(SENTINEL)).not.toThrow();
        expect(reporter.getHealthSnapshot()).toMatchObject({
            attempted: 1,
            transportFailed: 1,
        });
    });

    it('is idempotent and restores the original console method on cleanup', () => {
        const rawError = vi.fn();
        const {target} = createTarget(rawError);
        const sender = vi.fn();
        const reporter = createReporter(sender);
        const first = installForTest(target, reporter);
        const second = installConsoleErrorObserver({
            target,
            reporter,
            runtime: 'electron-renderer',
            captureStack: () => APP_STACK,
        });

        expect(second).toBe(first);
        target.error(SENTINEL);
        expect(sender).toHaveBeenCalledOnce();

        first.cleanup();
        expect(target.error).toBe(rawError);
    });
});
