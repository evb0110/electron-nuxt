import {
    describe,
    expect,
    it,
} from 'vitest';
import {
    canTransitionOcrJobLifecycle,
    getOcrWorkerMessageDisposition,
    transitionOcrJobLifecycle,
    type TOcrJobLifecycleState,
} from '@electron/ocr/ocrJobLifecycle';

describe('ocrJobLifecycle', () => {
    it.each([
        [
            'preparing',
            'queued',
        ],
        [
            'preparing',
            'cancelling',
        ],
        [
            'queued',
            'active',
        ],
        [
            'queued',
            'cancelling',
        ],
        [
            'active',
            'cancelling',
        ],
        [
            'active',
            'terminal-result-sent',
        ],
        [
            'terminal-result-sent',
            'finalized',
        ],
        [
            'cancelling',
            'finalized',
        ],
    ] satisfies Array<[TOcrJobLifecycleState, TOcrJobLifecycleState]>)(
        'allows %s -> %s',
        (current, next) => {
            expect(canTransitionOcrJobLifecycle(current, next)).toBe(true);
            expect(transitionOcrJobLifecycle(current, next, 'job-1')).toBe(next);
        },
    );

    it.each([
        [
            'preparing',
            'active',
        ],
        [
            'queued',
            'terminal-result-sent',
        ],
        [
            'active',
            'queued',
        ],
        [
            'terminal-result-sent',
            'active',
        ],
        [
            'finalized',
            'active',
        ],
    ] satisfies Array<[TOcrJobLifecycleState, TOcrJobLifecycleState]>)(
        'rejects %s -> %s',
        (current, next) => {
            expect(canTransitionOcrJobLifecycle(current, next)).toBe(false);
            expect(() => transitionOcrJobLifecycle(current, next, 'job-1'))
                .toThrow('Illegal OCR job lifecycle transition for job-1');
        },
    );

    it('classifies stale worker messages before the manager mutates job state', () => {
        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
        })).toEqual({ accepted: true });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-other',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
        })).toEqual({
            accepted: false,
            reason: 'mismatched-job-id',
        });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: false,
        })).toEqual({
            accepted: false,
            reason: 'inactive-worker',
        });

        expect(getOcrWorkerMessageDisposition({
            incomingJobId: 'job-1',
            expectedRequestId: 'job-1',
            isCurrentWorker: true,
            terminalResultSent: true,
            rejectAfterTerminalResult: true,
        })).toEqual({
            accepted: false,
            reason: 'terminal-result-already-sent',
        });
    });
});
