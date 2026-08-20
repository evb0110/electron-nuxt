import {
    afterEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfRenderContinuationScheduler,
    type IContinuationSchedulerEnvironment,
} from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';

function createHarness(options: {inputPending?: boolean} = {}) {
    const tasks: Array<() => void> = [];
    const frames: Array<(timestamp: number) => void> = [];
    let inputPending = options.inputPending ?? false;
    let now = 0;
    const environment: IContinuationSchedulerEnvironment = {
        isInputPending: () => inputPending,
        now: () => now,
        queueTask: callback => tasks.push(callback),
        requestAnimationFrame: callback => {
            frames.push(callback);
            return frames.length;
        },
    };
    return {
        scheduler: createPdfRenderContinuationScheduler(environment),
        flushTask() {
            tasks.shift()?.();
        },
        flushFrame(frameStartedAt = now) {
            frames.shift()?.(frameStartedAt);
        },
        setInputPending(value: boolean) {
            inputPending = value;
        },
        setNow(value: number) {
            now = value;
        },
        frames,
        tasks,
    };
}

describe('PDF render continuation scheduler', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('runs recursive foreground slices in separate 16 ms timer quanta', () => {
        vi.useFakeTimers();
        const postTask = vi.fn();
        vi.stubGlobal('scheduler', { postTask });
        const scheduler = createPdfRenderContinuationScheduler();
        const continuation = vi.fn();
        const scheduleSlice = () => scheduler.schedule({
            key: 'viewer:1',
            priority: 'visible',
            continueRender: () => {
                continuation();
                if (continuation.mock.calls.length < 2) {
                    scheduleSlice();
                }
            },
        });

        scheduleSlice();

        expect(postTask).not.toHaveBeenCalled();
        vi.advanceTimersByTime(15);
        expect(continuation).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(continuation).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(15);
        expect(continuation).toHaveBeenCalledOnce();
        vi.advanceTimersByTime(1);
        expect(continuation).toHaveBeenCalledTimes(2);
    });

    it('serializes paints and runs navigation from a host task before queued background work', () => {
        const harness = createHarness();
        const events: string[] = [];
        harness.scheduler.schedule({
            key: 'prefetch:2',
            priority: 'prefetch',
            continueRender: () => events.push('prefetch'),
        });
        harness.scheduler.schedule({
            key: 'navigation:8',
            priority: 'navigation-target',
            continueRender: () => events.push('navigation'),
        });

        expect(harness.tasks).toHaveLength(1);
        expect(harness.frames).toHaveLength(1);
        harness.flushTask();
        expect(events).toEqual(['navigation']);
        expect(harness.frames).toHaveLength(2);
        harness.flushFrame();
        expect(events).toEqual(['navigation']);
        harness.flushFrame();
        expect(events).toEqual([
            'navigation',
            'prefetch',
        ]);
    });

    it('gates background continuations while input is pending', () => {
        const harness = createHarness({ inputPending: true });
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'nearby:2',
            priority: 'nearby',
            continueRender: continuation,
        });

        harness.flushFrame();
        expect(continuation).not.toHaveBeenCalled();
        expect(harness.frames).toHaveLength(1);

        harness.setInputPending(false);
        harness.flushFrame();
        expect(continuation).toHaveBeenCalledOnce();
    });

    it('runs visible work from a host task without a frame and deduplicates keys', async () => {
        const harness = createHarness();
        const stale = vi.fn();
        const current = vi.fn();
        harness.scheduler.schedule({
            key: 'viewer:1',
            priority: 'visible',
            continueRender: stale,
        });
        harness.scheduler.schedule({
            key: 'viewer:1',
            priority: 'navigation-target',
            continueRender: current,
        });

        expect(harness.tasks).toHaveLength(1);
        expect(harness.frames).toHaveLength(0);
        await Promise.resolve();
        expect(stale).not.toHaveBeenCalled();
        expect(current).not.toHaveBeenCalled();
        harness.flushTask();
        expect(stale).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
    });

    it('yields between recursive visible continuations', () => {
        const harness = createHarness();
        const events: string[] = [];
        harness.scheduler.schedule({
            key: 'viewer:1',
            priority: 'visible',
            continueRender: () => {
                events.push('first');
                harness.scheduler.schedule({
                    key: 'viewer:1',
                    priority: 'visible',
                    continueRender: () => events.push('second'),
                });
            },
        });

        harness.flushTask();
        expect(events).toEqual(['first']);
        expect(harness.tasks).toHaveLength(1);
        harness.flushTask();
        expect(events).toEqual([
            'first',
            'second',
        ]);
    });

    it('promotes visible work out of an already queued background frame', () => {
        const harness = createHarness();
        const events: string[] = [];
        harness.scheduler.schedule({
            key: 'prefetch:2',
            priority: 'prefetch',
            continueRender: () => events.push('prefetch'),
        });
        harness.scheduler.schedule({
            key: 'viewer:1',
            priority: 'visible',
            continueRender: () => events.push('visible'),
        });

        expect(harness.tasks).toHaveLength(1);
        harness.flushTask();
        expect(events).toEqual(['visible']);
        expect(harness.frames).toHaveLength(2);
        harness.flushFrame();
        expect(events).toEqual(['visible']);
        harness.flushFrame();
        expect(events).toEqual([
            'visible',
            'prefetch',
        ]);
    });

    it('cancels visible work without consuming a frame', () => {
        const harness = createHarness();
        const continuation = vi.fn();
        const cancel = harness.scheduler.schedule({
            key: 'viewer:1',
            priority: 'navigation-target',
            continueRender: continuation,
        });

        cancel();
        harness.flushTask();
        expect(continuation).not.toHaveBeenCalled();
        expect(harness.frames).toHaveLength(0);
    });

    it('defers background work after the frame headroom is consumed', () => {
        const harness = createHarness();
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'thumbnail:4',
            priority: 'thumbnail',
            continueRender: continuation,
        });
        harness.setNow(12);
        harness.flushFrame(0);
        expect(continuation).not.toHaveBeenCalled();

        harness.setNow(13);
        harness.flushFrame();
        expect(continuation).toHaveBeenCalledOnce();
    });
});
