import { getPerformanceProfile } from '@app/utils/performanceProfile';

export type TPdfRenderContinuationPriority =
    | 'navigation-target'
    | 'visible'
    | 'visible-text'
    | 'nearby'
    | 'thumbnail'
    | 'prefetch';

interface IContinuationRequest {
    key: string;
    priority: TPdfRenderContinuationPriority;
    continueRender: () => void;
    signal?: AbortSignal | undefined;
}

export interface IContinuationSchedulerEnvironment {
    constrained: boolean;
    isInputPending: () => boolean;
    now: () => number;
    queueMicrotask: (callback: () => void) => void;
    requestAnimationFrame: (callback: (timestamp: number) => void) => number;
}

export interface IPdfRenderContinuationScheduler {
    schedule: (request: IContinuationRequest) => () => void;
    cancel: (key: string) => void;
    clear: () => void;
}

const PRIORITY_WEIGHT: Record<TPdfRenderContinuationPriority, number> = {
    'navigation-target': 600,
    'visible': 500,
    'visible-text': 400,
    'nearby': 300,
    'thumbnail': 200,
    'prefetch': 100,
};
const FRAME_HEADROOM_BUDGET_MS = 8;

interface IQueuedContinuation extends IContinuationRequest {
    sequence: number;
    removeAbortListener: () => void;
}

function isBackgroundPriority(priority: TPdfRenderContinuationPriority) {
    return PRIORITY_WEIGHT[priority] <= PRIORITY_WEIGHT.nearby;
}

function createDefaultEnvironment(): IContinuationSchedulerEnvironment {
    const profile = getPerformanceProfile();
    const scheduling = typeof navigator === 'undefined'
        ? null
        : (navigator as Navigator & {scheduling?: { isInputPending?: () => boolean };}).scheduling;
    return {
        constrained: profile.lowCpu || profile.lowMemory || profile.concurrentPdfRenders <= 2,
        isInputPending: () => scheduling?.isInputPending?.() === true,
        now: () => performance.now(),
        queueMicrotask: callback => queueMicrotask(callback),
        requestAnimationFrame: callback => (
            typeof window === 'undefined'
                ? Number(setTimeout(() => callback(performance.now()), 0))
                : window.requestAnimationFrame(callback)
        ),
    };
}

export function createPdfRenderContinuationScheduler(
    environment: IContinuationSchedulerEnvironment = createDefaultEnvironment(),
): IPdfRenderContinuationScheduler {
    const queuedByKey = new Map<string, IQueuedContinuation>();
    let nextSequence = 0;
    let pumpScheduled = false;

    function cancel(key: string) {
        const queued = queuedByKey.get(key);
        if (!queued) {
            return;
        }
        queued.removeAbortListener();
        queuedByKey.delete(key);
    }

    function takeNext() {
        const next = [...queuedByKey.values()].sort((left, right) => (
            PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
            || left.sequence - right.sequence
        ))[0];
        if (!next) {
            return null;
        }
        queuedByKey.delete(next.key);
        next.removeAbortListener();
        return next;
    }

    function scheduleNextPump() {
        if (pumpScheduled || queuedByKey.size === 0) {
            return;
        }
        pumpScheduled = true;
        const highestPriority = [...queuedByKey.values()].reduce(
            (highest, item) => Math.max(highest, PRIORITY_WEIGHT[item.priority]),
            0,
        );
        const useFrame = environment.constrained
            || highestPriority <= PRIORITY_WEIGHT.nearby;
        if (useFrame) {
            environment.requestAnimationFrame(runFramePump);
        } else {
            environment.queueMicrotask(runImmediatePump);
        }
    }

    function runImmediatePump() {
        pumpScheduled = false;
        const next = takeNext();
        if (next && next.signal?.aborted !== true) {
            next.continueRender();
        }
        scheduleNextPump();
    }

    function runFramePump(frameStartedAt: number) {
        pumpScheduled = false;
        const next = [...queuedByKey.values()].sort((left, right) => (
            PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
            || left.sequence - right.sequence
        ))[0];
        if (
            next
            && isBackgroundPriority(next.priority)
            && (environment.isInputPending() || environment.now() - frameStartedAt >= FRAME_HEADROOM_BUDGET_MS)
        ) {
            scheduleNextPump();
            return;
        }
        runImmediatePump();
    }

    function schedule(request: IContinuationRequest) {
        cancel(request.key);
        if (request.signal?.aborted === true) {
            return () => {};
        }
        const onAbort = () => cancel(request.key);
        request.signal?.addEventListener('abort', onAbort, { once: true });
        queuedByKey.set(request.key, {
            ...request,
            sequence: nextSequence,
            removeAbortListener: () => request.signal?.removeEventListener('abort', onAbort),
        });
        nextSequence += 1;
        scheduleNextPump();
        return () => cancel(request.key);
    }

    function clear() {
        for (const key of [...queuedByKey.keys()]) {
            cancel(key);
        }
    }

    return {
        schedule,
        cancel,
        clear,
    };
}

export const pdfRenderContinuationScheduler = createPdfRenderContinuationScheduler();
