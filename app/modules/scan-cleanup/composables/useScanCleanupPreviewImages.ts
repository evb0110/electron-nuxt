import type {
    IScanCleanupRawPreviewResult,
    IScanCleanupPreviewResult,
    TScanCleanupOutputHalf,
} from '@contracts/electronApiScanCleanup';
import type {MaybeRefOrGetter} from 'vue';
import {
    consumeScanCleanupPreviewPresentationSettle,
    resolveScanCleanupPreviewPresentationCommit,
    SCAN_CLEANUP_PREVIEW_SETTLE_GRACE_MS,
    type IScanCleanupPreviewPresentationPin,
} from '@app/modules/scan-cleanup/runtime/scanCleanupPreviewPresentationPin';

export interface IScanCleanupDisplayedCleanedFrame<TPresentation> {
    presentation: TPresentation;
    result: IScanCleanupPreviewResult;
}

interface IScanCleanupPendingCleanedFrame<TPresentation> {
    kind: 'forced' | 'initial' | 'settle';
    presentation: TPresentation;
    result: IScanCleanupPreviewResult;
    transitionKey: string;
}

export interface IScanCleanupPreviewImageSwap {
    currentUrl: string;
    entering: boolean;
    incomingUrl: string;
    outgoingUrl: string;
}

export function createPreviewImageSwap(currentUrl = ''): IScanCleanupPreviewImageSwap {
    return {
        currentUrl,
        entering: false,
        incomingUrl: '',
        outgoingUrl: '',
    };
}

export function queuePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
): IScanCleanupPreviewImageSwap {
    if (!state.currentUrl) {
        return createPreviewImageSwap(url);
    }
    if (state.incomingUrl) revoke(state.incomingUrl);
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return {
        currentUrl: state.currentUrl,
        entering: false,
        incomingUrl: url,
        outgoingUrl: '',
    };
}

export function loadPreviewImageSwap(state: IScanCleanupPreviewImageSwap, url: string) {
    if (state.incomingUrl !== url) {
        return state;
    }
    return {
        currentUrl: url,
        entering: true,
        incomingUrl: '',
        outgoingUrl: state.currentUrl,
    };
}

export function completePreviewImageSwap(
    state: IScanCleanupPreviewImageSwap,
    url: string,
    revoke: (url: string) => void,
) {
    if (!state.entering || state.currentUrl !== url) {
        return state;
    }
    if (state.outgoingUrl) revoke(state.outgoingUrl);
    return createPreviewImageSwap(state.currentUrl);
}

function disposePreviewImageSwap(state: IScanCleanupPreviewImageSwap, revoke: (url: string) => void) {
    for (const url of new Set([
        state.currentUrl,
        state.incomingUrl,
        state.outgoingUrl,
    ])) {
        if (url) revoke(url);
    }
}

function pngUrl(bytes: Uint8Array) {
    // Blob already copies what it is handed, so the page-sized copy that used
    // to be made first was pure waste. The branch narrows rather than copies:
    // bytes off the IPC boundary are always ArrayBuffer-backed, and the view
    // shares them.
    const view = bytes.buffer instanceof ArrayBuffer
        ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
        : new Uint8Array(bytes);
    return URL.createObjectURL(new Blob([view], {type: 'image/png'}));
}

export const useScanCleanupPreviewImages = <TPresentation = undefined>(
    result: MaybeRefOrGetter<IScanCleanupPreviewResult | null>,
    onImagesChanged?: (hadPreviousResult: boolean) => void,
    rawResult: MaybeRefOrGetter<IScanCleanupRawPreviewResult | null> = result,
    detailResult: MaybeRefOrGetter<IScanCleanupPreviewResult | null> = () => null,
    captureFramePresentation: () => TPresentation = () => undefined as TPresentation,
    presentationTransitionKey?: MaybeRefOrGetter<string>,
) => {
    const rawPixelSwap = ref(createPreviewImageSwap());
    const cleanedPixelSwaps = reactive<Partial<Record<TScanCleanupOutputHalf, IScanCleanupPreviewImageSwap>>>({});
    const displayedCleanedFrame = shallowRef<IScanCleanupDisplayedCleanedFrame<TPresentation> | null>(null);
    const displayedCleanedFrameCurrent = ref(false);
    const pendingCleanedPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    const detailPixelUrls = reactive<Partial<Record<TScanCleanupOutputHalf, string>>>({});
    let pendingCleanedFrame: IScanCleanupPendingCleanedFrame<TPresentation> | null = null;
    let presentationPin: IScanCleanupPreviewPresentationPin | null = null;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let unscopedFrameGeneration = 0;
    const loadedPendingCleanedUrls = new Set<string>();
    const displayedFrameWaiters: Array<{
        resolve: () => void;
        result: IScanCleanupPreviewResult;
    }> = [];

    function revokeBlobUrl(url: string) {
        URL.revokeObjectURL(url);
    }

    function revokeUrls() {
        clearSettleTimer();
        disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
        rawPixelSwap.value = createPreviewImageSwap();
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
        clearPendingCleanedFrame();
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = detailPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(detailPixelUrls, half);
        }
        for (const waiter of displayedFrameWaiters.splice(0)) waiter.resolve();
    }

    function loadRawPixelSwap(url: string) {
        rawPixelSwap.value = loadPreviewImageSwap(rawPixelSwap.value, url);
    }

    function completeRawPixelSwap(url: string) {
        rawPixelSwap.value = completePreviewImageSwap(rawPixelSwap.value, url, revokeBlobUrl);
    }

    function loadCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        if (pendingCleanedPixelUrls[half] !== url || pendingCleanedFrame === null) {
            return;
        }
        loadedPendingCleanedUrls.add(url);
        if (pendingCleanedFrame.result.outputs.every(output => {
            const pendingUrl = pendingCleanedPixelUrls[output.metadata.half];
            return pendingUrl !== undefined && loadedPendingCleanedUrls.has(pendingUrl);
        })) {
            commitPendingCleanedFrame();
        }
    }

    function completeCleanedPixelSwap(half: TScanCleanupOutputHalf, url: string) {
        const state = cleanedPixelSwaps[half];
        if (state) cleanedPixelSwaps[half] = completePreviewImageSwap(state, url, revokeBlobUrl);
    }

    function clearPendingCleanedFrame() {
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        loadedPendingCleanedUrls.clear();
        pendingCleanedFrame = null;
    }

    function clearSettleTimer() {
        if (settleTimer !== null) clearTimeout(settleTimer);
        settleTimer = null;
    }

    function pendingFrameLoaded() {
        return pendingCleanedFrame?.result.outputs.every(output => {
            const pendingUrl = pendingCleanedPixelUrls[output.metadata.half];
            return pendingUrl !== undefined && loadedPendingCleanedUrls.has(pendingUrl);
        }) ?? false;
    }

    function pendingFrameCanCommit() {
        return pendingCleanedFrame?.kind !== 'settle' || presentationPin?.settleConsumed === true;
    }

    function resolveDisplayedFrameWaiters(result: IScanCleanupPreviewResult) {
        for (let index = displayedFrameWaiters.length - 1; index >= 0; index -= 1) {
            const waiter = displayedFrameWaiters[index];
            if (waiter?.result !== result) continue;
            displayedFrameWaiters.splice(index, 1);
            waiter.resolve();
        }
    }

    function publishCleanedFrame(nextFrame: IScanCleanupPendingCleanedFrame<TPresentation>) {
        const nextResult = nextFrame.result;
        const hadPreviousResult = displayedCleanedFrame.value !== null;
        for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
            const state = cleanedPixelSwaps[half];
            if (state) disposePreviewImageSwap(state, revokeBlobUrl);
            Reflect.deleteProperty(cleanedPixelSwaps, half);
        }
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            const pendingUrl = pendingCleanedPixelUrls[half];
            cleanedPixelSwaps[half] = createPreviewImageSwap(
                pendingUrl ?? pngUrl(output.imageData),
            );
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        for (const half of Object.keys(pendingCleanedPixelUrls) as TScanCleanupOutputHalf[]) {
            const url = pendingCleanedPixelUrls[half];
            if (url) revokeBlobUrl(url);
            Reflect.deleteProperty(pendingCleanedPixelUrls, half);
        }
        displayedCleanedFrame.value = {
            presentation: nextFrame.presentation,
            result: nextResult,
        };
        displayedCleanedFrameCurrent.value = true;
        loadedPendingCleanedUrls.clear();
        pendingCleanedFrame = null;
        resolveDisplayedFrameWaiters(nextResult);
        onImagesChanged?.(hadPreviousResult);
    }

    function commitPendingCleanedFrame() {
        const nextFrame = pendingCleanedFrame;
        if (nextFrame && pendingFrameCanCommit() && pendingFrameLoaded()) {
            publishCleanedFrame(nextFrame);
        }
    }

    function expireSettleWindow() {
        settleTimer = null;
        if (!presentationPin || presentationPin.settleConsumed) {
            return;
        }
        presentationPin = consumeScanCleanupPreviewPresentationSettle(presentationPin);
        commitPendingCleanedFrame();
    }

    function scheduleSettleWindow(pin: IScanCleanupPreviewPresentationPin, arrivedAtMs: number) {
        clearSettleTimer();
        const elapsedMs = Math.max(0, arrivedAtMs - pin.firstFrameArrivalAtMs);
        settleTimer = setTimeout(
            expireSettleWindow,
            Math.max(0, SCAN_CLEANUP_PREVIEW_SETTLE_GRACE_MS - elapsedMs),
        );
    }

    function queueCleanedFrame(nextResult: IScanCleanupPreviewResult, transitionKey: string) {
        const arrivedAtMs = performance.now();
        if (
            presentationPin?.transitionKey === transitionKey
            && !presentationPin.settleConsumed
            && arrivedAtMs - presentationPin.firstFrameArrivalAtMs >= SCAN_CLEANUP_PREVIEW_SETTLE_GRACE_MS
        ) {
            expireSettleWindow();
        }
        // Decide before allocating any blob URLs. Once a key is pinned, later
        // generations are terminally rejected and never enter image preload.
        const decision = resolveScanCleanupPreviewPresentationCommit(
            presentationPin,
            transitionKey,
            arrivedAtMs,
        );
        presentationPin = decision.pin;
        if (decision.action === 'reject') {
            return;
        }
        const supersedesUncommittedInitial = decision.action === 'coalesce'
            && pendingCleanedFrame?.kind === 'initial'
            && pendingCleanedFrame.transitionKey === transitionKey;
        clearPendingCleanedFrame();
        const nextFrame = {
            kind: decision.action === 'commit' || supersedesUncommittedInitial ? 'initial' : 'settle',
            presentation: captureFramePresentation(),
            result: nextResult,
            transitionKey,
        } satisfies IScanCleanupPendingCleanedFrame<TPresentation>;
        if (decision.action === 'commit') {
            scheduleSettleWindow(presentationPin, arrivedAtMs);
        }
        if (!displayedCleanedFrame.value) {
            publishCleanedFrame(nextFrame);
            return;
        }
        pendingCleanedFrame = nextFrame;
        for (const output of nextResult.outputs) {
            const half = output.metadata.half;
            pendingCleanedPixelUrls[half] = pngUrl(output.imageData);
        }
        if (nextResult.outputs.length === 0) {
            if (pendingFrameCanCommit()) publishCleanedFrame(nextFrame);
        }
    }

    function revealLatestFrame() {
        const latestResult = toRaw(toValue(result));
        if (
            !latestResult
            || latestResult === displayedCleanedFrame.value?.result
        ) {
            return Promise.resolve();
        }
        const transitionKey = presentationTransitionKey === undefined
            ? `run-reveal:${String(++unscopedFrameGeneration)}`
            : toValue(presentationTransitionKey);
        clearSettleTimer();
        clearPendingCleanedFrame();
        presentationPin = {
            firstFrameArrivalAtMs: performance.now(),
            settleConsumed: true,
            transitionKey,
        };
        const nextFrame = {
            kind: 'forced',
            presentation: captureFramePresentation(),
            result: latestResult,
            transitionKey,
        } satisfies IScanCleanupPendingCleanedFrame<TPresentation>;
        const revealed = new Promise<void>(resolve => displayedFrameWaiters.push({
            resolve,
            result: latestResult,
        }));
        pendingCleanedFrame = nextFrame;
        for (const output of latestResult.outputs) {
            pendingCleanedPixelUrls[output.metadata.half] = pngUrl(output.imageData);
        }
        if (latestResult.outputs.length === 0) publishCleanedFrame(nextFrame);
        return revealed;
    }

    watch(() => toValue(rawResult), (nextResult) => {
        if (!nextResult) {
            disposePreviewImageSwap(rawPixelSwap.value, revokeBlobUrl);
            rawPixelSwap.value = createPreviewImageSwap();
            return;
        }
        rawPixelSwap.value = queuePreviewImageSwap(rawPixelSwap.value, pngUrl(nextResult.rawImageData), revokeBlobUrl);
    }, {immediate: true});

    watch([
        () => toRaw(toValue(result)),
        () => presentationTransitionKey === undefined ? null : toValue(presentationTransitionKey),
    ], ([
        nextResult,
        scopedTransitionKey,
    ]) => {
        displayedCleanedFrameCurrent.value = nextResult !== null
            && displayedCleanedFrame.value?.result === nextResult;
        if (!nextResult) {
            clearPendingCleanedFrame();
            for (const half of Object.keys(cleanedPixelSwaps) as TScanCleanupOutputHalf[]) {
                const state = cleanedPixelSwaps[half];
                if (state) disposePreviewImageSwap(state, revokeBlobUrl);
                Reflect.deleteProperty(cleanedPixelSwaps, half);
            }
            displayedCleanedFrame.value = null;
            displayedCleanedFrameCurrent.value = false;
            presentationPin = null;
            clearSettleTimer();
            return;
        }
        queueCleanedFrame(
            nextResult,
            scopedTransitionKey ?? `unscoped:${String(++unscopedFrameGeneration)}`,
        );
    }, {immediate: true});

    watch(() => toValue(detailResult), (nextResult) => {
        const activeHalves = new Set<TScanCleanupOutputHalf>();
        for (const output of nextResult?.outputs ?? []) {
            const half = output.metadata.half;
            activeHalves.add(half);
            const previous = detailPixelUrls[half];
            if (previous) revokeBlobUrl(previous);
            detailPixelUrls[half] = pngUrl(output.imageData);
        }
        for (const half of Object.keys(detailPixelUrls) as TScanCleanupOutputHalf[]) {
            if (!activeHalves.has(half)) {
                const url = detailPixelUrls[half];
                if (url) revokeBlobUrl(url);
                Reflect.deleteProperty(detailPixelUrls, half);
            }
        }
    }, {immediate: true});

    onBeforeUnmount(revokeUrls);

    return {
        cleanedPixelSwaps,
        completeCleanedPixelSwap,
        completeRawPixelSwap,
        detailPixelUrls,
        displayedCleanedFrame,
        displayedCleanedFrameCurrent,
        loadCleanedPixelSwap,
        loadRawPixelSwap,
        pendingCleanedPixelUrls,
        rawPixelSwap,
        revealLatestFrame,
    };
};
