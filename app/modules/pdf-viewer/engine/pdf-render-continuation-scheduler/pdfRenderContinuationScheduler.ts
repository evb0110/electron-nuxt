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
    isInputPending: () => boolean;
    now: () => number;
    queueTask: (callback: () => void) => void;
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
const FOREGROUND_CONTINUATION_DELAY_MS = 16;

interface IQueuedContinuation extends IContinuationRequest {
    sequence: number;
    removeAbortListener: () => void;
}

function isBackgroundPriority(priority: TPdfRenderContinuationPriority) {
    return PRIORITY_WEIGHT[priority] <= PRIORITY_WEIGHT.nearby;
}

function createDefaultEnvironment(): IContinuationSchedulerEnvironment {
    const scheduling = typeof navigator === 'undefined'
        ? null
        : (navigator as Navigator & {scheduling?: { isInputPending?: () => boolean };}).scheduling;
    return {
        isInputPending: () => scheduling?.isInputPending?.() === true,
        now: () => performance.now(),
        queueTask: callback => setTimeout(callback, FOREGROUND_CONTINUATION_DELAY_MS),
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
    let scheduledPump: 'frame' | 'task' | null = null;
    let pumpGeneration = 0;

    function removeQueued(key: string) {
        const queued = queuedByKey.get(key);
        if (!queued) {
            return false;
        }
        queued.removeAbortListener();
        queuedByKey.delete(key);
        return true;
    }

    function cancel(key: string) {
        if (removeQueued(key)) {
            scheduleNextPump();
        }
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
        if (queuedByKey.size === 0) {
            scheduledPump = null;
            pumpGeneration += 1;
            return;
        }
        const highestPriority = [...queuedByKey.values()].reduce(
            (highest, item) => Math.max(highest, PRIORITY_WEIGHT[item.priority]),
            0,
        );
        // Occluded Electron renderers can throttle animation frames to roughly
        // 1 Hz. Keep serialized foreground work on yielding host tasks and
        // reserve frame gating for nearby/background work.
        const useFrame = highestPriority <= PRIORITY_WEIGHT.nearby;
        const nextPump = useFrame ? 'frame' : 'task';
        if (scheduledPump === nextPump) {
            return;
        }
        scheduledPump = nextPump;
        pumpGeneration += 1;
        const generation = pumpGeneration;
        if (useFrame) {
            environment.requestAnimationFrame(timestamp => runFramePump(timestamp, generation));
        } else {
            environment.queueTask(() => runImmediatePump(generation));
        }
    }

    function claimPump(pump: 'frame' | 'task', generation: number) {
        if (scheduledPump !== pump || pumpGeneration !== generation) {
            return false;
        }
        scheduledPump = null;
        return true;
    }

    function runImmediatePump(generation?: number) {
        if (generation !== undefined && !claimPump('task', generation)) {
            return;
        }
        const next = takeNext();
        if (next && next.signal?.aborted !== true) {
            next.continueRender();
        }
        scheduleNextPump();
    }

    function runFramePump(frameStartedAt: number, generation: number) {
        if (!claimPump('frame', generation)) {
            return;
        }
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
        const replacedQueuedRequest = removeQueued(request.key);
        if (request.signal?.aborted === true) {
            if (replacedQueuedRequest) {
                scheduleNextPump();
            }
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
            removeQueued(key);
        }
        scheduleNextPump();
    }

    return {
        schedule,
        cancel,
        clear,
    };
}

export const pdfRenderContinuationScheduler = createPdfRenderContinuationScheduler();
