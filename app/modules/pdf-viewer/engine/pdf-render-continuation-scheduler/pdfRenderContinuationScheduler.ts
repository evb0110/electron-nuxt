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
    queueFrameFallbackTask: (callback: () => void) => void;
    requestAnimationFrame: (callback: (timestamp: number) => void) => number;
    cancelAnimationFrame: (handle: number) => void;
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
// Hidden Electron renderers suspend animation frames entirely, so a
// frame-gated pump must not be the only path to progress: without a timer
// fallback a background-only queue starves forever and the pdf.js render
// tasks waiting on those continuations never settle.
const BACKGROUND_FRAME_FALLBACK_DELAY_MS = 250;
// Frames can also fire while never having headroom: when visible-page paints
// consume the budget on every frame, the headroom gate defers background work
// on each of them and pdf.js render tasks stall without any frame suspension.
// Cap consecutive deferrals so a queued continuation runs within a bounded
// number of frames regardless of load.
const FRAME_DEFERRAL_LIMIT = 4;

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
        queueFrameFallbackTask: callback => setTimeout(callback, BACKGROUND_FRAME_FALLBACK_DELAY_MS),
        requestAnimationFrame: callback => (
            typeof window === 'undefined'
                ? Number(setTimeout(() => callback(performance.now()), 0))
                : window.requestAnimationFrame(callback)
        ),
        cancelAnimationFrame: handle => (
            typeof window === 'undefined'
                ? clearTimeout(handle)
                : window.cancelAnimationFrame(handle)
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
    let armedFrameHandle: number | null = null;
    let frameFallbackEpoch = 0;
    let frameFallbackArmed = false;
    let consecutiveFrameDeferrals = 0;

    function cancelArmedFrame() {
        if (armedFrameHandle !== null) {
            environment.cancelAnimationFrame(armedFrameHandle);
            armedFrameHandle = null;
        }
    }

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
            // Cancelling (not just generation-invalidating) the armed frame
            // keeps pending rAF callbacks from accumulating in renderers whose
            // frames are suspended and would otherwise flush all at once.
            cancelArmedFrame();
            scheduledPump = null;
            pumpGeneration += 1;
            frameFallbackEpoch += 1;
            frameFallbackArmed = false;
            consecutiveFrameDeferrals = 0;
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
        cancelArmedFrame();
        scheduledPump = nextPump;
        pumpGeneration += 1;
        const generation = pumpGeneration;
        if (useFrame) {
            armedFrameHandle = environment.requestAnimationFrame(
                timestamp => runFramePump(timestamp, generation),
            );
            // The fallback is keyed to an epoch instead of the pump generation:
            // every headroom deferral re-arms a fresh generation, so a
            // generation-keyed fallback goes stale before it can fire whenever
            // frames keep firing and deferring.
            if (!frameFallbackArmed) {
                frameFallbackArmed = true;
                frameFallbackEpoch += 1;
                const epoch = frameFallbackEpoch;
                environment.queueFrameFallbackTask(() => runFrameFallbackPump(epoch));
            }
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
        consecutiveFrameDeferrals = 0;
        const next = takeNext();
        if (next && next.signal?.aborted !== true) {
            next.continueRender();
        }
        scheduleNextPump();
    }

    // Runs when the frame pump made no progress for a whole fallback period,
    // either because the armed frame never fired (hidden renderer) or because
    // every frame deferred; forcing one immediate pump keeps pdf.js render
    // tasks live in both cases.
    function runFrameFallbackPump(epoch: number) {
        if (epoch !== frameFallbackEpoch) {
            return;
        }
        frameFallbackArmed = false;
        if (scheduledPump !== 'frame') {
            return;
        }
        // Claim whatever frame generation is currently armed instead of a
        // specific one: a generation-checked claim is exactly what let the
        // fallback go stale while frames fired and deferred. Cancelling the
        // armed frame before pumping keeps the dispatch single.
        scheduledPump = null;
        cancelArmedFrame();
        runImmediatePump();
    }

    function runFramePump(frameStartedAt: number, generation: number) {
        if (!claimPump('frame', generation)) {
            return;
        }
        armedFrameHandle = null;
        const next = [...queuedByKey.values()].sort((left, right) => (
            PRIORITY_WEIGHT[right.priority] - PRIORITY_WEIGHT[left.priority]
            || left.sequence - right.sequence
        ))[0];
        if (
            next
            && isBackgroundPriority(next.priority)
            && consecutiveFrameDeferrals < FRAME_DEFERRAL_LIMIT
            && (environment.isInputPending() || environment.now() - frameStartedAt >= FRAME_HEADROOM_BUDGET_MS)
        ) {
            consecutiveFrameDeferrals += 1;
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
