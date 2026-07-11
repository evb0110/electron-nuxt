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

function createFixture(argv = ['/app/evb-viewer']) {
    const app = {
        commandLine: {appendSwitch: vi.fn()},
        exit: vi.fn(),
        relaunch: vi.fn(),
    };
    const logger = {
        error: vi.fn(),
        warn: vi.fn(),
    };
    return {
        app,
        argv,
        logger,
        recovery: createProcessDeathRecovery({
            app,
            argv,
            logger,
        }),
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

        expect(fixture.app.relaunch).toHaveBeenCalledWith({args: [
            '--document',
            '/tmp/a.pdf',
            PROCESS_SAFE_MODE_ARGUMENT,
        ]});
        expect(fixture.app.exit).toHaveBeenCalledWith(0);
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
        expect(fixture.app.relaunch).not.toHaveBeenCalled();
    });
});
