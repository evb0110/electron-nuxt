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
    const frameHandles: number[] = [];
    const frameFallbacks: Array<() => void> = [];
    let inputPending = options.inputPending ?? false;
    let now = 0;
    let nextFrameHandle = 0;
    const environment: IContinuationSchedulerEnvironment = {
        isInputPending: () => inputPending,
        now: () => now,
        queueTask: callback => tasks.push(callback),
        queueFrameFallbackTask: callback => frameFallbacks.push(callback),
        requestAnimationFrame: callback => {
            frames.push(callback);
            nextFrameHandle += 1;
            frameHandles.push(nextFrameHandle);
            return nextFrameHandle;
        },
        cancelAnimationFrame: handle => {
            const index = frameHandles.indexOf(handle);
            if (index !== -1) {
                frames.splice(index, 1);
                frameHandles.splice(index, 1);
            }
        },
    };
    return {
        scheduler: createPdfRenderContinuationScheduler(environment),
        flushTask() {
            tasks.shift()?.();
        },
        flushFrame(frameStartedAt = now) {
            frameHandles.shift();
            frames.shift()?.(frameStartedAt);
        },
        flushFrameFallback() {
            frameFallbacks.shift()?.();
        },
        setInputPending(value: boolean) {
            inputPending = value;
        },
        setNow(value: number) {
            now = value;
        },
        frames,
        frameFallbacks,
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
        // Promoting to the task pump cancels the armed background frame.
        expect(harness.frames).toHaveLength(0);
        harness.flushTask();
        expect(events).toEqual(['navigation']);
        expect(harness.frames).toHaveLength(1);
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
        expect(harness.frames).toHaveLength(0);
        harness.flushTask();
        expect(events).toEqual(['visible']);
        expect(harness.frames).toHaveLength(1);
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

    it('drains background work through the timer fallback when frames never fire', () => {
        const harness = createHarness();
        const first = vi.fn();
        const second = vi.fn();
        harness.scheduler.schedule({
            key: 'prefetch:1',
            priority: 'prefetch',
            continueRender: first,
        });
        harness.scheduler.schedule({
            key: 'prefetch:2',
            priority: 'prefetch',
            continueRender: second,
        });

        expect(harness.frames).toHaveLength(1);
        expect(harness.frameFallbacks).toHaveLength(1);
        harness.flushFrameFallback();
        expect(first).toHaveBeenCalledOnce();
        expect(second).not.toHaveBeenCalled();
        harness.flushFrameFallback();
        expect(second).toHaveBeenCalledOnce();
        // Each consumed fallback cancels its paired animation frame, so
        // pending frames never accumulate while frames are suspended.
        expect(harness.frames).toHaveLength(0);
    });

    it('cancels the armed frame when the last queued continuation is cancelled', () => {
        const harness = createHarness();
        const continuation = vi.fn();
        const cancel = harness.scheduler.schedule({
            key: 'prefetch:3',
            priority: 'prefetch',
            continueRender: continuation,
        });

        expect(harness.frames).toHaveLength(1);
        cancel();
        expect(harness.frames).toHaveLength(0);
        harness.flushFrameFallback();
        expect(continuation).not.toHaveBeenCalled();
    });

    it('runs background work through the fallback while input stays pending', () => {
        const harness = createHarness({ inputPending: true });
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'nearby:2',
            priority: 'nearby',
            continueRender: continuation,
        });

        harness.flushFrame();
        expect(continuation).not.toHaveBeenCalled();
        // Deferrals re-arm fresh frame generations but keep the original
        // fallback alive, so the single armed fallback still forces progress.
        expect(harness.frameFallbacks).toHaveLength(1);
        harness.flushFrameFallback();
        expect(continuation).toHaveBeenCalledOnce();
    });

    it('forces starved background work after the frame deferral limit', () => {
        const harness = createHarness({ inputPending: true });
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'nearby:5',
            priority: 'nearby',
            continueRender: continuation,
        });

        for (let deferral = 0; deferral < 4; deferral += 1) {
            harness.flushFrame();
            expect(continuation).not.toHaveBeenCalled();
        }
        harness.flushFrame();
        expect(continuation).toHaveBeenCalledOnce();
    });

    it('recovers background work when every frame arrives over budget', () => {
        const harness = createHarness();
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'prefetch:9',
            priority: 'prefetch',
            continueRender: continuation,
        });

        harness.setNow(12);
        harness.flushFrame(0);
        harness.setNow(24);
        harness.flushFrame(12);
        expect(continuation).not.toHaveBeenCalled();
        expect(harness.frameFallbacks).toHaveLength(1);
        harness.flushFrameFallback();
        expect(continuation).toHaveBeenCalledOnce();
    });

    it('ignores the fallback once the frame pump already ran its generation', () => {
        const harness = createHarness();
        const continuation = vi.fn();
        harness.scheduler.schedule({
            key: 'thumbnail:4',
            priority: 'thumbnail',
            continueRender: continuation,
        });

        harness.flushFrame();
        expect(continuation).toHaveBeenCalledOnce();
        harness.flushFrameFallback();
        expect(continuation).toHaveBeenCalledOnce();
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
