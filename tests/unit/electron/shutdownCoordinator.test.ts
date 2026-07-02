import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createShutdownCoordinator } from '@electron/bootstrap/shutdown';

function createDeferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    return {
        promise,
        reject,
        resolve,
    };
}

describe('shutdown coordinator', () => {
    it('runs update installation only after graceful cleanup has completed', async () => {
        const cleanup = createDeferred();
        const app = {
            exit: vi.fn(),
            quit: vi.fn(),
        };
        const logger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
        };
        const install = vi.fn();
        const coordinator = createShutdownCoordinator({
            app,
            logger,
            runCleanupSteps: () => cleanup.promise,
        });

        coordinator.requestGracefulQuit({afterCleanup: install});
        await Promise.resolve();

        expect(install).not.toHaveBeenCalled();
        expect(app.quit).not.toHaveBeenCalled();
        expect(coordinator.isQuittingAfterCleanup()).toBe(false);

        cleanup.resolve();

        await vi.waitFor(() => {
            expect(coordinator.isQuittingAfterCleanup()).toBe(true);
            expect(install).toHaveBeenCalledOnce();
        });
        expect(app.quit).not.toHaveBeenCalled();
        expect(app.exit).not.toHaveBeenCalled();
    });
});
