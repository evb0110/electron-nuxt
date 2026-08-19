import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    configureProcessSafeMode,
    createProcessDeathRecovery,
    PROCESS_SAFE_MODE_ARGUMENT,
} from '@electron/processDeathRecovery';
import {
    createShutdownCoordinator,
    type IShutdownContext,
} from '@electron/bootstrap/shutdown';

function createFixture(argv = ['/app/evb-viewer']) {
    const app = {commandLine: {appendSwitch: vi.fn()}};
    const logger = {
        error: vi.fn(),
        warn: vi.fn(),
    };
    const requestSafeModeRelaunch = vi.fn();
    return {
        app,
        argv,
        logger,
        recovery: createProcessDeathRecovery({
            argv,
            logger,
            requestSafeModeRelaunch,
        }),
        requestSafeModeRelaunch,
    };
}

describe('processDeathRecovery', () => {
    it('enables software rendering before startup when relaunched in safe mode', () => {
        const fixture = createFixture([
            '/app/evb-viewer',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);

        expect(configureProcessSafeMode(fixture.app, fixture.argv)).toBe(true);
        expect(fixture.app.commandLine.appendSwitch).toHaveBeenCalledWith('disable-gpu');
    });

    it('relaunches in safe mode after two GPU crashes in the rolling window', () => {
        const fixture = createFixture([
            '/app/evb-viewer',
            '--document',
            '/tmp/a.pdf',
        ]);
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('logged');
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch');

        expect(fixture.requestSafeModeRelaunch).toHaveBeenCalledWith([
            '--document',
            '/tmp/a.pdf',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);
    });

    it('does not enter a relaunch loop when the GPU fails in safe mode', () => {
        const fixture = createFixture([
            '/app/evb-viewer',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]);
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        fixture.recovery.handleChildProcessGone(details);
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-failed');
        expect(fixture.requestSafeModeRelaunch).not.toHaveBeenCalled();
    });

    it('requests at most one coordinated relaunch after repeated GPU crashes', () => {
        const fixture = createFixture();
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        fixture.recovery.handleChildProcessGone(details);
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch');
        expect(fixture.recovery.handleChildProcessGone(details).action).toBe('safe-mode-relaunch-pending');
        expect(fixture.requestSafeModeRelaunch).toHaveBeenCalledOnce();
    });

    it('orders the safe-mode relaunch after coordinated cleanup', async () => {
        const cleanup = createDeferred();
        const app = {
            commandLine: {appendSwitch: vi.fn()},
            exit: vi.fn(),
            quit: vi.fn(),
            relaunch: vi.fn(),
        };
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };
        let observedContext: IShutdownContext | null = null;
        const coordinator = createShutdownCoordinator({
            app,
            logger,
            runBestEffortCleanupSteps: vi.fn(async () => {}),
            runPreservationSteps: context => {
                observedContext = context;
                return cleanup.promise;
            },
        });
        const recovery = createProcessDeathRecovery({
            argv: ['/app/evb-viewer'],
            logger,
            requestSafeModeRelaunch: args => coordinator.requestGracefulQuit({
                afterCleanup: () => {
                    app.relaunch({args});
                    app.quit();
                },
                preserveRecoveryState: true,
                reason: 'recovery-relaunch',
            }),
        });
        const details = {
            type: 'GPU',
            reason: 'crashed',
            exitCode: 9,
        };

        recovery.handleChildProcessGone(details);
        recovery.handleChildProcessGone(details);
        await vi.waitFor(() => {
            expect(observedContext).toMatchObject({
                preserveRecoveryState: true,
                reason: 'recovery-relaunch',
            });
        });
        expect(app.relaunch).not.toHaveBeenCalled();
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();

        cleanup.resolve();
        await vi.waitFor(() => {
            expect(app.relaunch).toHaveBeenCalledWith({args: [PROCESS_SAFE_MODE_ARGUMENT]});
            expect(app.quit).toHaveBeenCalledOnce();
        });
        expect(app.exit).not.toHaveBeenCalled();
    });
});

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((promiseResolve) => {
        resolve = promiseResolve;
    });
    return {
        promise,
        resolve,
    };
}
