import {
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    guardAsync,
    runGuardedTask,
} from '@app/utils/asyncGuard';

const loggerSpies = vi.hoisted(() => ({
    error: vi.fn(),
    debug: vi.fn(),
    diagnostic: vi.fn(),
    diagnosticThrottled: vi.fn(),
    warn: vi.fn(),
}));

vi.mock('@app/utils/browserLogger', () => ({ BrowserLogger: loggerSpies }));

describe('asyncGuard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('logs rejected promises', async () => {
        guardAsync(Promise.reject(new Error('boom')), {
            scope: 'test-scope',
            message: 'Failed to run task',
        });

        await Promise.resolve();

        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({ message: 'boom' }),
        );
    });

    it('logs synchronous throws in runGuardedTask', () => {
        runGuardedTask(
            () => {
                throw new Error('sync boom');
            },
            {
                scope: 'test-scope',
                message: 'Failed to run task',
            },
        );

        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledWith(
            'test-scope',
            'Failed to run task',
            expect.objectContaining({ message: 'sync boom' }),
        );
    });

    it('runs onError callback before logging', async () => {
        const onError = vi.fn();
        const observed: string[] = [];
        onError.mockImplementation(() => {
            observed.push('onError');
        });
        loggerSpies.error.mockImplementation(() => {
            observed.push('logger');
        });

        guardAsync(Promise.reject(new Error('boom')), {
            scope: 'test-scope',
            message: 'Failed to run task',
            onError,
        });

        await Promise.resolve();

        expect(onError).toHaveBeenCalledTimes(1);
        expect(loggerSpies.error).toHaveBeenCalledTimes(1);
        expect(onError.mock.invocationCallOrder[0]).toBeLessThan(loggerSpies.error.mock.invocationCallOrder[0]!);
        expect(observed).toEqual([
            'onError',
            'logger',
        ]);
    });
});
