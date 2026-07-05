import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import { createIpcProgressPump } from '@electron/utils/createIpcProgressPump';

interface ITestProgress {
    requestId: string;
    phase: 'active' | 'complete';
    value: number;
}

describe('createIpcProgressPump replay', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('replays latest active progress state to a late subscriber', () => {
        const primarySend = vi.fn();
        const lateSend = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => ({send: primarySend}),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
            intervalMs: 100,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'active',
            value: 1,
        });
        pump.enqueue({
            requestId: 'operation-a',
            phase: 'active',
            value: 2,
        });
        pump.enqueue({
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });

        pump.subscribe({send: lateSend});

        expect(lateSend).toHaveBeenCalledTimes(2);
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'active',
            value: 2,
        });
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        lateSend.mockClear();

        pump.subscribe({send: lateSend});

        expect(lateSend).toHaveBeenCalledTimes(2);
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-b',
            phase: 'active',
            value: 7,
        });
        pump.clear();
    });

    it('retains terminal progress for the configured replay TTL', () => {
        vi.useFakeTimers();
        const primarySend = vi.fn();
        const lateSend = vi.fn();
        const onIdle = vi.fn();
        const pump = createIpcProgressPump<ITestProgress>({
            channel: 'test:progress',
            getTarget: () => ({send: primarySend}),
            getKey: progress => progress.requestId,
            isTerminal: progress => progress.phase === 'complete',
            terminalRetentionMs: 30_000,
            onIdle,
        });

        pump.enqueue({
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });
        pump.clear();

        pump.subscribe({send: lateSend});
        expect(lateSend).toHaveBeenCalledWith('test:progress', {
            requestId: 'operation-a',
            phase: 'complete',
            value: 100,
        });

        lateSend.mockClear();
        vi.advanceTimersByTime(30_000);
        pump.subscribe({send: lateSend});

        expect(lateSend).not.toHaveBeenCalled();
        expect(onIdle).toHaveBeenCalled();
    });
});
