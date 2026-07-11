import {
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import {
    createPdfRenderContinuationScheduler,
    type IContinuationSchedulerEnvironment,
} from '@app/modules/pdf-viewer/engine/pdf-render-continuation-scheduler/pdfRenderContinuationScheduler';

function createHarness(options: {
    constrained?: boolean;
    inputPending?: boolean;
} = {}) {
    const microtasks: Array<() => void> = [];
    const frames: Array<(timestamp: number) => void> = [];
    let inputPending = options.inputPending ?? false;
    let now = 0;
    const environment: IContinuationSchedulerEnvironment = {
        constrained: options.constrained ?? false,
        isInputPending: () => inputPending,
        now: () => now,
        queueMicrotask: callback => microtasks.push(callback),
        requestAnimationFrame: callback => {
            frames.push(callback);
            return frames.length;
        },
    };
    return {
        scheduler: createPdfRenderContinuationScheduler(environment),
        flushMicrotask() {
            microtasks.shift()?.();
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
        microtasks,
    };
}

describe('PDF render continuation scheduler', () => {
    it('serializes constrained paints and runs navigation before queued background work', () => {
        const harness = createHarness({ constrained: true });
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

        expect(harness.frames).toHaveLength(1);
        harness.flushFrame();
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

    it('runs high-priority work immediately on capable systems and deduplicates keys', () => {
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

        expect(harness.microtasks).toHaveLength(1);
        harness.flushMicrotask();
        expect(stale).not.toHaveBeenCalled();
        expect(current).toHaveBeenCalledOnce();
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
